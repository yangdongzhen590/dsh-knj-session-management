# 0001. 宿主归档集合是可见性真相，插件只负责落盘

- 状态：已采纳（2026-10-30）
- 影响范围：`src/index.ts`、`src/routes.ts`、`src/archive-ops.ts`、`src/host-registry.ts`、`src/fs.ts`、`src/store.ts`、客户端面板

## 背景

v2026.9.151 及更早版本的归档只做了一件事：把 `sessions/<ws>/<id>/` 移到 `archive-sessions/<ws>/<id>/`，并在插件自己的 `archive.json` 里记一条记录。

这带来两个事实上的错误：

1. **侧栏根本不看文件位置。** 宿主侧栏的可见性唯一判据是 `ctx.workspaceRegistry.archivedSessionIds`（`dsh-client-ui-workspace` 的 `sessionVisible` 在 default 分支返回 `!archived.has(session.id)`）；宿主服务端 `listSessions` 也不做归档过滤，它是 `sessionPersistence.list()` 与 `ctx.sessions.list()` 的并集。所以插件把目录搬走之后，会话依然在左栏——用户看到的就是"归档没生效"。
2. **发现层认不出当前代际的日志文件名。** 宿主日志文件名带格式代际后缀（v0 为 `session.jsonl`，当前 `SESSION_FORMAT_VERSION = 4` 为 `session.v4.jsonl`，可为 `.zstd`）。插件硬编码了 `session.jsonl` / `session.jsonl.zstd`，于是一台机器上 99 个会话目录只识别出 4 个：归档请求先在发现层 404，前端 `doArchive` 又把非 running 错误重新抛出，`await load()` 与 `syncSidebar()` 都不会执行——一次都不曾真正搬移过。

## 决策

一份数据一个 owner：

- **可见性**（该会话是否出现在侧栏/列表）由宿主的 `workspaceRegistry.archivedSessionIds` 决定。插件不复制、不推测、不改写 `~/.dsh/storages/workspace.json`。
- **磁盘归属**（目录在 `sessions/` 还是 `archive-sessions/`）由插件决定，也只有插件会动它。

归档一个会话因此是一个**有序的两步提交**：

1. `registry.archiveSession(id, { stopActivity: true })`——先让宿主把它隐藏（并停掉相关活动）。
2. 成功后 `moveIntoArchive(row)`——再搬目录，记进 `archive.json`。

顺序不能反：`archiveSession` 内部会 `sessionKnown(id)` 校验，先搬目录会让宿主认为"这个会话不存在"而抛 `WorkspaceUnknownSessionError`。

### 搬不动的时候

目录仍在被写入（EBUSY/EPERM）、或会话仍驻留内存时，**不能让可见性回滚**（用户按了归档却什么都没发生），也不能强行搬（会撕裂正在写的日志）。于是引入 `pendingMove`：

- 记录写入 `archive.json`，带 `pendingMove: true` 与 `pendingReason: 'live' | 'move-failed' | 'conflict'`。
- 会话已从侧栏消失（宿主那一步已完成），面板里显示"待回收 / 冲突"徽标。
- `sweep()` 在插件启动时、以及面板上的「完成回收」按钮里重试搬移；成功后清掉 pending 标记。这就是"先隐藏、延后回收"。

### 恢复与删除对称

- 恢复：先搬回 `sessions/`，再 `registry.unarchiveSession(id)`，最后删记录；宿主已归档而插件没有记录的会话（历史遗留），只做 `unarchiveSession`。
- 删除：删归档目录 → 删记录 → `unarchiveSession`（让宿主状态不残留悬空 id）；`pendingMove` 的记录拒绝删除（文件还在，删了就是丢数据）。

## 结果

- 侧栏与面板对"已归档"的理解唯一，不再出现"面板说归档了、左栏还在"。
- 两个真相源之间必然存在一个短暂窗口（注册表已写、目录未搬）。`drift()` 把这个窗口显式化：`pending` / `conflict` / `missing` / `hostArchivedOnly` / `storeOnly`，`GET /list` 一并返回。
- 宿主的 `workspaceRegistry` 在插件加载时可能还不存在（加载顺序、旧宿主），因此它**不在 `inject` 列表里**，而是每次操作前 `resolveWorkspaceRegistry()` 惰性解析。解析不到时进入降级模式：只做文件归档，日志告警，面板照常可用——这是对旧宿主的兼容底线，不是正常路径。
- 发现层改为按 `^session(?:\.v(\d{1,3}))?\.jsonl(?:\.zstd)?$` 识别，版本最高者优先（同版本 `.zstd` 优先），因此 v0 与 v4、压缩与未压缩可以共存，未来换代不再需要改插件。

## 被否掉的备选

- **直接改写 `workspace.json`**：绕过宿主状态机与事件通知，宿主内存里的 `archivedSessionIds` 不会更新，侧栏仍然不消失，还会在下次落盘时被覆盖。
- **只搬文件、不发通知**：本次缺陷的原形。
- **让宿主负责搬目录**：宿主没有这个 API，且归档目录布局是本插件的私有约定。

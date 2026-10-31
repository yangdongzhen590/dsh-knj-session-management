# dsh-knj-session-management

DSH 会话管理插件：归档/恢复/删除持久化会话，按工作区控制会话数量上限，提供体积治理面板。解决会话只增不减导致的 `session_projcache.json` 膨胀与 web 界面卡顿。

## 为什么需要它

DSH 的会话只增不减：`session.list` 基于磁盘扫描、SQLite FTS 索引与 workspace header 索引都会随会话数线性变慢；更关键的是 `session_projcache.json`（JSON 存储后端，每次写入全量序列化+原子重写）会随会话数膨胀——本机 425 个会话时达到 270MB，任何 checkpoint 写都同步阻塞约 1.5 秒，表现为新建/切换会话卡顿。

DSH 宿主没有会话删除/归档 API，本插件补上这个能力，并且三处索引全部自动跟随（见设计文档）。

## 功能

- **归档**：先让宿主把会话标记为归档（侧栏当场消失），再把 `sessions/<ws>/<id>/` 移到 `archive-sessions/<ws>/<id>/`（可逆，不释放磁盘，projcache 记录清除）
- **恢复**：把归档会话移回原位置并解除宿主的归档标记（投影缓存冷读自动重建）
- **永久删除**：彻底移除归档目录并清掉宿主的归档标记（不可逆，释放磁盘，需二次确认）
- **延迟回收（pendingMove）**：会话仍在内存里或目录被占用时，先隐藏、文件稍后回收；启动时自动 sweep，面板也可手动「完成回收」
- **补落盘**：宿主早已归档、但文件还留在 `sessions/` 树里的会话会带「仅隐藏」徽标，一键补齐磁盘搬移
- **自动策略**：每工作区保留最近 N 个会话，超限自动归档最旧的非运行会话
- **未分组/失效工作区**：`_no-cwd` 会话与工作区路径已删除的会话都会被显式列出并支持管理
- **体积面板**：显示 projcache 体积、各工作区会话数、已归档与待回收统计
- **蒸馏衔接**：归档/删除前可一键复制 `wiki-distill` 蒸馏指令，先把会话沉淀进知识库再清理，知识不丢（蒸馏本身由既有 wiki-distill skill 完成，本插件只做编排）
- **跨卷支持**：归档区配置到其他盘符时自动回退 copy+rm（Windows EXDEV 防护）
- **侧栏即时同步**：归档/恢复/删除/自动策略执行后，客户端立即让宿主重拉会话列表基线（`sessions.refresh()` / `workspaces.refresh()`，见 `src/client-sync.ts`），左边栏当场消失/重现，无需重启 dsh web

### 归档语义（v2026.9.152 起）

会话"是否出现在侧栏"由宿主的归档集合（`workspaceRegistry.archivedSessionIds`）决定，**不是**由目录位置决定；插件只负责磁盘搬移。两者是同一入口的有序两步提交：先归档（可见性），后搬目录（磁盘）；搬不动就记为待回收，重启或点「完成回收」再搬。细节见 [ADR 0001](docs/adr/0001-host-authoritative-archive.md)。

同时发现层按代际文件名识别日志（`session.jsonl` / `session.v4.jsonl` / `.zstd`，版本最高优先），v0 与当前代际的会话目录都能被列出与归档。

## 安装

```bash
# 一条命令同时安装插件与菜单宿主 dsh-knj-menu（已声明为 npm 依赖，版本自动配套）
dsh plugin --profile web add dsh-knj-session-management dsh-knj-menu
```

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: dsh-knj-session-management
      name: 'dsh-knj-session-management'
      config:
        maxSessionsPerWorkspace: 60   # 每工作区保留上限，0 关闭自动归档
        enabled: true                 # 自动归档总开关
        maxPerRun: 50                 # 单次策略最多归档数
        # archiveRoot: ''             # 归档区，默认 $DSH_HOME/archive-sessions
```

插件自身的数据（`archive.json`，含待回收记录）在 `$DSH_HOME/profiles/<profile>/dsh-session-archive/`（历史目录，保持兼容不改名）。

## HTTP 端点

前缀 `/dsh-knj-session-management`，全部为同源校验：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/list` | 会话/工作区/归档记录 + `hostArchived` + `drift` + `stats` |
| POST | `/archive` | 归档单个会话（含子会话树）：先宿主后磁盘 |
| POST | `/restore` | 恢复（含子会话树） |
| POST | `/delete` | 永久删除，需 `confirm: true` |
| POST | `/run-policy` | 按策略归档溢出会话 |
| POST | `/sweep` | 重试所有待回收的目录搬移 |

## 开发

```bash
npm install
npm run check        # typecheck + build
npm test             # node:test 全套（lib 产物用例 + src 直测用例）
npm pack             # 打 tgz
```

## 设计文档

- 归档语义决策：[docs/adr/0001-host-authoritative-archive.md](docs/adr/0001-host-authoritative-archive.md)
- 行为契约：`openspec/changes/add-session-archive-management/specs/session-archive/spec.md`
- 技术决策：`openspec/changes/add-session-archive-management/design.md`
- 交互设计：`openspec/changes/add-session-archive-management/interactions.md`

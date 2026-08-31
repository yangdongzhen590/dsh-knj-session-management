# dsh-knj-session-management

DSH 会话管理插件：归档/恢复/删除持久化会话，按工作区控制会话数量上限，提供体积治理面板。解决会话只增不减导致的 `session_projcache.json` 膨胀与 web 界面卡顿。

## 为什么需要它

DSH 的会话只增不减：`session.list` 基于磁盘扫描、SQLite FTS 索引与 workspace header 索引都会随会话数线性变慢；更关键的是 `session_projcache.json`（JSON 存储后端，每次写入全量序列化+原子重写）会随会话数膨胀——本机 425 个会话时达到 270MB，任何 checkpoint 写都同步阻塞约 1.5 秒，表现为新建/切换会话卡顿。

DSH 宿主没有会话删除/归档 API，本插件补上这个能力，并且三处索引全部自动跟随（见设计文档）。

## 功能

- **归档**：把 `sessions/<ws>/<id>/` 移到 `archive-sessions/<ws>/<id>/`（可逆，不释放磁盘，会话从列表消失，projcache 记录清除）
- **恢复**：把归档会话移回原位置（投影缓存冷读自动重建）
- **永久删除**：彻底移除归档目录（不可逆，释放磁盘，需二次确认）
- **自动策略**：每工作区保留最近 N 个会话，超限自动归档最旧的非运行会话
- **未分组/失效工作区**：`_no-cwd` 会话与工作区路径已删除的会话都会被显式列出并支持管理
- **体积面板**：显示 projcache 体积、各工作区会话数与归档统计
- **蒸馏衔接**：归档/删除前可一键复制 `wiki-distill` 蒸馏指令，先把会话沉淀进知识库再清理，知识不丢（蒸馏本身由既有 wiki-distill skill 完成，本插件只做编排）
- **跨卷支持**：归档区配置到其他盘符时自动回退 copy+rm（Windows EXDEV 防护）

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
        # archiveRoot: ''             # 归档区，默认 $DSH_HOME/profiles/<profile>/dsh-session-archive（历史目录，改名后保持兼容）
```

## 开发

```bash
npm install
npm run check        # typecheck + build
npm pack             # 打 tgz
```

## 设计文档

- 行为契约：`openspec/changes/add-session-archive-management/specs/session-archive/spec.md`
- 技术决策：`openspec/changes/add-session-archive-management/design.md`
- 交互设计：`openspec/changes/add-session-archive-management/interactions.md`

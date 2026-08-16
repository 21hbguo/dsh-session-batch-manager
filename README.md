# dsh-session-batch-manager

DeepSeek Harness (DSH) Web GUI 插件：在侧边栏与设置页提供「批量选择会话」面板，批量归档、批量恢复（unarchive）、批量删除会话。

## ✨ 功能特性

- 🗂️ **双入口共享面板**：侧边栏底部「☑ 批量选择」按钮（主入口）+ 设置页「会话管理」区块（补充入口），打开同一覆盖面板
- 📊 **全量会话列表**：列出本机全部会话（含已归档与冷会话），标题栏实时统计 `共 N · 归档 M · 运行中 K`
- 🔍 **视图切换 + 搜索**：全部 / 未归档 / 已归档 / 运行中 互斥分段按钮（默认「未归档」）；按标题 / cwd 子串过滤（大小写不敏感），与视图叠加
- ☑️ **多选与全选**：checkbox 逐行勾选 + 全选（勾选态按当前可见行计算，切换视图保留选中集）
- 📦 **批量归档**：只作用于「选中 ∩ 未归档」，逐条调用官方归档 RPC，幂等，可恢复
- ♻️ **批量恢复**：只作用于「选中 ∩ 已归档」，调用插件自实现端点移出归档集合，幂等、非破坏性、无确认弹窗
- 🗑️ **批量删除**：二次确认后物理删除会话日志文件（**不可恢复**）；运行中 / subagent 会话自动跳过并汇总原因
- 🧩 **零 UI 框架**：面板为原生 DOM 渲染，仅触发器为 React 组件（slot 系统要求），运行时唯一外部依赖 `react`

## 📐 架构

```
┌─────────────── DSH Web GUI（浏览器） ───────────────┐
│  侧边栏 footer action ─┐                            │
│  设置页「会话管理」区块 ─┼─► 批量选择覆盖面板           │
│                          │   · 列表/视图/搜索/多选    │
│                          │   · 归档 / 恢复 / 删除     │
│  归档: api.workspace.archiveSession（官方 RPC）      │
│  删除/恢复: rpc.call('/session-batch', ...)          │
└─────────────────────────┬───────────────────────────┘
                          │ connection 通用 RPC 通道（loopback）
┌─────────────────────────▼───────────────────────────┐
│  host（src/index.ts）                                │
│  POST /session-batch/delete                          │
│    · 运行中会话 → skipped/running                    │
│    · subagent 会话 → skipped/subagent                │
│    · sessionPersistence.locate → fs.unlink（幂等）   │
│  POST /session-batch/unarchive                       │
│    · workspace registry 私有写路径（与官方            │
│      archiveSession 同一持久化通道，幂等）            │
└─────────────────────────────────────────────────────┘
```

- **host**（`src/index.ts`）：注册 connection 通用 RPC 通道 `/session-batch`（端点 `delete`、`unarchive`，`authority: loopback`）。官方无删除会话 API，删除由本插件自实现；恢复（unarchive）同样无官方 RPC，通过 workspace registry 的私有写路径（`enqueueOperation` / `requireState` / `setState`）与官方 `archiveSession` 走同一持久化通道。
- **client**（`src/client/index.ts`）：注册 `sidebar.footer.action`（主入口）与 `settings.section`（补充入口），渲染覆盖面板。wire 类型从 `@deepseek-ai/dsh-client-connection/client` type-only 导入（`@deepseek-ai/dsh-api-remotes/client` 的 d.ts 在本插件编译上下文跨包解析失败，类型会退化为 `any`）。

### RPC 端点线格式

```
POST /session-batch/delete   （connection 通用 RPC 通道，authority: loopback）
payload:  { "sessionIds": string[] }
result:   { "ok": true,  "value": { results, deleted, skipped } }
        | { "ok": false, "error": { code, message, details } }
results[i]: { sessionId, status: 'deleted' | 'skipped',
              reason?: 'running' | 'subagent' | 'not-found' | 'no-location' | 'file-error',
              message?: string }
```

```
POST /session-batch/unarchive  （connection 通用 RPC 通道，authority: loopback）
payload:  { "sessionIds": string[] }
result:   { "ok": true,  "value": { results, restored, skipped } }
        | { "ok": false, "error": { code, message, details } }
results[i]: { sessionId, status: 'restored' | 'skipped',
              reason?: 'not-archived', message?: string }
```

## 🚀 快速开始

### 前提

- 一个可运行的 **DeepSeek Harness (DSH)** 环境（插件运行在 DSH 进程内，依赖其 `sessions` / `agents` / `connection` / slot 等服务）
- 本机有 **DSH 源码 checkout**（编译期类型依赖来自 checkout 的 vendor 包与 `packages/*`，npm 上不公开，因此必须用 checkout 构建）
- bash / node / npm

### 安装

**方式一：注入器环境（推荐，免重启）**

```bash
# 1. 构建（DSH_CHECKOUT 指向含 packages/ 的 DSH 源码目录）
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh

# 2. 在 DSH 注入器环境内注入
dev_inject_plugin /path/to/dsh-session-batch-manager
```

**方式二：手动装配（无注入器工具时）**

1. 构建：`DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh`（产物在 `lib/`）
2. 把本目录作为 `link:` 依赖加入目标 profile 的 `package.json`，并加入 `bundles` 数组
3. 在目标 profile 的 `node_modules` 下为包名建立 junction/symlink，指向本目录
4. 重启 DSH

### 验证

1. 打开 DSH Web GUI
2. 侧边栏底部（设置入口上方）出现「☑ 批量选择」图标按钮；设置页出现「会话管理」区块
3. 点击任一入口打开批量选择面板：显示全部会话（标题 / 状态 / cwd），标题栏有统计
4. 勾选若干会话 → 点击 `归档 (N)`：会话移入「已归档」视图；点击 `恢复 (N)`：回到未归档；点击 `删除 (N)`（需二次确认）：物理删除日志文件

### 排错表

| 现象 | 原因 | 解决 |
|---|---|---|
| 构建报 `cannot locate the dsh checkout` | 探测路径均无 `packages/` 目录 | 显式设置 `DSH_CHECKOUT` 指向 DSH 源码 checkout（须含 `packages/` 与 `node_modules/.bin/tsc`） |
| 构建报 tsc 找不到 `@deepseek-ai/*` 模块 | checkout 版本过旧或目录不完整 | 确认 checkout 是完整 DSH 源码仓库（含 `vendor/` 与 `packages/*`），重跑 build.sh |
| 侧边栏 / 设置页无入口 | client 半区未注入，或运行在非 web 平台 | 确认注入成功（注入器清单可见本插件），确认 profile 的 client 平台为 `web` |
| 删除返回 `internal` 错误 | connection 服务缺席（host 日志有 `connection service unavailable`）或 RPC 通道未注册 | 确认 host 半区已注入；重启后重试 |
| `unarchive` 返回 `internal` | DSH 升级后 workspace registry 内部结构变更，私有写路径不可用 | 升级本插件到适配新版 DSH 的版本；归档集合不受影响 |
| 删除后列表仍显示该会话 | workspace 记账无官方移除 API，id 成为「幽灵 id」 | 属已知限制：重启 host 后不再出现 |

## ⚙️ 配置项

插件无运行时 Config 配置。

| 项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| 环境变量 `DSH_CHECKOUT` | string | 自动探测 `$HOME/dsh-harness`、`$HOME/dsh`、`$HOME/.dsh/dsh-harness` | 构建期：DSH 源码 checkout 路径（须含 `packages/`） |
| RPC 通道 | `/session-batch` | — | connection 通用 RPC 通道，端点 `delete` / `unarchive`，`authority: loopback` |
| 侧边栏入口 | `sidebar.footer.action` | order 10 | 主入口，仅图标按钮 |
| 设置页入口 | `settings.section` | order 50，label「会话管理」 | 补充入口 |

## 🔐 安全说明

- **删除不可恢复**：批量删除物理移除会话 JSONL 日志文件（`fs.unlink`），面板有二次确认（`window.confirm`）
- **运行中 / subagent 会话保护**：批量删除自动跳过这两类会话，面板汇总展示跳过原因
- **RPC 通道仅限回环**：`/session-batch` 通道以 `authority: loopback` 注册，不接受外部来源调用
- **无凭据处理**：插件不读取、不存储任何 API key / token
- **无遥测**：插件不发起任何外部网络请求，不上报使用数据

## ❓ 常见问题

**归档后的会话怎么恢复？**
面板切到「已归档」视图，勾选会话后点「恢复 (N)」——只移出归档集合，不触碰文件，非破坏性。

**删除的会话还能找回吗？**
不能。删除是物理移除日志文件（幂等：文件已不存在也按已删除计）。建议删除前先归档。

**为什么某些会话删除时被跳过？**
运行中会话（避免破坏活跃状态）与 subagent 会话（子代理会话）被保护性跳过，面板会展示每个原因的跳过数量。

**为什么删除后列表里还有这个会话？**
workspace 记账（`workspace.sessionIds` / `archivedSessionIds`）无官方移除 API，删除后 id 保留为「幽灵 id」；重启 host 后列表不再出现。归档集合中的幽灵 id 可直接用「恢复」清除（不校验会话存在性）。

**删除会清理目录和记账吗？**
不会。仅物理删除 JSONL 日志文件本身；会话所在目录与 workspace 记账保留（见「已知限制」）。attached 空闲会话删除文件后，若后续事件 flush 可能重建文件，建议只对已归档 / 冷会话执行删除。

**没有持久化后端时能删吗？**
不能定位日志文件时会标记 `skipped/not-found` 或 `skipped/no-location`，不执行删除。

## 📄 License

[BSD-3-Clause](./LICENSE) © 2026 21hbguo

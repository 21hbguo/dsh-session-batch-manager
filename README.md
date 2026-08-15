# @dsh-external/dsh-session-batch-manager

批量选择会话进行归档或删除的管理面板（DSH Web GUI 侧边栏入口 + 覆盖面板）。

## 功能

侧边栏底部（`sidebar.footer.action` 槽，设置入口上方）新增「批量选择」按钮（窄栏为图标），
点击打开**批量选择覆盖面板**：

- **会话列表**：列出本机全部会话（官方 `POST /api/session.list` + `POST /api/workspace.list`
  按 `archivedSessionIds` join），每行显示 标题（projection `title`）/ 状态（运行中 · 归档 ·
  空闲）/ cwd，subagent 会话额外标注；含已归档会话与冷会话。
- **多选**：checkbox 逐行勾选 + 全选。
- **批量归档**：逐条调用官方 RPC `api.workspace.archiveSession({ sessionId })`（幂等）。
  ⚠️ 官方无取消归档（unarchive）接口，归档**不可逆**。
- **批量删除**：二次确认（`window.confirm`）后调用 host 自实现端点
  `connection.rpc.call('/session-batch', 'delete', { sessionIds })`；
  删除物理移除会话日志文件，**不可恢复**。
- 操作完成后自动重新拉取列表；标题栏 × / 遮罩点击关闭。

## 架构

- **host**（`src/index.ts`）：注册 connection 通用 RPC 通道 `/session-batch`（端点 `delete`）。
  官方无删除会话 API，本插件自实现：
  - 运行中会话拒绝：`ctx.agents.get(id)?.status === 'running'` → `skipped/running`
  - subagent 会话拒绝：读会话 header 的 `origin === 'subagent'` → `skipped/subagent`
  - 其余会话：`ctx.sessionPersistence.locate(meta)` 定位 JSONL 日志（含压缩后缀物理路径）
    → `fs.unlink(path)`；文件已不存在按已删除计（幂等）
  - `workspace.sessionIds` 记账无官方移除 API，删除后保留幽灵 id（见「已知限制」）
- **client**（`src/client/index.ts`）：`sidebar.footer.action` 触发器 + 原生 DOM 覆盖面板
  （无 UI 框架）；wire 类型从 `@deepseek-ai/dsh-client-connection/client` type-only 导入。
  注意：`@deepseek-ai/dsh-api-remotes/client` 的 d.ts 在本插件编译上下文里跨包跳转
  解析失败（该包自身 node_modules 未声明 `dsh-client-connection`），类型会退化为 `any`，
  因此直接使用其类型出口的底层包。

### 删除端点线格式

```
POST /session-batch/delete   （connection 通用 RPC 通道，authority: loopback）
payload:  { "sessionIds": string[] }
result:   { "ok": true,  "value": { results, deleted, skipped } }
        | { "ok": false, "error": { code, message, details } }
results[i]: { sessionId, status: 'deleted' | 'skipped',
              reason?: 'running' | 'subagent' | 'not-found' | 'no-location' | 'file-error',
              message?: string }
```

## 构建与注入

```bash
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh
# typecheck：tsc -p tsconfig.json --noEmit（构建脚本内已执行等价检查）
# 注入器环境内：dev_inject_plugin <本目录>
```

`scripts/build.sh` 会把编译期所需的 dsh 类型依赖从 checkout 链接进 `node_modules`
（client 侧包 + `@deepseek-ai/cordis` + `react`/`@types/react`），随后 `tsc` 编译 host 与
client 源码，`tsdown` 打出 `lib/client.js`（唯一外部运行时依赖 `react`）。

## 已知限制

- **归档不可逆**：官方 `workspace.archiveSession` 无 unarchive 接口，UI 已注明。
- **删除不可恢复**：批量删除物理移除 JSONL 日志文件；会话所在目录与 workspace 记账不清理。
- **幽灵 id**：删除后 `workspace.sessionIds` 仍保留该会话 id（官方无移除 API），
  归档集合 `archivedSessionIds` 亦然；重启 host 后列表不再出现（文件已无）。
- **运行中 / subagent 会话拒删**：批量删除自动跳过，面板汇总展示跳过原因。
- **attached 空闲会话为 best-effort**：删除其日志文件后，内存中的会话仍在，
  若后续有事件 flush 可能重建文件；建议只对已归档/冷会话执行删除。
- **无持久化后端 / 无日志定位**（`locate` 返回 undefined）：标记 `skipped/not-found` 或
  `no-location`，不删。
- **client 类型来源**：`@deepseek-ai/dsh-api-remotes/client` 在本插件编译上下文不可用
  （跨包 d.ts 解析失败），改用 `@deepseek-ai/dsh-client-connection/client`（见上）。

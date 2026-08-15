/**
 * @dsh-external/dsh-session-batch-manager — host 半区。
 *
 * 提供批量删除会话的 RPC 端点（connection 通用 RPC 通道，见
 * packages/client/connection/src/rpc-host.ts / rpc.ts 的 HostConnectionRpc）：
 * client 侧 `ctx.connection.rpc.call('/session-batch', 'delete', { sessionIds })`。
 *
 * 删除语义（官方无删除 API，本端点自实现）：
 * - 运行中会话（ctx.agents.get(id)?.status === 'running'）拒绝 → skipped/running
 * - subagent 会话（header.origin === 'subagent'）拒绝 → skipped/subagent
 * - 其余会话通过 ctx.sessionPersistence.locate(meta) 定位 JSONL 日志文件后
 *   fs.unlink 物理删除（幂等：文件已不存在按已删除计）
 * - workspace.sessionIds 记账无官方移除 API，删除后保留幽灵 id（见 README）
 *
 * 归档走官方 RPC（api.workspace.archiveSession），本插件不实现 host 端点。
 * @module @dsh-external/dsh-session-batch-manager
 */

import type { Context } from 'cordis'
import { unlink } from 'node:fs/promises'

/** Stable cordis plugin name（与注入器注册的包名一致）。 */
export const name = '@dsh-external/dsh-session-batch-manager'

/** Services required before mounting（核心服务，任何 DSH 运行期都有）。 */
export const inject = ['sessions', 'agents']

/** RPC 通道（绝对前缀，符合 connection 通道命名规范）。 */
export const CHANNEL = '/session-batch'

/** 通道内端点。 */
export const DELETE_ENDPOINT = 'delete'

/** 单条会话删除结果。 */
export interface DeleteSessionResult {
  sessionId: string
  status: 'deleted' | 'skipped'
  reason?: 'running' | 'subagent' | 'not-found' | 'no-location' | 'file-error'
  message?: string
}

/** 批量删除端点响应。 */
export interface DeleteSessionsResponse {
  results: DeleteSessionResult[]
  deleted: number
  skipped: number
}

/** RpcResult 的最小结构面（与 @deepseek-ai/dsh-host-apiproxy/api 的 RpcResult 同形）。 */
export type RpcResultLike<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: unknown } }

/** SessionHeader 最小结构面（@deepseek-ai/dsh-session 的 SessionHeader）。 */
interface SessionHeaderLike {
  id: string
  origin?: 'subagent'
}

/** 挂载中的 Session（ctx.sessions）。 */
interface SessionLike {
  id: string
  header: SessionHeaderLike
}

/** ctx.sessions 服务面。 */
interface SessionStoreLike {
  get(id: string): SessionLike | undefined
  list(): SessionLike[]
}

/** ctx.agents 服务面。 */
interface AgentRegistryLike {
  get(id: string): { status: 'idle' | 'running' } | undefined
}

/** ctx.sessionPersistence 服务面（可选服务，ctx.get）。 */
interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<SessionHeaderLike[]>
  locate(meta: SessionHeaderLike): { kind: string; path: string } | undefined
}

/** HostConnectionService 的 rpc.handle 面（packages/client/connection/src/rpc.ts）。 */
interface HostConnectionRpcLike {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResultLike<unknown>>,
    options: { authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

declare module 'cordis' {
  interface Context {
    sessions: SessionStoreLike
    agents: AgentRegistryLike
  }
}

/** 校验删除负载，返回 sessionId 数组。非法负载抛错（由端点转 internal）。 */
function parseDeletePayload(payload: unknown): string[] {
  if (payload === null || typeof payload !== 'object') {
    throw new Error('session-batch: payload must be an object')
  }
  const sessionIds = (payload as { sessionIds?: unknown }).sessionIds
  if (!Array.isArray(sessionIds) || sessionIds.some((id) => typeof id !== 'string')) {
    throw new Error('session-batch: payload.sessionIds must be an array of strings')
  }
  return sessionIds as string[]
}

/** 判断 unlink 失败是否为"文件不存在"（幂等删除）。 */
function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * 逐条删除会话日志文件，汇总结果。
 * @param ctx - host 插件上下文。
 * @param payload - 原始 RPC 负载（{ sessionIds }）。
 * @param signal - 调用方取消信号；中断时返回已处理部分的结果。
 * @returns 汇总响应。
 */
async function deleteSessions(ctx: Context, payload: unknown, signal: AbortSignal): Promise<DeleteSessionsResponse> {
  const sessionIds = parseDeletePayload(payload)
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined

  // 构建 id → header 索引：挂载中的会话 + 持久化冷会话（与 session.list 同源）。
  const headers = new Map<string, SessionHeaderLike>()
  for (const session of ctx.sessions.list()) {
    headers.set(session.id, session.header)
  }
  if (persistence !== undefined) {
    for (const meta of await persistence.list(signal)) {
      if (!headers.has(meta.id)) headers.set(meta.id, meta)
    }
  }

  const results: DeleteSessionResult[] = []
  for (const id of sessionIds) {
    if (signal.aborted) break
    // 1) 运行中会话拒绝（同 api-proxy summarizeAttached 的 running 判定）。
    if (ctx.agents.get(id)?.status === 'running') {
      results.push({ sessionId: id, status: 'skipped', reason: 'running' })
      continue
    }
    // 2) subagent 会话拒绝（读会话 header 的 origin）。
    const header = headers.get(id)
    if (header?.origin === 'subagent') {
      results.push({ sessionId: id, status: 'skipped', reason: 'subagent' })
      continue
    }
    // 3) 定位并物理删除 JSONL 日志文件。
    if (persistence === undefined || header === undefined) {
      results.push({ sessionId: id, status: 'skipped', reason: 'not-found' })
      continue
    }
    const location = persistence.locate(header)
    if (location === undefined) {
      results.push({ sessionId: id, status: 'skipped', reason: 'no-location' })
      continue
    }
    try {
      await unlink(location.path)
      results.push({ sessionId: id, status: 'deleted' })
    } catch (error) {
      if (isFileNotFound(error)) {
        // 文件已不存在 = 目标已达到（幂等）。
        results.push({ sessionId: id, status: 'deleted', message: 'no artifact' })
      } else {
        results.push({ sessionId: id, status: 'skipped', reason: 'file-error', message: String(error) })
      }
    }
  }

  let deleted = 0
  let skipped = 0
  for (const result of results) {
    if (result.status === 'deleted') deleted += 1
    else skipped += 1
  }
  return { results, deleted, skipped }
}

/**
 * 注册批量删除 RPC 通道；connection 服务缺席时跳过（插件仍可加载）。
 * @param ctx - host 插件上下文。
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as { rpc: HostConnectionRpcLike } | undefined
  if (connection === undefined) {
    ctx.logger.warn('[dsh-session-batch-manager] connection service unavailable; batch-delete endpoint disabled')
    return
  }
  ctx.effect(() => connection.rpc.handle(
    CHANNEL,
    async (endpoint, payload, signal) => {
      if (endpoint !== DELETE_ENDPOINT) {
        return {
          ok: false,
          error: { code: 'bad-request', message: `session-batch: unknown endpoint ${endpoint}`, details: {} },
        }
      }
      try {
        const value = await deleteSessions(ctx, payload, signal)
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        }
      }
    },
    { authority: 'loopback' },
  ), '@dsh-external/dsh-session-batch-manager: delete rpc channel')
}

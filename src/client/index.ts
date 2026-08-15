/**
 * @dsh-external/dsh-session-batch-manager — 浏览器半区：侧边栏「批量选择」入口 + 覆盖面板。
 *
 * 挂载点：`sidebar.footer.action`（ui-sidebar shell 声明的 list 槽，位于侧边栏底部、
 * 设置入口上方，宽/窄两种状态都渲染）——工作区会话列表区域没有可加的头部槽位，
 * 该 footer action 是最贴近侧边栏的加性挂载点。
 *
 * 交互：点击「批量选择」→ 打开覆盖面板（全屏遮罩 + 居中卡片）：
 * - 会话列表：全量会话（官方 `POST /api/session.list` + `POST /api/workspace.list`
 *   按 archivedSessionIds join），每行 标题(projection title)/状态(运行中·归档·空闲)/cwd，
 *   带 checkbox 多选 + 全选
 * - 批量归档：逐条官方 RPC `api.workspace.archiveSession`（幂等）；不可逆（官方无 unarchive）
 * - 批量删除：二次确认（window.confirm）后调 host 自实现端点
 *   `connection.rpc.call('/session-batch', 'delete', { sessionIds })`
 *   （运行中/subagent 会话由 host 拒绝并跳过）；删除物理移除日志文件，不可恢复
 * - 操作后自动重新拉取列表；标题栏 × 或遮罩点击关闭
 *
 * 全部渲染为原生 DOM（无 UI 框架），组件本身是 React FC（slot 系统要求），
 * 仅负责渲染触发器按钮并挂载/卸载面板 DOM 子树。
 * wire 类型从 @deepseek-ai/dsh-client-connection/client type-only 导入
 * （@deepseek-ai/dsh-api-remotes/client 的 d.ts 在本插件编译上下文里跨包跳转
 * 解析失败，类型会退化为 any，见 README）。
 * @module @dsh-external/dsh-session-batch-manager/client
 */

import { createElement, useEffect, useRef, type ReactNode } from 'react'
import type {
  ConnectionHandle, RpcResult, SessionId, SessionSummary,
} from '@deepseek-ai/dsh-client-connection/client'
import type { Context } from 'cordis'

/** 与 host 端一致的删除端点契约。 */
const CHANNEL = '/session-batch'
const DELETE_ENDPOINT = 'delete'

/** ctx.slots 的最小结构面（运行时为 SlotRegistry，动态插件上下文按此签名调用）。 */
interface SlotsServiceLike {
  inject(name: string, factory: () => unknown): void
  register(
    options: { name: string; id?: string; order?: number; label?: string | (() => string) },
    component: unknown,
  ): () => void
}

declare module 'cordis' {
  interface Context {
    slots: SlotsServiceLike
  }
}

/** 单条删除结果（与 host DeleteSessionResult 同形）。 */
interface DeleteSessionResult {
  sessionId: string
  status: 'deleted' | 'skipped'
  reason?: string
  message?: string
}

/** 批量删除响应（与 host DeleteSessionsResponse 同形）。 */
interface DeleteSessionsResponse {
  results: DeleteSessionResult[]
  deleted: number
  skipped: number
}

/** 列表行：官方 SessionSummary + 归档标记。 */
interface SessionRow {
  summary: SessionSummary
  archived: boolean
}

/** 面板样式，注入一次。 */
const PANEL_CSS = `
.sbm-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center;
}
.sbm-card {
  width: min(640px, calc(100vw - 48px));
  max-height: 82vh;
  display: flex; flex-direction: column;
  background: #1b1b20; color: #e8e8e8;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  font: 13px/1.6 system-ui, sans-serif;
}
.sbm-card-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex: none;
}
.sbm-card-close {
  font: inherit; background: none; border: none; color: #9ba1a6;
  cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.sbm-card-close:hover { color: #ff8a8d; background: rgba(255,255,255,0.08); }
.sbm-body { padding: 12px 14px; overflow: auto; }
.sbm-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.sbm-btn {
  font: inherit; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,0.06); color: #e8e8e8; border: 1px solid rgba(255,255,255,0.16);
}
.sbm-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
.sbm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sbm-btn-danger:hover:not(:disabled) { border-color: #e5484d; color: #ff8a8d; }
.sbm-status { color: #9ba1a6; font-size: 12px; flex: 1; text-align: right; }
.sbm-select-line { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sbm-list {
  border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
  max-height: 46vh; overflow: auto; background: rgba(255,255,255,0.02);
}
.sbm-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); }
.sbm-row:last-child { border-bottom: none; }
.sbm-row:hover { background: rgba(255,255,255,0.04); }
.sbm-row input[type="checkbox"] { flex: none; accent-color: #4f8cff; }
.sbm-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbm-badge {
  flex: none; font-size: 11px; padding: 1px 7px; border-radius: 10px; white-space: nowrap;
}
.sbm-badge-running { background: rgba(76,175,80,0.18); color: #7bd88a; border: 1px solid rgba(76,175,80,0.4); }
.sbm-badge-archived { background: rgba(160,160,160,0.15); color: #b0b0b0; border: 1px solid rgba(160,160,160,0.35); }
.sbm-badge-idle { background: rgba(79,140,255,0.15); color: #8ab6ff; border: 1px solid rgba(79,140,255,0.35); }
.sbm-badge-subagent { background: rgba(245,165,36,0.15); color: #f5c26b; border: 1px solid rgba(245,165,36,0.35); }
.sbm-cwd { flex: none; max-width: 220px; font-size: 11px; color: #8a8f98; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbm-hint { margin-top: 10px; font-size: 12px; color: #7c828c; line-height: 1.7; }
.sbm-empty { padding: 18px; color: #9ba1a6; text-align: center; }
.sbm-trigger {
  font: inherit; display: flex; align-items: center; gap: 6px;
  background: none; border: none; color: #e8e8e8;
  cursor: pointer; padding: 6px 10px; border-radius: 8px; white-space: nowrap;
}
.sbm-trigger:hover { background: rgba(255,255,255,0.08); }
.sbm-trigger-rail { justify-content: center; padding: 6px; font-size: 15px; }
`

/** 注入面板样式（幂等）。 */
function ensureStyles(): void {
  if (document.getElementById('dsh-session-batch-manager-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-session-batch-manager-style'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/** 行标题：优先 projection 缓存里的 title，缺省退回会话 id 前缀。 */
function titleOf(summary: SessionSummary): string {
  const values = summary.projections?.values as { title?: string | null } | undefined
  const title = values?.title
  if (title !== undefined && title !== null && title !== '') return title
  return `会话 ${summary.sessionId.slice(0, 8)}`
}

/** 将 RpcResult 折叠成 value，失败抛错（错误信息即 result.error.message）。 */
function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** 跳过原因的中文标签。 */
function reasonLabel(reason: string): string {
  switch (reason) {
    case 'running': return '运行中'
    case 'subagent': return 'subagent'
    case 'not-found': return '未找到'
    case 'no-location': return '无日志文件'
    case 'file-error': return '文件错误'
    default: return reason
  }
}

/**
 * 批量选择覆盖面板：持有 DOM 子树与全部面板状态。
 * 数据逻辑与之前 settings.section 版本完全一致（枚举/归档/删除复用）。
 */
class SessionBatchPanel {
  private readonly connection: ConnectionHandle
  private readonly onClose: () => void
  /** 遮罩根节点（挂在 document.body，dispose 时移除）。 */
  readonly overlay: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly statusEl: HTMLSpanElement
  private readonly archiveBtn: HTMLButtonElement
  private readonly deleteBtn: HTMLButtonElement
  private readonly selectAllEl: HTMLInputElement
  private readonly countEl: HTMLSpanElement

  private rows: SessionRow[] = []
  private readonly selected = new Set<SessionId>()
  private busy = false

  constructor(connection: ConnectionHandle, onClose: () => void) {
    this.connection = connection
    this.onClose = onClose

    // 遮罩 + 卡片：标题栏（标题 + 关闭） + 正文（工具条/全选/列表/提示）
    this.overlay = document.createElement('div')
    this.overlay.className = 'sbm-overlay'

    const card = document.createElement('div')
    card.className = 'sbm-card'

    const titleBar = document.createElement('div')
    titleBar.className = 'sbm-card-title'
    const titleText = document.createElement('span')
    titleText.textContent = '批量选择会话'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sbm-card-close'
    closeBtn.textContent = '✕'
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', () => this.dispose())
    titleBar.append(titleText, closeBtn)

    const body = document.createElement('div')
    body.className = 'sbm-body'

    // 工具条：批量归档 / 批量删除 / 刷新 / 状态
    const toolbar = document.createElement('div')
    toolbar.className = 'sbm-toolbar'

    this.archiveBtn = document.createElement('button')
    this.archiveBtn.type = 'button'
    this.archiveBtn.className = 'sbm-btn'
    this.archiveBtn.textContent = '批量归档'
    this.archiveBtn.title = '归档选中的会话（不可逆：官方无 unarchive）'
    this.archiveBtn.addEventListener('click', () => void this.archiveSelected())

    this.deleteBtn = document.createElement('button')
    this.deleteBtn.type = 'button'
    this.deleteBtn.className = 'sbm-btn sbm-btn-danger'
    this.deleteBtn.textContent = '批量删除'
    this.deleteBtn.title = '物理删除选中的会话日志文件（不可恢复）'
    this.deleteBtn.addEventListener('click', () => void this.deleteSelected())

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'sbm-btn'
    refreshBtn.textContent = '刷新'
    refreshBtn.addEventListener('click', () => void this.refresh())

    this.statusEl = document.createElement('span')
    this.statusEl.className = 'sbm-status'

    toolbar.append(this.archiveBtn, this.deleteBtn, refreshBtn, this.statusEl)

    // 全选行
    const selectLine = document.createElement('label')
    selectLine.className = 'sbm-select-line'
    this.selectAllEl = document.createElement('input')
    this.selectAllEl.type = 'checkbox'
    this.selectAllEl.addEventListener('change', () => this.toggleSelectAll(this.selectAllEl.checked))
    const selectAllText = document.createElement('span')
    selectAllText.textContent = '全选'
    this.countEl = document.createElement('span')
    this.countEl.className = 'sbm-status'
    selectLine.append(this.selectAllEl, selectAllText, this.countEl)

    this.listEl = document.createElement('div')
    this.listEl.className = 'sbm-list'

    const hint = document.createElement('div')
    hint.className = 'sbm-hint'
    hint.textContent = '提示：归档不可逆（官方无 unarchive）；删除会物理移除会话日志文件，不可恢复。运行中 / subagent 会话会被批量删除自动跳过。'

    body.append(toolbar, selectLine, this.listEl, hint)
    card.append(titleBar, body)
    this.overlay.appendChild(card)

    // 点击遮罩（卡片之外）关闭
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.dispose()
    })
  }

  /** 挂载：注入样式、挂到 body、首刷列表。 */
  mount(): void {
    ensureStyles()
    document.body.appendChild(this.overlay)
    void this.refresh()
  }

  /** 卸载：移除 DOM 并通知触发器清引用。 */
  dispose(): void {
    this.overlay.remove()
    this.onClose()
  }

  /** 拉取会话 + 归档集合，重建列表。 */
  async refresh(): Promise<void> {
    this.setBusy(true, '加载中…')
    try {
      const [{ result: listResult }, { result: workspaceResult }] = await Promise.all([
        this.connection.api.sessions.list({}),
        this.connection.api.workspace.list({}),
      ])
      const summaries = unwrap(listResult)
      const workspace = unwrap(workspaceResult)
      const archived = new Set(workspace.archivedSessionIds)
      this.rows = summaries.items.map((summary) => ({
        summary,
        archived: archived.has(summary.sessionId),
      }))
      this.pruneSelection()
      this.render()
      this.setStatus(`共 ${this.rows.length} 个会话`)
    } catch (error) {
      this.setStatus(`列表加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.setBusy(false)
    }
  }

  /** 渲染列表与按钮态。 */
  private render(): void {
    this.listEl.textContent = ''
    if (this.rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sbm-empty'
      empty.textContent = '暂无会话'
      this.listEl.appendChild(empty)
    }
    for (const row of this.rows) {
      this.listEl.appendChild(this.rowEl(row))
    }
    this.syncControls()
  }

  /** 构建一行。 */
  private rowEl(row: SessionRow): HTMLElement {
    const { summary } = row
    const line = document.createElement('label')
    line.className = 'sbm-row'

    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = this.selected.has(summary.sessionId)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.selected.add(summary.sessionId)
      else this.selected.delete(summary.sessionId)
      this.syncControls()
    })

    const title = document.createElement('span')
    title.className = 'sbm-title'
    title.textContent = titleOf(summary)
    title.title = summary.sessionId

    const badges: HTMLElement[] = []
    if (summary.running) {
      badges.push(this.badge('运行中', 'sbm-badge-running'))
    } else if (row.archived) {
      badges.push(this.badge('归档', 'sbm-badge-archived'))
    } else {
      badges.push(this.badge('空闲', 'sbm-badge-idle'))
    }
    if (summary.origin === 'subagent') {
      badges.push(this.badge('subagent', 'sbm-badge-subagent'))
    }

    const cwd = document.createElement('span')
    cwd.className = 'sbm-cwd'
    cwd.textContent = summary.cwd ?? ''
    cwd.title = summary.cwd ?? ''

    line.append(checkbox, title, ...badges, cwd)
    return line
  }

  private badge(text: string, className: string): HTMLSpanElement {
    const el = document.createElement('span')
    el.className = `sbm-badge ${className}`
    el.textContent = text
    return el
  }

  /** 全选切换：只作用于当前列表。 */
  private toggleSelectAll(checked: boolean): void {
    if (checked) {
      for (const row of this.rows) this.selected.add(row.summary.sessionId)
    } else {
      this.selected.clear()
    }
    this.render()
  }

  /** 清理已消失会话的选中态。 */
  private pruneSelection(): void {
    const present = new Set(this.rows.map((row) => row.summary.sessionId))
    for (const id of [...this.selected]) {
      if (!present.has(id)) this.selected.delete(id)
    }
  }

  /** 批量归档：逐条官方 RPC（幂等）。 */
  private async archiveSelected(): Promise<void> {
    if (this.selected.size === 0) return
    if (!window.confirm(`归档选中的 ${this.selected.size} 个会话？\n\n归档不可逆（官方无 unarchive）。`)) return
    this.setBusy(true, '归档中…')
    const ids = [...this.selected]
    let okCount = 0
    const failures: string[] = []
    try {
      for (const sessionId of ids) {
        try {
          unwrap((await this.connection.api.workspace.archiveSession({ sessionId })).result)
          okCount += 1
        } catch (error) {
          failures.push(`${sessionId.slice(0, 8)}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length === 0) {
        this.setStatus(`已归档 ${okCount} 个会话`)
      } else {
        this.setStatus(`已归档 ${okCount} 个，失败 ${failures.length} 个（${failures.join('；')}）`)
      }
    } catch (error) {
      this.setStatus(`归档失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.selected.clear()
      await this.refresh()
      this.setBusy(false)
    }
  }

  /** 批量删除：二次确认后走 host 自实现端点。 */
  private async deleteSelected(): Promise<void> {
    if (this.selected.size === 0) return
    if (!window.confirm(
      `删除选中的 ${this.selected.size} 个会话？\n\n`
      + '将物理删除会话日志文件，不可恢复。\n'
      + '运行中 / subagent 会话会被自动跳过。',
    )) return
    this.setBusy(true, '删除中…')
    const ids = [...this.selected]
    try {
      const result = await this.connection.rpc.call(CHANNEL, DELETE_ENDPOINT, { sessionIds: ids })
      if (!result.ok) {
        this.setStatus(`删除失败：${result.error.message}`)
        return
      }
      const response = result.value as DeleteSessionsResponse
      const reasons = new Map<string, number>()
      for (const item of response.results) {
        if (item.status === 'skipped' && item.reason !== undefined) {
          reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
        }
      }
      const skipText = [...reasons.entries()]
        .map(([reason, count]) => `${reasonLabel(reason)} ${count}`)
        .join('，')
      this.setStatus(
        `已删除 ${response.deleted} 个${skipText === '' ? '' : `，跳过 ${skipText}`}`,
      )
    } catch (error) {
      this.setStatus(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.selected.clear()
      await this.refresh()
      this.setBusy(false)
    }
  }

  /** 按钮/计数同步。 */
  private syncControls(): void {
    const count = this.selected.size
    this.countEl.textContent = `已选 ${count} 个`
    this.selectAllEl.checked = this.rows.length > 0 && count === this.rows.length
    this.archiveBtn.disabled = this.busy || count === 0
    this.deleteBtn.disabled = this.busy || count === 0
  }

  private setBusy(busy: boolean, message?: string): void {
    this.busy = busy
    if (message !== undefined) this.setStatus(message)
    this.syncControls()
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text
  }
}

/**
 * 侧边栏 footer 触发器：点击打开批量选择覆盖面板。
 * 只渲染一个按钮；面板实例挂在 ref 上，组件卸载时一并清理。
 */
function BatchSelectTrigger({ connection, wide }: { connection: ConnectionHandle; wide?: boolean }): ReactNode {
  const panelRef = useRef<SessionBatchPanel | null>(null)
  useEffect(() => () => {
    panelRef.current?.dispose()
    panelRef.current = null
  }, [])
  const rail = wide === false
  return createElement(
    'button',
    {
      type: 'button',
      className: rail ? 'sbm-trigger sbm-trigger-rail' : 'sbm-trigger',
      title: '批量选择会话（批量归档 / 批量删除）',
      onClick: () => {
        if (panelRef.current !== null) return
        const panel = new SessionBatchPanel(connection, () => { panelRef.current = null })
        panelRef.current = panel
        panel.mount()
      },
    },
    rail ? '☑' : '☑ 批量选择',
  )
}

/** Required services: slot 注册 + connection（官方 API + 自定义 RPC 通道）。 */
export const inject = ['slots', 'connection']

/**
 * 注册侧边栏「批量选择」footer action。
 * @param ctx - client 根上下文。
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const trigger = (props: { wide?: boolean }): ReactNode =>
    createElement(BatchSelectTrigger, { connection, wide: props.wide })
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'session-batch-manager',
      order: 10,
    }, trigger),
  )
}

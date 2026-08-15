/**
 * @dsh-external/dsh-session-batch-manager — 浏览器半区：批量选择入口 + 覆盖面板。
 *
 * 入口（双入口共享同一覆盖面板）：
 * 1. 主入口：`sidebar.footer.action`（ui-sidebar shell 声明的 list 槽，位于侧边栏底部、
 *    设置入口上方，宽/窄两种状态都渲染）——工作区会话列表区域没有可加的头部槽位，
 *    该 footer action 是最贴近侧边栏的加性挂载点。
 * 2. 补充入口：`settings.section`（设置页「会话管理」区块内的「打开批量选择面板」按钮）。
 *
 * 交互：点击入口 → 打开覆盖面板（全屏遮罩 + 居中卡片）：
 * - 会话列表：全量会话（官方 `POST /api/session.list` + `POST /api/workspace.list`
 *   按 archivedSessionIds join），每行 标题(projection title)/状态(运行中·归档·空闲)/cwd，
 *   带 checkbox 多选 + 全选
 * - 批量归档：逐条官方 RPC `api.workspace.archiveSession`（幂等；可在面板中恢复）
 * - 批量恢复：勾选已归档会话（先点「已归档」显示）后调 host 自实现端点
 *   `connection.rpc.call('/session-batch', 'unarchive', { sessionIds })`
 *   （非破坏性：仅从归档集合移除，无确认弹窗）
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

/** 与 host 端一致的删除/恢复端点契约。 */
const CHANNEL = '/session-batch'
const DELETE_ENDPOINT = 'delete'
const UNARCHIVE_ENDPOINT = 'unarchive'

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

/** 单条恢复结果（与 host UnarchiveSessionResult 同形）。 */
interface UnarchiveSessionResult {
  sessionId: string
  status: 'restored' | 'skipped'
  reason?: string
  message?: string
}

/** 批量恢复响应（与 host UnarchiveSessionsResponse 同形）。 */
interface UnarchiveSessionsResponse {
  results: UnarchiveSessionResult[]
  restored: number
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
  background: #ffffff; color: #1f2328;
  border: 1px solid #e3e6ea;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.15);
  overflow: hidden;
  font: 13px/1.6 system-ui, sans-serif;
}
.sbm-card-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; font-weight: 600;
  border-bottom: 1px solid #eceff2;
  flex: none;
}
.sbm-card-close {
  font: inherit; background: none; border: none; color: #6b7280;
  cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.sbm-card-close:hover { color: #dc2626; background: #f3f4f6; }
.sbm-body { padding: 12px 14px; overflow: auto; }
.sbm-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.sbm-btn {
  font: inherit; padding: 4px 12px; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  transition: background 150ms var(--ds-ease-in-out), border-color 150ms var(--ds-ease-in-out);
}
.sbm-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.sbm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.sbm-btn-danger:hover:not(:disabled) { border-color: #dc2626; color: #dc2626; }
.sbm-btn-active { border-color: #4f8cff; color: #2563eb; background: #eaf2ff; }
.sbm-status { color: #6b7280; font-size: 12px; flex: 1; text-align: right; }
.sbm-select-line { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.sbm-list {
  border: 1px solid #e3e6ea; border-radius: 8px;
  max-height: 46vh; overflow: auto; background: #fafbfc;
}
.sbm-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #eef0f2; }
.sbm-row:last-child { border-bottom: none; }
.sbm-row:hover { background: #f3f4f6; }
.sbm-row input[type="checkbox"] { flex: none; accent-color: #4f8cff; }
.sbm-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbm-badge {
  flex: none; font-size: 11px; padding: 1px 7px; border-radius: 10px; white-space: nowrap;
}
.sbm-badge-running { background: #e7f6ec; color: #1a7f37; border: 1px solid #b7e4c3; }
.sbm-badge-archived { background: #f1f2f4; color: #5f6672; border: 1px solid #d8dce1; }
.sbm-badge-idle { background: #eaf2ff; color: #2563eb; border: 1px solid #c7dbff; }
.sbm-badge-subagent { background: #fdf3e3; color: #b45309; border: 1px solid #f2ddb0; }
.sbm-cwd { flex: none; max-width: 220px; font-size: 11px; color: #6b7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbm-time { flex: none; font-size: 11px; color: #6b7280; white-space: nowrap; }
.sbm-hint { margin-top: 10px; font-size: 12px; color: #5f6672; line-height: 1.7; }
.sbm-empty { padding: 18px; color: #9ca3af; text-align: center; }
.sbm-trigger {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  background: transparent; border: none;
  appearance: none; -webkit-appearance: none;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer; border-radius: 8px;
  transition: background 150ms var(--ds-ease-in-out), color 150ms var(--ds-ease-in-out);
}
.sbm-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sbm-trigger:focus, .sbm-trigger:focus-visible { outline: none; }
.sbm-section { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.sbm-section-hint { font-size: 12px; color: #7c828c; line-height: 1.7; }
`

/** 注入面板样式（幂等）。 */
function ensureStyles(): void {
  if (document.getElementById('dsh-session-batch-manager-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-session-batch-manager-style'
  style.textContent = PANEL_CSS
  document.head.appendChild(style)
}

/** 行标题：优先 projection 缓存里的 title；缺省退回 agent preset 短名；再退回会话 id 前缀。 */
function titleOf(summary: SessionSummary): string {
  const values = summary.projections?.values as { title?: string | null } | undefined
  const title = values?.title
  if (title !== undefined && title !== null && title !== '') return title
  if (summary.agentPreset) {
    const short = summary.agentPreset.split(/[/:]/).pop() ?? summary.agentPreset
    return short
  }
  return `会话 ${summary.sessionId.slice(0, 8)}`
}

/** 将 RpcResult 折叠成 value，失败抛错（错误信息即 result.error.message）。 */
function unwrap<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** 时间戳 → "YYYY-MM-DD HH:mm"（本地时区）。 */
function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 跳过原因的中文标签。 */
function reasonLabel(reason: string): string {
  switch (reason) {
    case 'running': return '运行中'
    case 'subagent': return 'subagent'
    case 'not-found': return '未找到'
    case 'no-location': return '无日志文件'
    case 'file-error': return '文件错误'
    case 'not-archived': return '未归档'
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
  private readonly unarchiveBtn: HTMLButtonElement
  private readonly archivedBtn: HTMLButtonElement
  private readonly selectAllEl: HTMLInputElement
  private readonly countEl: HTMLSpanElement

  private rows: SessionRow[] = []
  private readonly selected = new Set<SessionId>()
  private busy = false
  /** 是否显示已归档会话（默认隐藏）。 */
  private showArchived = false

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
    this.archiveBtn.title = '归档选中的会话（可在面板中恢复）'
    this.archiveBtn.addEventListener('click', () => void this.archiveSelected())

    this.unarchiveBtn = document.createElement('button')
    this.unarchiveBtn.type = 'button'
    this.unarchiveBtn.className = 'sbm-btn'
    this.unarchiveBtn.textContent = '批量恢复'
    this.unarchiveBtn.title = '恢复选中的已归档会话（回到未归档列表）'
    this.unarchiveBtn.addEventListener('click', () => void this.unarchiveSelected())

    this.deleteBtn = document.createElement('button')
    this.deleteBtn.type = 'button'
    this.deleteBtn.className = 'sbm-btn sbm-btn-danger'
    this.deleteBtn.textContent = '批量删除'
    this.deleteBtn.title = '物理删除选中的会话日志文件（不可恢复）'
    this.deleteBtn.addEventListener('click', () => void this.deleteSelected())

    this.archivedBtn = document.createElement('button')
    this.archivedBtn.type = 'button'
    this.archivedBtn.className = 'sbm-btn'
    this.archivedBtn.textContent = '已归档'
    this.archivedBtn.title = '显示/隐藏已归档会话（默认隐藏）'
    this.archivedBtn.addEventListener('click', () => {
      this.showArchived = !this.showArchived
      this.archivedBtn.classList.toggle('sbm-btn-active', this.showArchived)
      this.render()
    })

    const refreshBtn = document.createElement('button')
    refreshBtn.type = 'button'
    refreshBtn.className = 'sbm-btn'
    refreshBtn.textContent = '刷新'
    refreshBtn.addEventListener('click', () => void this.refresh())

    this.statusEl = document.createElement('span')
    this.statusEl.className = 'sbm-status'

    toolbar.append(this.archivedBtn, this.unarchiveBtn, this.archiveBtn, this.deleteBtn, refreshBtn, this.statusEl)

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
    hint.textContent = '提示：归档可恢复（点「已归档」查看，勾选后点「批量恢复」）；删除会物理移除会话日志文件，不可恢复。运行中 / subagent 会话会被批量删除自动跳过。'

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
      this.rows = summaries.items
        .map((summary) => ({
          summary,
          archived: archived.has(summary.sessionId),
        }))
        .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt) // 最新的在上面
      this.pruneSelection()
      this.render()
      this.setStatus(`共 ${this.rows.length} 个会话`)
    } catch (error) {
      this.setStatus(`列表加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.setBusy(false)
    }
  }

  /** 渲染列表与按钮态（默认过滤已归档会话）。 */
  private render(): void {
    this.listEl.textContent = ''
    const visible = this.showArchived ? this.rows : this.rows.filter((row) => !row.archived)
    if (visible.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sbm-empty'
      empty.textContent = this.showArchived ? '暂无会话' : '暂无未归档会话'
      this.listEl.appendChild(empty)
    }
    for (const row of visible) {
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

    const time = document.createElement('span')
    time.className = 'sbm-time'
    time.textContent = formatTime(summary.updatedAt)
    time.title = `最新活跃：${new Date(summary.updatedAt).toLocaleString('zh-CN')}`

    line.append(checkbox, title, ...badges, cwd, time)
    return line
  }

  private badge(text: string, className: string): HTMLSpanElement {
    const el = document.createElement('span')
    el.className = `sbm-badge ${className}`
    el.textContent = text
    return el
  }

  /** 全选切换：只作用于当前可见（未归档）的会话。 */
  private toggleSelectAll(checked: boolean): void {
    const visible = this.showArchived ? this.rows : this.rows.filter((row) => !row.archived)
    if (checked) {
      for (const row of visible) this.selected.add(row.summary.sessionId)
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

  /** 批量恢复：非破坏性（仅移出归档集合），无确认弹窗，走 host 自实现端点。 */
  private async unarchiveSelected(): Promise<void> {
    if (this.selected.size === 0) return
    const hasArchived = [...this.selected].some((id) =>
      this.rows.find((row) => row.summary.sessionId === id)?.archived === true)
    if (!hasArchived) return
    this.setBusy(true, '恢复中…')
    const ids = [...this.selected]
    try {
      const result = await this.connection.rpc.call(CHANNEL, UNARCHIVE_ENDPOINT, { sessionIds: ids })
      if (!result.ok) {
        this.setStatus(`恢复失败：${result.error.message}`)
        return
      }
      const response = result.value as UnarchiveSessionsResponse
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
        `已恢复 ${response.restored} 个${skipText === '' ? '' : `，跳过 ${skipText}`}`,
      )
    } catch (error) {
      this.setStatus(`恢复失败：${error instanceof Error ? error.message : String(error)}`)
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
    // 勾选态按可见行计算（与 toggleSelectAll/render 同源）：rows 含默认过滤的
    // 已归档会话，直接比 rows.length 会漏判，导致「已全选时再点仍是全选」。
    const visible = this.showArchived ? this.rows : this.rows.filter((row) => !row.archived)
    this.selectAllEl.checked = visible.length > 0 && visible.every((row) => this.selected.has(row.summary.sessionId))
    this.archiveBtn.disabled = this.busy || count === 0
    this.deleteBtn.disabled = this.busy || count === 0
    const hasArchivedSelection = [...this.selected].some((id) =>
      this.rows.find((row) => row.summary.sessionId === id)?.archived === true)
    this.unarchiveBtn.disabled = this.busy || count === 0 || !hasArchivedSelection
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
 * 面板生命周期管理器：一个入口持有一个面板实例（重复点击不重复打开，
 * 关闭时清引用；dispose 用于入口组件卸载时兜底清理）。
 */
function panelOpener(connection: ConnectionHandle): { open: () => void; dispose: () => void } {
  let panel: SessionBatchPanel | null = null
  return {
    open: (): void => {
      if (panel !== null) return
      panel = new SessionBatchPanel(connection, () => { panel = null })
      panel.mount()
    },
    dispose: (): void => {
      panel?.dispose()
      panel = null
    },
  }
}

/** 勾选清单图标（官方 ui-primitives IconChecklistOutline14 同款，内联避免依赖）。 */
function ChecklistIcon({ size = 16 }: { size?: number }): ReactNode {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    createElement('path', { d: 'M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z', fill: 'currentColor' }),
    createElement('path', { d: 'M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z', fill: 'currentColor' }),
    createElement('path', { d: 'M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z', fill: 'currentColor' }),
    createElement('path', { d: 'M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z', fill: 'currentColor' }),
  )
}

/**
 * 侧边栏 footer 触发器（主入口）：点击打开批量选择覆盖面板。
 * 纯图标按钮，样式跟随侧边栏主题（iconButton 同款 28px、hover 主题变量）。
 */
function BatchSelectTrigger({ connection }: { connection: ConnectionHandle }): ReactNode {
  const opener = useRef<ReturnType<typeof panelOpener> | null>(null)
  if (opener.current === null) opener.current = panelOpener(connection)
  useEffect(() => () => { opener.current?.dispose() }, [])
  return createElement(
    'button',
    {
      type: 'button',
      className: 'sbm-trigger',
      title: '批量选择会话（批量归档 / 批量恢复 / 批量删除）',
      onClick: opener.current.open,
    },
    createElement(ChecklistIcon, { size: 16 }),
  )
}

/**
 * 设置页「会话管理」区块（补充入口）：一个打开批量选择面板的按钮。
 * 面板形态与侧边栏入口完全一致（同一覆盖层）。
 */
function SettingsSectionEntry({ connection }: { connection: ConnectionHandle }): ReactNode {
  const opener = useRef<ReturnType<typeof panelOpener> | null>(null)
  if (opener.current === null) opener.current = panelOpener(connection)
  useEffect(() => () => { opener.current?.dispose() }, [])
  return createElement(
    'div',
    { className: 'sbm-section' },
    createElement(
      'button',
      {
        type: 'button',
        className: 'sbm-btn',
        onClick: opener.current.open,
      },
      '打开批量选择面板',
    ),
    createElement(
      'div',
      { className: 'sbm-section-hint' },
      '批量选择会话进行归档（可恢复）或删除（不可恢复）；运行中 / subagent 会话会被删除自动跳过。',
    ),
  )
}

/** Required services: slot 注册 + connection（官方 API + 自定义 RPC 通道）。 */
export const inject = ['slots', 'connection']

/**
 * 注册批量选择入口：侧边栏 footer action（主入口）+ 设置页区块（补充入口）。
 * @param ctx - client 根上下文。
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const trigger = (): ReactNode => createElement(BatchSelectTrigger, { connection })
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'session-batch-manager',
      order: 10,
    }, trigger),
  )
  const sectionEntry = (): ReactNode => createElement(SettingsSectionEntry, { connection })
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'session-batch-manager',
      order: 50,
      label: () => '会话管理',
    }, sectionEntry),
  )
}

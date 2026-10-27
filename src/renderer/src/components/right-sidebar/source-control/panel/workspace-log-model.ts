import type {
  GitHistoryCursor,
  GitHistoryItem,
  GitHistoryResult
} from '../../../../../../shared/git-history'

/**
 * Accumulated pages of one pinned history walk. Pages are only ever merged when
 * their `generation` and `tipOid` match this state; any other page belongs to a
 * different set of refs and must restart the list instead of being appended.
 */
export type WorkspaceHistoryState = {
  generation: string | null
  tipOid: string
  items: GitHistoryItem[]
  cursor: GitHistoryCursor | null
  hasMore: boolean
  empty: boolean
}

export const EMPTY_WORKSPACE_HISTORY: WorkspaceHistoryState = {
  generation: null,
  tipOid: '',
  items: [],
  cursor: null,
  hasMore: false,
  empty: false
}

export type WorkspaceHistoryPageOutcome = 'started' | 'appended' | 'restart' | 'ignored'

export type WorkspaceHistoryPageResult = {
  state: WorkspaceHistoryState
  outcome: WorkspaceHistoryPageOutcome
}

/** Replaces the list with a first page; a page without a generation cannot pin a walk. */
export function startWorkspaceHistory(result: GitHistoryResult): WorkspaceHistoryState {
  return {
    generation: result.generation,
    tipOid: result.tipOid,
    items: result.items,
    cursor: result.hasMore && result.nextCursor ? result.nextCursor : null,
    hasMore: result.hasMore,
    empty: result.empty || result.items.length === 0
  }
}

/**
 * Appends a continuation page. A page from another generation, another pinned tip,
 * or a state without a generation is never mixed into what is already shown.
 */
export function appendWorkspaceHistoryPage(
  state: WorkspaceHistoryState,
  result: GitHistoryResult
): WorkspaceHistoryPageResult {
  if (!state.generation) {
    return { state, outcome: 'ignored' }
  }
  if (result.generation !== state.generation || result.tipOid !== state.tipOid) {
    return { state, outcome: 'restart' }
  }
  const seen = new Set(state.items.map((item) => item.id))
  const items = [...state.items, ...result.items.filter((item) => !seen.has(item.id))]
  return {
    outcome: 'appended',
    state: {
      generation: state.generation,
      tipOid: state.tipOid,
      items,
      cursor: result.hasMore && result.nextCursor ? result.nextCursor : null,
      hasMore: result.hasMore,
      empty: false
    }
  }
}

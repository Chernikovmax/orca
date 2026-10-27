export type GitHistoryGraphColorId =
  | 'git-graph-ref'
  | 'git-graph-remote-ref'
  | 'git-graph-base-ref'
  | 'git-graph-lane-1'
  | 'git-graph-lane-2'
  | 'git-graph-lane-3'
  | 'git-graph-lane-4'
  | 'git-graph-lane-5'

export const GIT_HISTORY_REF_COLOR: GitHistoryGraphColorId = 'git-graph-ref'
export const GIT_HISTORY_REMOTE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-remote-ref'
export const GIT_HISTORY_BASE_REF_COLOR: GitHistoryGraphColorId = 'git-graph-base-ref'

export const GIT_HISTORY_LANE_COLORS: readonly GitHistoryGraphColorId[] = [
  'git-graph-lane-1',
  'git-graph-lane-2',
  'git-graph-lane-3',
  'git-graph-lane-4',
  'git-graph-lane-5'
]

export const GIT_HISTORY_DEFAULT_LIMIT = 50
export const GIT_HISTORY_MAX_LIMIT = 200
/** Bound on rows already read before the next page; keeps one log walk proportional to loaded history. */
export const GIT_HISTORY_MAX_OFFSET = 5000

export type GitHistoryRefCategory = 'branches' | 'remote branches' | 'tags' | 'commits'

export type GitHistoryItemRef = {
  id: string
  name: string
  revision?: string
  category?: GitHistoryRefCategory
  description?: string
  color?: GitHistoryGraphColorId
}

export type GitHistoryItemStatistics = {
  files: number
  insertions: number
  deletions: number
}

export type GitHistoryItem = {
  id: string
  parentIds: string[]
  subject: string
  message: string
  displayId?: string
  author?: string
  authorEmail?: string
  /** Epoch milliseconds (git %at seconds × 1000). */
  timestamp?: number
  statistics?: GitHistoryItemStatistics
  references?: GitHistoryItemRef[]
}

export type GitHistoryOptions = {
  limit?: number
  baseRef?: string | null
  /** Host-issued Git context id; absent keeps the legacy root-checkout read. */
  contextId?: string
  /** Ref name or full object id to browse; absent means HEAD. */
  revision?: string
  /** Continuation of a pinned history: its first-page tip and the rows already read. */
  cursor?: GitHistoryCursor
  /** Repository-relative path whose commits are listed. */
  path?: string
  /** Case-insensitive substring search over the commit message. */
  message?: string
}

/**
 * Pins one history walk. `tipOid` is resolved once from the browsed revision, so later
 * pages cannot shift when refs move; `offset` is how many commits this client already
 * shows. Pages carrying a different generation must not be appended together.
 */
export type GitHistoryCursor = {
  tipOid: string
  offset: number
}

export type GitHistoryResult = {
  items: GitHistoryItem[]
  currentRef?: GitHistoryItemRef
  remoteRef?: GitHistoryItemRef
  baseRef?: GitHistoryItemRef
  mergeBase?: string
  hasIncomingChanges: boolean
  hasOutgoingChanges: boolean
  hasMore: boolean
  limit: number
  /** Stable token over the pinned tip and filters; equal only for one history walk. */
  generation: string
  /** Full object id the walk is pinned to; empty when the checkout has no commits. */
  tipOid: string
  /** The browsed revision when it was not HEAD. */
  browsedRef?: GitHistoryItemRef
  /** True when there is no commit to list (unborn HEAD or an empty revision). */
  empty: boolean
  /** Continuation for the next page; present only while `hasMore`. */
  nextCursor?: GitHistoryCursor
}

export type GitHistoryExecutor = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

import type { GitStatusEntry, GitConflictOperation } from './git-status-types'

export type GitContextRef = {
  id: string
  executionHostId: string
  rootWorktreePath: string
  checkoutPath: string
  gitDir: string
  commonGitDir: string
}

export type GitContextError = {
  category: 'access-denied' | 'unavailable' | 'invalid-metadata' | 'limit' | 'git-error'
  message: string
}

/** One locally available ref plus the upstream data this checkout has loaded. */
export type GitWorkspaceRef = {
  /** Full ref name: `refs/heads/…`, `refs/remotes/…` or `refs/tags/…`. */
  name: string
  oid: string
  upstream?: string
  /** Counts computed from loaded local refs only; no network read happens here. */
  ahead?: number
  behind?: number
  /** The configured upstream ref no longer exists locally (deleted or never fetched). */
  upstreamGone?: boolean
}

export type RepositoryState = {
  context: GitContextRef
  head?: string
  branch?: string
  unborn: boolean
  detached: boolean
  conflictOperation: GitConflictOperation
  /** True when a merge/rebase/cherry-pick is unfinished in this checkout. */
  operationInProgress?: boolean
  entries: GitStatusEntry[]
  dirty: boolean
  conflicted: boolean
  incomplete: boolean
  /** The per-context porcelain listing hit its cap, so `entries` is not the whole change set. */
  statusTruncated?: boolean
  expectedState: string
  refs?: GitWorkspaceRef[]
  /** When the host read `refs`; ahead/behind describe refs as of this instant. */
  refsReadAt?: string
  /** mtime of this checkout's FETCH_HEAD, when a fetch has ever updated it. */
  lastFetchAt?: string
  /** Remote names only; URLs and credentials never reach the renderer. */
  remotes?: string[]
  refsError?: GitContextError
}

export type SubmoduleEntry = {
  path: string
  name: string
  parentContextId: string
  contextId?: string
  declaredUrls: string[]
  effectiveUrl?: string
  headOid?: string
  indexOid?: string
  indexConflictOids: string[]
  currentOid?: string
  commitChanged: boolean
  stagedGitlinkChanged: boolean
  dirty: boolean
  conflicted: boolean
  availability: 'initialized' | 'uninitialized' | 'unavailable' | 'blocked'
  descendants: 'complete' | 'unknown' | 'limited'
  metadataIssues: string[]
  error?: GitContextError
}

export type GitWorkspaceSnapshot = {
  rootContextId?: string
  repositories: RepositoryState[]
  submodules: SubmoduleEntry[]
  errors: { path: string; error: GitContextError }[]
  incomplete: boolean
  limits: { maxDepth: number; maxContexts: number; concurrency: number }
}

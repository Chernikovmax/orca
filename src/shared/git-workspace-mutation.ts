import type { GitConflictResolution, GitWorkspaceConflictDocument } from './git-workspace-conflict'
import type {
  GitWorkspaceBatchPreview,
  GitWorkspaceBatchReceipt,
  GitWorkspaceBatchRequest,
  GitWorkspaceBatchRunRequest
} from './git-workspace-batch'
import type { GitFileStatus } from './git-status-types'

/** Writes a user can request against one host-issued Git context. */
export type GitMutationAction =
  | 'stage'
  | 'unstage'
  | 'discard'
  | 'commit'
  | 'stageGitlink'
  | 'previewCommit'
  | 'previewDiscard'
  | 'restoreDiscard'
  | 'listRecoveries'
  | 'checkout'
  | 'createBranch'
  | 'fetch'
  | 'push'
  | 'merge'
  | 'rebase'
  | 'continueOperation'
  | 'abortOperation'
  | 'readConflict'
  | 'saveConflict'
  | 'resolveConflict'
  | 'previewSubmoduleInitialize'
  | 'submoduleInitialize'
  | 'previewSubmoduleCheckout'
  | 'submoduleCheckout'
  | 'previewSubmoduleSyncUrl'
  | 'submoduleSyncUrl'
  | 'previewSubmoduleAdd'
  | 'submoduleAdd'
  | 'previewSubmoduleRemove'
  | 'submoduleRemove'
  | 'previewBatch'
  | 'runBatch'

/** Network actions are explicit user requests and report progress while they run. */
export type GitMutationNetworkAction = 'fetch' | 'push'

/**
 * Client-side deadlines for the long branch/remote actions. They are deliberately
 * longer than the host's own Git timeouts so a dropped transport is reported as
 * unknown instead of cancelling a Git child that may still finish.
 */
export const GIT_MUTATION_TIMEOUT_MS: Record<string, number> = {
  fetch: 330_000,
  push: 330_000,
  previewSubmoduleInitialize: 60_000,
  submoduleInitialize: 330_000,
  previewSubmoduleCheckout: 60_000,
  submoduleCheckout: 330_000,
  previewSubmoduleSyncUrl: 60_000,
  submoduleSyncUrl: 330_000,
  previewSubmoduleAdd: 60_000,
  submoduleAdd: 330_000,
  previewSubmoduleRemove: 60_000,
  submoduleRemove: 60_000,
  previewBatch: 60_000,
  runBatch: 330_000,
  merge: 150_000,
  rebase: 150_000,
  continueOperation: 150_000,
  abortOperation: 150_000
}

/** One progress frame for an explicit fetch/push; never contains stderr text. */
export type GitMutationProgress = {
  progressId: string
  contextId?: string
  operation: GitMutationNetworkAction
  /** Stable machine phase such as `connecting`, `receiving` or `writing`. */
  phase: string
  percent?: number
  completed?: number
  total?: number
  done: boolean
}

/** What the host actually completed for a branch/remote operation. */
export type GitWorkspaceOperationReceipt = {
  kind: 'checkout' | 'createBranch' | 'fetch' | 'push' | 'merge' | 'rebase' | 'continue' | 'abort'
  refName?: string
  remote?: string
  /** Resolved target commit or pushed local ref object id, when known. */
  oid?: string
  /** Local branch after a checkout/createBranch. */
  branch?: string
  detached?: boolean
  /** False when merge/rebase stopped with conflicts or left an unfinished operation. */
  completed: boolean
  conflicts: boolean
  detail?:
    | 'already-up-to-date'
    | 'fast-forward'
    | 'merge-commit'
    | 'rebase-completed'
    | 'continued'
    | 'aborted'
}

/**
 * Host-issued identifiers and expectations for one write. `expectedState` and
 * `documentId` are never renderer authority: the host re-reads the workspace and
 * the exact file before writing, and refuses when either moved.
 */
export type GitWorkspaceMutationRequest = {
  action: GitMutationAction
  contextId?: string
  expectedState?: string
  filePath?: string
  /** Old path of a rename; file-level operations act on both paths. */
  oldPath?: string
  documentId?: string
  content?: string
  resolution?: GitConflictResolution
  hunkIds?: string[]
  lineIds?: string[]
  /** Full child commit OID the parent gitlink should record. */
  childOid?: string
  message?: string
  /** Host-issued discard preview token; required by `discard`. */
  previewId?: string
  /** Host-issued recovery id; required by `restoreDiscard`. */
  recoveryId?: string
  /** Full ref name or full commit id; the host re-validates it against fresh refs. */
  refName?: string
  /** Explicit start point for `createBranch`; HEAD when omitted. */
  startRef?: string
  /** Explicit remote name for `fetch`/`push`; never a URL. */
  remote?: string
  /** Optional remote branch for `fetch`; the whole remote is fetched when omitted. */
  branch?: string
  /** Local branch object id the user reviewed; `push` refuses when it moved. */
  expectedRefOid?: string
  /** Publish the pushed branch by setting its upstream; never implied. */
  setUpstream?: boolean
  /** Correlates progress frames with one explicit network action. */
  progressId?: string
  /** Full HEAD the user reviewed; an empty value means an unborn checkout. */
  expectedHead?: string
  /** Untrusted URL for explicit add or URL synchronization. */
  url?: string
  /** Explicit recursion choice for submodule initialization. */
  recursive?: boolean
  /** Explicit batch preview or continuation request. */
  batch?: GitWorkspaceBatchRequest
  batchRun?: GitWorkspaceBatchRunRequest
}
export type GitSubmoduleLifecyclePreview = {
  contextId: string
  expectedState: string
  previewId: string
  operation: 'initialize' | 'checkout' | 'syncUrl' | 'add' | 'remove'
  filePath: string
  declaredUrl?: string
  effectiveUrl?: string
  previousDeclaredUrl?: string
  previousEffectiveUrl?: string
  targetOid?: string
  refName?: string
  childExpectedState?: string
  detached: boolean
  recursive: boolean
  changes: string[]
  warning?: string
}

export type GitMutationErrorCategory =
  | 'stale'
  | 'incomplete'
  | 'access-denied'
  | 'busy'
  | 'hook'
  | 'signing'
  | 'unsupported'
  | 'invalid'
  | 'unknown-outcome'
  | 'git-error'
  /** Checkout/merge/rebase refuses while local changes would be overwritten. */
  | 'dirty'
  /** Git left conflicts; the integration is not complete. */
  | 'conflict'
  /** Push was rejected, typically because the remote has newer commits. */
  | 'rejected'
  /** The remote refused or could not use the host credentials. */
  | 'authentication'
  /** The host could not reach the remote; Git reported no completed transfer. */
  | 'network'
  /** Another operation is unfinished, so this action cannot start. */
  | 'operation-in-progress'

/** A copy of the previous working-tree file kept before a discard. */
export type GitRecoveryEntry = {
  id: string
  contextId: string
  filePath: string
  createdAt: number
  /** False when the discarded file did not exist (a staged addition). */
  existed: boolean
  size?: number
  mode?: number
}

/** Exactly what the real index holds now; nothing is staged by this preview. */
export type GitCommitPreview = {
  contextId: string
  expectedState: string
  branch?: string
  head?: string
  unborn: boolean
  detached: boolean
  staged: { path: string; status: GitFileStatus; oldPath?: string }[]
  stagedFiles: number
  /** True when the staged listing exceeded the host bound. */
  truncated: boolean
  /** Hooks and signing run as configured; Orca never passes --no-verify or disables signing. */
  preservesHooks: true
}

export type GitDiscardPreview = {
  contextId: string
  expectedState: string
  filePath: string
  previewId: string
  tracked: boolean
  exists: boolean
  mode?: string
  /** False when no durable copy can be written, so the discard is refused. */
  recoveryAvailable: boolean
  warning?: string
}

export type GitMutationReceipt = {
  action: GitMutationAction
  outcome: 'succeeded' | 'failed' | 'unknown' | 'running'
  contextId?: string
  expectedState?: string
  head?: string
  error?: string
  errorCategory?: GitMutationErrorCategory
  recovery?: GitRecoveryEntry
  preview?:
    | GitCommitPreview
    | GitDiscardPreview
    | GitSubmoduleLifecyclePreview
    | GitWorkspaceBatchPreview
  recoveries?: GitRecoveryEntry[]
  commit?: { head: string; summary: string }
  operation?: GitWorkspaceOperationReceipt
  batch?: GitWorkspaceBatchReceipt
  conflict?: GitWorkspaceConflictDocument
}

export type GitSelectableLine = {
  id: string
  kind: 'add' | 'delete'
  text: string
  oldLine?: number
  newLine?: number
}

export type GitSelectableHunk = {
  id: string
  header: string
  oldStart: number
  newStart: number
  lines: GitSelectableLine[]
}

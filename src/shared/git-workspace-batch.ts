import type { GitWorkspaceSnapshot } from './git-workspace-types'

export type GitWorkspaceBatchCommitSelection = {
  contextId: string
  message: string
  /** Exact staged paths the user reviewed; no additional index entry may enter the commit. */
  stagedPaths: string[]
}

export type GitWorkspaceBatchPublication = {
  contextId: string
  remote: string
  /** Full local branch ref which is pushed to the same branch on `remote`. */
  refName: string
  expectedRefOid: string
}

export type GitWorkspaceBatchRequest = {
  /** Root context identity from the host's current workspace catalog. */
  rootContextId: string
  /** Host-issued contexts selected for the workflow. */
  contextIds: string[]
  /** Include every discovered descendant of each selected context. */
  recursive: boolean
  commits: GitWorkspaceBatchCommitSelection[]
  /** Omit a context to commit it locally without publishing it. */
  publication?: GitWorkspaceBatchPublication[]
}

export type GitWorkspaceBatchConfirmation = {
  parentContextId: string
  filePath: string
  childContextId: string
  childOid: string
  confirmed: true
}

export type GitWorkspaceBatchRunRequest = {
  previewId: string
  /** Exact, post-child-commit confirmation requested by the previous receipt. */
  confirmations?: GitWorkspaceBatchConfirmation[]
  /** Explicitly retries only the known-failed next step after its dependencies are rechecked. */
  retryFailed?: boolean
  /** Reads the cached run state only; never begins, resumes or retries a step. */
  inspectOnly?: boolean
}

export type GitWorkspaceBatchStepKind = 'commit' | 'stageGitlink' | 'verifyRemote' | 'push'
export type GitWorkspaceBatchStepStatus =
  | 'ready'
  | 'needs-confirmation'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'blocked'
  | 'pending'

export type GitWorkspaceBatchStep = {
  id: string
  kind: GitWorkspaceBatchStepKind
  contextId: string
  parentContextId?: string
  childContextId?: string
  filePath?: string
  childOid?: string
  remote?: string
  refName?: string
  progressId?: string
  status: GitWorkspaceBatchStepStatus
  detail?: string
}

export type GitWorkspaceBatchStepResult = GitWorkspaceBatchStep & {
  error?: string
  errorCategory?: string
}

export type GitWorkspaceBatchPreview = {
  previewId: string
  expiresAt: number
  steps: GitWorkspaceBatchStep[]
  workspace: GitWorkspaceSnapshot
  incomplete: boolean
  errors: string[]
}

export type GitWorkspaceBatchReceipt = {
  previewId: string
  runId: string
  outcome: 'running' | 'completed' | 'paused' | 'failed' | 'unknown'
  steps: GitWorkspaceBatchStepResult[]
  progress: { completed: number; total: number }
  nextConfirmation?: Omit<GitWorkspaceBatchConfirmation, 'confirmed'>
  /** Pending step descriptions remain visible after partial failure; terminal outcomes never replay. */
  remaining: GitWorkspaceBatchStep[]
  workspace?: GitWorkspaceSnapshot
}

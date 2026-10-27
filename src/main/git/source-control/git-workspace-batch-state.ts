import type {
  GitWorkspaceBatchPublication,
  GitWorkspaceBatchReceipt,
  GitWorkspaceBatchRequest,
  GitWorkspaceBatchStepResult
} from '../../../shared/git-workspace-batch'
import type {
  GitContextRef,
  GitWorkspaceSnapshot,
  RepositoryState
} from '../../../shared/git-workspace-types'
import { GitMutationError } from './git-workspace-mutation-error'

export const BATCH_LIFETIME_MS = 15 * 60_000
export const BATCH_STATE_LIMIT = 64
export const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

export type BatchState = {
  id: string
  expiresAt: number
  request: GitWorkspaceBatchRequest
  workspaceRoot: string
  rootContextId: string
  steps: GitWorkspaceBatchStepResult[]
  selectedIds: string[]
  identities: Map<string, GitContextRef>
  expectedStates: Map<string, string>
  indexRecords: Map<string, string>
  initialHeads: Map<string, string>
  currentRefs: Map<string, string>
  stagedSelections: Map<string, string[]>
  stagedLinks: Map<string, Set<string>>
  publication: Map<string, GitWorkspaceBatchPublication>
  remoteFingerprints: Map<string, Map<string, string>>
  committedOids: Map<string, string>
  running: boolean
  terminal?: 'failed' | 'unknown' | 'completed'
  lastWorkspace?: GitWorkspaceSnapshot
}

export const states = new Map<string, BatchState>()

export function trimStates(now = Date.now()): void {
  for (const [id, state] of states) {
    if (state.expiresAt <= now && !state.running) {
      states.delete(id)
    }
  }
  while (states.size >= BATCH_STATE_LIMIT) {
    const oldest = [...states].find(([, state]) => !state.running)
    if (!oldest) {
      throw new GitMutationError('busy', 'Too many Git batch workflows are currently active')
    }
    states.delete(oldest[0])
  }
}

export function repositoryFor(
  snapshot: GitWorkspaceSnapshot,
  contextId: string
): RepositoryState | undefined {
  return snapshot.repositories.find((item) => item.context.id === contextId)
}

export function stagedPathSet(repository: RepositoryState): string[] {
  return repository.entries
    .filter((entry) => entry.area === 'staged')
    .map((entry) => entry.path)
    .sort()
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function resultSnapshot(
  state: BatchState,
  outcome: GitWorkspaceBatchReceipt['outcome']
): GitWorkspaceBatchReceipt {
  const next = state.steps.find((step) => step.status === 'needs-confirmation')
  const remaining = state.steps.filter(
    (step) =>
      step.status === 'pending' || step.status === 'ready' || step.status === 'needs-confirmation'
  )
  const completed = state.steps.filter((step) => step.status === 'succeeded').length
  return {
    previewId: state.id,
    runId: state.id,
    outcome,
    steps: state.steps.map((step) => ({ ...step })),
    progress: { completed, total: state.steps.length },
    ...(next?.parentContextId && next.filePath && next.childContextId && next.childOid
      ? {
          nextConfirmation: {
            parentContextId: next.parentContextId,
            filePath: next.filePath,
            childContextId: next.childContextId,
            childOid: next.childOid
          }
        }
      : {}),
    remaining: remaining.map(({ error: _error, errorCategory: _category, ...step }) => ({
      ...step
    })),
    ...(state.lastWorkspace ? { workspace: state.lastWorkspace } : {})
  }
}

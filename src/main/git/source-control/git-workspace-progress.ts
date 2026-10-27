import type {
  GitMutationNetworkAction,
  GitMutationProgress
} from '../../../shared/git-workspace-mutation'
import { createGitProgressRecordReader } from '../../../shared/git-progress-records'

/**
 * Process-local progress bus for explicit fetch/push actions. It carries parsed
 * meter records only — never stderr text — so remote URLs and credentials cannot
 * leak through progress.
 */
const listeners = new Map<string, Set<(event: GitMutationProgress) => void>>()
const completed = new Map<string, GitMutationProgress>()
const COMPLETED_LIMIT = 32

export function publishGitWorkspaceProgress(event: GitMutationProgress): void {
  const current = listeners.get(event.progressId)
  if (current) {
    for (const listener of current) {
      listener(event)
    }
  }
  if (!event.done) {
    return
  }
  listeners.delete(event.progressId)
  completed.set(event.progressId, event)
  while (completed.size > COMPLETED_LIMIT) {
    const oldest = completed.keys().next().value
    if (oldest === undefined) {
      break
    }
    completed.delete(oldest)
  }
}

export function subscribeGitWorkspaceProgress(
  progressId: string,
  listener: (event: GitMutationProgress) => void
): () => void {
  const finished = completed.get(progressId)
  if (finished) {
    listener(finished)
    return () => {}
  }
  const current = listeners.get(progressId) ?? new Set()
  current.add(listener)
  listeners.set(progressId, current)
  return () => {
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(progressId)
    }
  }
}

const FETCH_TITLES: Record<string, string> = {
  'remote: Counting objects': 'remote-counting',
  'remote: Compressing objects': 'remote-compressing',
  'Receiving objects': 'receiving',
  'Resolving deltas': 'resolving',
  'Updating files': 'checkout'
}
const PUSH_TITLES: Record<string, string> = {
  'Enumerating objects': 'enumerating',
  'Counting objects': 'counting',
  'Compressing objects': 'compressing',
  'Writing objects': 'writing'
}

export type WorkspaceProgressPhase = (
  phase: string,
  record: { percent: number; completed: number; total: number; done: boolean }
) => void

/**
 * Reads every meter Git may print for one network action. Records may span
 * stderr chunks; unmatched text is ignored rather than forwarded.
 */
export function createWorkspaceNetworkProgressReader(
  operation: GitMutationNetworkAction,
  onPhase: WorkspaceProgressPhase
): (chunk: string) => void {
  const titles = operation === 'fetch' ? FETCH_TITLES : PUSH_TITLES
  const readers = Object.entries(titles).map(([title, phase]) =>
    createGitProgressRecordReader(title, (record) => onPhase(phase, record))
  )
  return (chunk) => {
    for (const read of readers) {
      read(chunk)
    }
  }
}

import type { GitMutationProgress } from '../../../shared/git-workspace-mutation'
import type { RuntimeGitContext } from './runtime-git-client-context'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

function isProgressEvent(value: unknown): value is GitMutationProgress {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.progressId === 'string' &&
    (record.operation === 'fetch' || record.operation === 'push') &&
    typeof record.phase === 'string' &&
    typeof record.done === 'boolean'
  )
}

/**
 * Best-effort progress for one explicit fetch/push. A subscription failure never
 * blocks the mutation itself; the receipt remains the source of truth.
 */
export async function subscribeRuntimeGitMutationProgress(
  context: RuntimeGitContext,
  progressId: string,
  onEvent: (event: GitMutationProgress) => void
): Promise<() => void> {
  try {
    const handle = await subscribeRuntimeRpc(
      context.target,
      'git.mutationProgress',
      { progressId },
      {
        onEvent: (result) => {
          if (isProgressEvent(result) && !result.done) {
            onEvent(result)
          }
        },
        onError: () => {},
        onClose: () => {}
      }
    )
    return handle.unsubscribe
  } catch {
    return () => {}
  }
}

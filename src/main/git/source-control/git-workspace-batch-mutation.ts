import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { previewGitWorkspaceBatch } from './git-workspace-batch'
import { runGitWorkspaceBatch } from './git-workspace-batch-run'

export async function mutateGitWorkspaceBatch(
  root: string,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  if (request.action === 'previewBatch') {
    if (!request.batch) {
      throw new GitMutationError('invalid', 'Batch preview requires a batch request')
    }
    const preview = await previewGitWorkspaceBatch(root, request.batch, options)
    return { action: request.action, outcome: 'succeeded', preview }
  }
  if (!request.batchRun) {
    throw new GitMutationError('invalid', 'Batch run requires a preview id')
  }
  const batch = await runGitWorkspaceBatch(root, request.batchRun, options)
  const outcome =
    batch.outcome === 'completed'
      ? 'succeeded'
      : batch.outcome === 'unknown'
        ? 'unknown'
        : batch.outcome === 'failed'
          ? 'failed'
          : 'running'
  return { action: request.action, outcome, batch }
}

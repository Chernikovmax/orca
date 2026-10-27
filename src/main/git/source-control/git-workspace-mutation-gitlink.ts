import type { GitWorkspaceMutationRequest } from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { verifyWorkspaceContext } from './git-workspace-context'
import { workspaceGitRead } from './git-workspace-discovery'
import { validateDiffPath } from './git-diff-path'
import { GitMutationError } from './git-workspace-mutation-error'
import { FULL_OID, submoduleForPath, type ResolvedWorkspace } from './git-workspace-mutation-shared'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'

/**
 * Records the reviewed child commit in the parent index. It checks the child's HEAD
 * and the parent's authorized context, writes only the gitlink, and never touches
 * the child's index, files or history.
 */
export async function stageGitlinkImpl(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<void> {
  const { workspace, context } = resolved
  const filePath = validateDiffPath(request.filePath ?? '')
  const childOid = request.childOid ?? ''
  if (!FULL_OID.test(childOid)) {
    throw new GitMutationError('invalid', 'A full child commit id is required to stage a gitlink')
  }
  const module = submoduleForPath(workspace, context, filePath)
  if (!module || !module.contextId) {
    throw new GitMutationError(
      'invalid',
      'No initialized submodule context matches this path; initialize it explicitly first'
    )
  }
  if (module.currentOid !== childOid) {
    throw new GitMutationError('stale', 'Child checkout moved; refresh before staging its gitlink')
  }
  const child = workspace.repositories.find((item) => item.context.id === module.contextId)
  if (!child || child.head !== childOid) {
    throw new GitMutationError('stale', 'Child HEAD does not match the reviewed commit; refresh it')
  }
  await verifyWorkspaceContext(child.context, options)
  const childHead = (
    await workspaceGitRead(child.context.checkoutPath, ['rev-parse', '--verify', 'HEAD'], options)
  ).trim()
  if (childHead !== childOid) {
    throw new GitMutationError('stale', 'Child HEAD changed while staging its gitlink; refresh it')
  }
  await gitExecFileAsync(
    ['update-index', '--add', '--cacheinfo', `160000,${childOid},${filePath}`],
    {
      ...gitOptionsForWorktree(context.checkoutPath, options),
      admissionTier: 'interactive'
    }
  )
  const record = await workspaceGitRead(
    context.checkoutPath,
    ['ls-files', '--stage', '-z', '--', `:(literal)${filePath}`],
    options
  )
  const rows = record.split('\0').filter(Boolean)
  if (rows.length !== 1 || !rows[0].startsWith(`160000 ${childOid} 0\t${filePath}`)) {
    throw new GitMutationError(
      'git-error',
      'Parent index did not record the reviewed child commit'
    )
  }
}

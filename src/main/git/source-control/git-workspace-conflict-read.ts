import type { GitWorkspaceConflictDocument } from '../../../shared/git-workspace-conflict'
import type { GitWorkspaceMutationRequest } from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { verifyWorkspaceContext } from './git-workspace-context'
import { validateDiffPath } from './git-diff-path'
import { detectConflictOperationState } from './git-conflict-operation'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'
import { readConflictResult, readConflictStage } from './git-workspace-conflict-content'
import { conflictFence, issueConflict } from './git-workspace-conflict-state'
import { readConflictRenamePaths } from './git-workspace-conflict-renames'

export async function readConflictImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitWorkspaceConflictDocument> {
  if (!request.contextId) {
    throw new GitMutationError('invalid', 'Conflict review requires an explicit context')
  }
  const filePath = validateDiffPath(request.filePath ?? '')
  if (
    filePath.includes('\\') ||
    filePath.includes(':') ||
    filePath.split('/').some((part) => /[. ]$/.test(part))
  ) {
    throw new GitMutationError(
      'access-denied',
      'Conflict path has an unsafe platform-specific spelling'
    )
  }
  const { context } = workspace
  await verifyWorkspaceContext(context, options)
  const before = await conflictFence(context, filePath, options)
  const records = (
    await workspaceGitRead(context.checkoutPath, ['ls-files', '--unmerged', '-z'], options)
  )
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t')
      const [mode, oid, stage] = row.slice(0, tab).split(' ')
      return { mode, oid, stage, path: row.slice(tab + 1) }
    })
  const selected = records.filter((record) => record.path === filePath)
  if (!selected.length) {
    throw new GitMutationError('invalid', 'This path has no unresolved index stages')
  }
  const base = await readConflictStage(
    context.checkoutPath,
    selected.find((record) => record.stage === '1'),
    options
  )
  const ours = await readConflictStage(
    context.checkoutPath,
    selected.find((record) => record.stage === '2'),
    options
  )
  const theirs = await readConflictStage(
    context.checkoutPath,
    selected.find((record) => record.stage === '3'),
    options
  )
  const result = await readConflictResult(context.checkoutPath, filePath, options)
  const { operation } = await detectConflictOperationState(context.checkoutPath, options)
  const entry = workspace.repository.entries.find(
    (item) => item.path === filePath && item.conflictStatus === 'unresolved'
  )
  const relatedPaths = [
    ...new Set([
      ...(await readConflictRenamePaths(context.checkoutPath, filePath, operation, options)),
      ...records
        .filter(
          (record) => record.path !== filePath && selected.some((item) => item.oid === record.oid)
        )
        .map((record) => record.path),
      ...(entry?.oldPath && entry.oldPath !== filePath ? [entry.oldPath] : [])
    ])
  ]
  const contents = [base.content, ours.content, theirs.content]
  const kind: GitWorkspaceConflictDocument['kind'] = contents.some(
    (item) => item.kind === 'gitlink'
  )
    ? 'gitlink'
    : contents.some((item) => item.kind === 'symlink')
      ? 'symlink'
      : relatedPaths.length
        ? 'rename'
        : contents.some((item) => item.kind === 'binary' || item.kind === 'large')
          ? 'binary'
          : base.content.kind === 'absent'
            ? 'add-add'
            : ours.content.kind === 'absent' || theirs.content.kind === 'absent'
              ? 'modify-delete'
              : 'text'
  if (before.full !== (await conflictFence(context, filePath, options)).full) {
    throw new GitMutationError('stale', 'Conflict changed while loading; reopen it')
  }
  return issueConflict(
    {
      contextId: context.id,
      filePath,
      operation,
      kind,
      relatedPaths,
      base,
      ours,
      theirs,
      result,
      editable: result.kind === 'text' && kind !== 'gitlink' && kind !== 'symlink',
      labels: {
        base: 'Base — common ancestor (index stage 1)',
        ours:
          operation === 'rebase'
            ? 'Ours — upstream plus already replayed commits (stage 2)'
            : 'Ours — current checkout (stage 2)',
        theirs:
          operation === 'rebase'
            ? 'Theirs — your commit currently being replayed (stage 3)'
            : operation === 'cherry-pick'
              ? 'Theirs — picked commit (stage 3)'
              : 'Theirs — incoming revision (stage 3)',
        result: 'Result — Save writes only the worktree; Mark Resolved updates the index'
      }
    },
    context,
    before
  )
}

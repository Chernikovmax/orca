import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { validateDiffPath } from './git-diff-path'
import {
  assertIssuedSelectionFresh,
  getIssuedGitSelection,
  selectedGitPatch
} from './git-selection-patch'
import { stageFile, unstageFile } from './staging'
import { GitMutationError } from './git-workspace-mutation-error'
import {
  applySelectedPatch,
  submoduleForPath,
  type ResolvedWorkspace
} from './git-workspace-mutation-shared'

export async function stageOrUnstage(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const filePath = validateDiffPath(request.filePath ?? '')
  const oldPath =
    request.oldPath && request.oldPath !== filePath ? validateDiffPath(request.oldPath) : undefined
  for (const candidate of oldPath ? [oldPath, filePath] : [filePath]) {
    if (submoduleForPath(resolved.workspace, resolved.context, candidate)) {
      throw new GitMutationError(
        'unsupported',
        'This path is a submodule gitlink; stage it explicitly with the reviewed child commit'
      )
    }
  }
  const applyFiles = async (): Promise<void> => {
    for (const candidate of oldPath ? [oldPath, filePath] : [filePath]) {
      const gitOptions = { ...options, admissionTier: 'interactive' as const }
      await (request.action === 'stage'
        ? stageFile(resolved.context.checkoutPath, candidate, gitOptions)
        : unstageFile(resolved.context.checkoutPath, candidate, gitOptions))
    }
  }
  const partial = !!request.documentId || !!request.lineIds?.length || !!request.hunkIds?.length
  if (!partial) {
    await applyFiles()
    return { action: request.action, outcome: 'succeeded' }
  }
  if (oldPath) {
    throw new GitMutationError(
      'unsupported',
      'Partial changes are unavailable for a rename; stage or unstage the whole file'
    )
  }
  const issued = getIssuedGitSelection(request.documentId)
  if (
    issued.cwd !== resolved.context.checkoutPath ||
    issued.filePath !== filePath ||
    (issued.contextId && issued.contextId !== resolved.context.id)
  ) {
    throw new GitMutationError('access-denied', 'Diff selection belongs to another context or path')
  }
  if (issued.direction !== request.action) {
    throw new GitMutationError('invalid', 'Diff sides do not match this staging action')
  }
  await assertIssuedSelectionFresh(issued, options)
  const selection = selectedGitPatch(issued, request)
  if (selection.wholeFile) {
    await applyFiles()
  } else if (selection.patch) {
    await applySelectedPatch(resolved.context, selection.patch, options)
  }
  return { action: request.action, outcome: 'succeeded' }
}

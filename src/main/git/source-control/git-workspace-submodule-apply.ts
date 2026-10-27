import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { validateDiffPath } from './git-diff-path'
import { verifyWorkspaceContext } from './git-workspace-context'
import {
  FULL_OID,
  readAuthorizedWorkspace,
  submoduleForPath,
  type ResolvedWorkspace
} from './git-workspace-mutation-shared'
import { readContentFence } from './git-content-fence'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { withGitMutationQueue } from './git-mutation-queue'
import { initializeSelected } from './git-workspace-submodule-initialize'
import {
  assertSafeGitmodules,
  assertSafeSubmodulePath,
  declaration,
  localSubmoduleUrl,
  remoteTrackingCommit,
  remoteUrl,
  runSubmoduleGit,
  SUBMODULE_NETWORK_ENV
} from './git-workspace-submodule-metadata'
import { previews, submodulePreviewArguments } from './git-workspace-submodule-preview-state'
export async function applySubmoduleLifecycle(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const preview = previews.get(request.previewId ?? '')
  if (!preview || preview.expiresAt < Date.now()) {
    throw new GitMutationError(
      'stale',
      'Submodule preview expired or is unavailable; preview again'
    )
  }
  const filePath = validateDiffPath(request.filePath ?? '')
  const cwd = workspace.context.checkoutPath
  const fsRoot = resolveWorktreeFilesystemPath(cwd, options)
  const op = preview.preview.operation
  await assertSafeGitmodules(fsRoot, op !== 'add')
  await assertSafeSubmodulePath(
    fsRoot,
    filePath,
    op === 'checkout' ? 'required' : op === 'add' ? 'absent' : 'optional'
  )
  const moduleEntry = submoduleForPath(workspace.workspace, workspace.context, filePath)
  const found = op === 'add' ? undefined : await declaration(cwd, filePath, options)
  const currentEffectiveUrl = await localSubmoduleUrl(cwd, found?.name, options)
  const parentRemote = ['initialize', 'syncUrl', 'add'].includes(op)
    ? await remoteUrl(cwd, options)
    : undefined
  const args = submodulePreviewArguments(request, filePath, {
    declaredUrl: found?.url,
    effectiveUrl: currentEffectiveUrl,
    parentRemote,
    indexOid: moduleEntry?.indexOid,
    childContextId: moduleEntry?.contextId,
    headOid: moduleEntry?.headOid
  })
  if (
    preview.preview.contextId !== workspace.context.id ||
    preview.preview.expectedState !== workspace.repository.expectedState ||
    preview.args !== args
  ) {
    throw new GitMutationError(
      'stale',
      'Submodule state or requested arguments changed since preview'
    )
  }
  if (
    (await readContentFence(cwd, { filePath: '.gitmodules', oldPath: filePath }, options)) !==
    preview.metadataFence
  ) {
    throw new GitMutationError('stale', 'Submodule metadata bytes or index changed since preview')
  }
  previews.delete(request.previewId!)
  const gitOptions = gitOptionsForWorktree(cwd, { ...options, admissionTier: 'interactive' })
  if (op === 'initialize') {
    await initializeSelected(
      workspace,
      filePath,
      preview.preview.recursive,
      options,
      preview.metadataFence
    )
  } else if (op === 'checkout') {
    const entry = submoduleForPath(workspace.workspace, workspace.context, filePath)
    const child = entry?.contextId
      ? workspace.workspace.repositories.find(
          (repository) => repository.context.id === entry.contextId
        )
      : undefined
    if (!entry || !child || child.expectedState !== preview.preview.childExpectedState) {
      throw new GitMutationError('stale', 'Submodule checkout state changed since preview')
    }
    await verifyWorkspaceContext(child.context, options)
    if (
      request.childOid &&
      request.childOid !== entry.headOid &&
      request.childOid !== entry.indexOid
    ) {
      throw new GitMutationError(
        'stale',
        'Selected commit is no longer the parent HEAD/index gitlink'
      )
    }
    const childGitOptions = {
      ...gitOptionsForWorktree(child.context.checkoutPath, {
        ...options,
        admissionTier: 'interactive'
      }),
      env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    }
    const target = request.refName
      ? await remoteTrackingCommit(child.context.checkoutPath, request.refName, options)
      : preview.preview.targetOid!
    if (target !== preview.preview.targetOid) {
      throw new GitMutationError('stale', 'Selected submodule commit changed since preview')
    }
    if (!FULL_OID.test(target)) {
      throw new GitMutationError('invalid', 'Submodule target did not resolve to a full commit OID')
    }
    if (child.dirty || child.conflicted || child.operationInProgress) {
      throw new GitMutationError(
        'dirty',
        'Submodule checkout is blocked by local changes or an unfinished operation'
      )
    }
    await runSubmoduleGit(['cat-file', '-e', `${target}^{commit}`], childGitOptions)
    await runSubmoduleGit(['checkout', '--detach', target], childGitOptions)
  } else if (op === 'syncUrl') {
    const resolvedUrl = preview.resolvedUrl
    if (!found || !resolvedUrl) {
      throw new GitMutationError('stale', 'Submodule declaration changed since preview')
    }
    let afterParentFence = ''
    await withGitMutationQueue(cwd, options, async () => {
      const current = await readAuthorizedWorkspace(
        workspace.context.rootWorktreePath,
        {
          ...request,
          expectedState: preview.preview.expectedState
        },
        options
      )
      await verifyWorkspaceContext(current.context, options)
      if (
        (await readContentFence(cwd, { filePath: '.gitmodules', oldPath: filePath }, options)) !==
          preview.metadataFence ||
        (await localSubmoduleUrl(cwd, found.name, options)) !== currentEffectiveUrl ||
        (await remoteUrl(cwd, options)) !== parentRemote
      ) {
        throw new GitMutationError(
          'stale',
          'Submodule metadata or URL changed while synchronization was queued'
        )
      }
      if (request.url !== undefined && request.url !== found.url) {
        await runSubmoduleGit(
          ['config', '-f', '.gitmodules', `submodule.${found.name}.url`, request.url],
          gitOptions
        )
      }
      await runSubmoduleGit(['config', `submodule.${found.name}.url`, resolvedUrl], gitOptions)
      afterParentFence = await readContentFence(
        cwd,
        { filePath: '.gitmodules', oldPath: filePath },
        options
      )
    })
    const childReview = preview.childRemote
    if (childReview) {
      await withGitMutationQueue(childReview.checkoutPath, options, async () => {
        const current = await readAuthorizedWorkspace(
          workspace.context.rootWorktreePath,
          {
            action: 'submoduleSyncUrl',
            contextId: workspace.context.id
          },
          options
        )
        const child = current.workspace.repositories.find(
          (repository) => repository.context.id === childReview.contextId
        )
        if (
          !child ||
          child.context.checkoutPath !== childReview.checkoutPath ||
          (await readContentFence(cwd, { filePath: '.gitmodules', oldPath: filePath }, options)) !==
            afterParentFence ||
          (await localSubmoduleUrl(cwd, found.name, options)) !== resolvedUrl
        ) {
          throw new GitMutationError(
            'stale',
            'URL synchronization stopped after the parent step because a dependency changed'
          )
        }
        await verifyWorkspaceContext(child.context, options)
        const childOptions = gitOptionsForWorktree(child.context.checkoutPath, options)
        const currentUrl = (
          await runSubmoduleGit(['remote', 'get-url', childReview.name], childOptions)
        ).stdout.trim()
        if (currentUrl !== childReview.url) {
          throw new GitMutationError(
            'stale',
            'The child remote changed since review; its URL was not overwritten'
          )
        }
        await runSubmoduleGit(['remote', 'set-url', childReview.name, resolvedUrl], childOptions)
      })
    }
  } else if (op === 'add') {
    const url = preview.resolvedUrl
    if (!url) {
      throw new GitMutationError('invalid', 'Submodule add requires a URL')
    }
    await runSubmoduleGit(['submodule', 'add', '--', url, filePath], {
      ...gitOptions,
      env: SUBMODULE_NETWORK_ENV,
      timeout: 300_000
    })
  } else {
    const found = await declaration(cwd, filePath, options)
    if (!found) {
      throw new GitMutationError('stale', 'Submodule declaration changed since preview')
    }
    const oid = moduleEntry?.indexOid
    if (!oid || !FULL_OID.test(oid)) {
      throw new GitMutationError(
        'stale',
        'The reviewed parent-index gitlink is no longer available'
      )
    }
    await runSubmoduleGit(['update-index', '-z', '--index-info'], {
      ...gitOptions,
      stdin: `0 ${'0'.repeat(oid.length)}\t${filePath}\0`
    })
    await runSubmoduleGit(
      ['config', '-f', '.gitmodules', '--remove-section', `submodule.${found.name}`],
      gitOptions
    )
  }
  return { action: request.action, outcome: 'succeeded', preview: preview.preview }
}

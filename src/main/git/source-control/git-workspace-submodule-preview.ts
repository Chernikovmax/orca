import { randomUUID } from 'node:crypto'
import type {
  GitMutationReceipt,
  GitSubmoduleLifecyclePreview,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { verifyWorkspaceContext } from './git-workspace-context'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { validateDiffPath } from './git-diff-path'
import {
  FULL_OID,
  hasOnlyUninitializedGaps,
  submoduleForPath,
  type ResolvedWorkspace
} from './git-workspace-mutation-shared'
import { readContentFence } from './git-content-fence'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { resolveRelativeUrl } from './git-submodule-url'
import {
  assertSafeGitmodules,
  assertSafeSubmodulePath,
  declaration,
  defaultRemote,
  localSubmoduleUrl,
  redactUrl,
  remoteTrackingCommit,
  remoteUrl,
  runSubmoduleGit,
  validateSubmoduleUrl
} from './git-workspace-submodule-metadata'
import {
  operationFor,
  storeSubmodulePreview,
  submodulePreviewArguments,
  TOKEN_TTL_MS,
  type ChildRemoteReview
} from './git-workspace-submodule-preview-state'

export async function previewSubmoduleLifecycle(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const action = request.action
  const operation = operationFor(action)
  if (!operation) {
    throw new GitMutationError('invalid', 'Unsupported submodule preview action')
  }
  const filePath = validateDiffPath(request.filePath ?? '')
  const fsRoot = resolveWorktreeFilesystemPath(workspace.context.checkoutPath, options)
  await assertSafeGitmodules(fsRoot, operation !== 'add')
  await assertSafeSubmodulePath(
    fsRoot,
    filePath,
    operation === 'checkout' ? 'required' : operation === 'add' ? 'absent' : 'optional'
  )
  if (
    workspace.repository.incomplete ||
    (workspace.workspace.incomplete && !hasOnlyUninitializedGaps(workspace.workspace))
  ) {
    throw new GitMutationError('incomplete', 'Submodule lifecycle requires complete host discovery')
  }
  const moduleEntry = submoduleForPath(workspace.workspace, workspace.context, filePath)
  if (operation !== 'add' && !moduleEntry) {
    throw new GitMutationError('invalid', 'No discovered submodule exists at this path')
  }
  const blockingIssues =
    moduleEntry?.metadataIssues.filter(
      (issue) => !issue.startsWith('Declared and local URL differ')
    ) ?? []
  if (moduleEntry && (blockingIssues.length > 0 || moduleEntry.indexConflictOids.length > 0)) {
    throw new GitMutationError(
      'incomplete',
      [
        'Submodule metadata conflicts or is incomplete; refresh and reconcile it before writing',
        ...blockingIssues
      ].join('\n')
    )
  }
  if (operation === 'remove') {
    if (!moduleEntry?.indexOid) {
      throw new GitMutationError(
        'unsupported',
        'Removal requires a verifiable parent-index gitlink'
      )
    }
    const indexed = await gitExecFileAsync(
      ['ls-files', '--stage', '-z', '--', filePath],
      gitOptionsForWorktree(workspace.context.checkoutPath, options)
    )
    if (
      !indexed.stdout
        .split('\0')
        .some(
          (row) =>
            row.startsWith(`160000 ${moduleEntry.indexOid} 0\t`) && row.endsWith(`\t${filePath}`)
        )
    ) {
      throw new GitMutationError('stale', 'Parent index no longer contains the reviewed gitlink')
    }
  }
  if (
    operation === 'add' &&
    workspace.repository.entries.some((entry) => entry.path === '.gitmodules')
  ) {
    throw new GitMutationError(
      'dirty',
      'Commit or restore existing .gitmodules changes before adding a submodule; unrelated metadata will not be staged implicitly'
    )
  }
  const found = await declaration(workspace.context.checkoutPath, filePath, options)
  if (operation !== 'add' && !found) {
    throw new GitMutationError('invalid', 'No declared submodule exists at this path')
  }
  const suppliedUrl = request.url
  let url = suppliedUrl ?? found?.url
  const currentEffectiveUrl = await localSubmoduleUrl(
    workspace.context.checkoutPath,
    found?.name,
    options
  )
  const parentRemote = ['initialize', 'syncUrl', 'add'].includes(operation)
    ? await remoteUrl(workspace.context.checkoutPath, options)
    : undefined
  let effectiveUrl = operation === 'syncUrl' || operation === 'add' ? url : currentEffectiveUrl
  if (operation === 'initialize' || operation === 'syncUrl' || operation === 'add') {
    if (!url) {
      throw new GitMutationError('invalid', 'A declared submodule URL is required')
    }
    if (operation === 'initialize') {
      for (const candidate of [found?.url, currentEffectiveUrl]) {
        if (candidate) {
          validateSubmoduleUrl(resolveRelativeUrl(validateSubmoduleUrl(candidate), parentRemote))
        }
      }
    }
    if (operation === 'initialize') {
      const candidate = currentEffectiveUrl ?? found?.url
      if (candidate) {
        effectiveUrl = validateSubmoduleUrl(
          resolveRelativeUrl(validateSubmoduleUrl(candidate), parentRemote)
        )
      }
    }
    if (url) {
      url = validateSubmoduleUrl(resolveRelativeUrl(validateSubmoduleUrl(url), parentRemote))
    }
    if (operation === 'syncUrl' || operation === 'add') {
      effectiveUrl = url
    }
  }
  const declaredUrl = operation === 'add' ? suppliedUrl : (suppliedUrl ?? found?.url)
  let childExpectedState: string | undefined
  let targetOid: string | undefined = operation === 'initialize' ? moduleEntry?.indexOid : undefined
  if (operation === 'checkout') {
    const entry = moduleEntry
    const child = entry?.contextId
      ? workspace.workspace.repositories.find(
          (repository) => repository.context.id === entry.contextId
        )
      : undefined
    if (!entry || !child) {
      throw new GitMutationError('incomplete', 'Initialize the submodule before selecting a commit')
    }
    if (child.dirty || child.conflicted || child.operationInProgress) {
      throw new GitMutationError(
        'dirty',
        'Submodule checkout is blocked by local changes or an unfinished operation'
      )
    }
    if (request.childOid) {
      if (request.childOid !== entry.headOid && request.childOid !== entry.indexOid) {
        throw new GitMutationError('stale', 'Selected OID is not the parent HEAD/index gitlink')
      }
      targetOid = request.childOid
    } else if (request.refName) {
      targetOid = await remoteTrackingCommit(child.context.checkoutPath, request.refName, options)
    } else {
      throw new GitMutationError(
        'invalid',
        'Choose the parent gitlink OID or an available remote-tracking revision'
      )
    }
    if (!FULL_OID.test(targetOid)) {
      throw new GitMutationError(
        'invalid',
        'Submodule revision did not resolve to a full object id'
      )
    }
    await runSubmoduleGit(['cat-file', '-e', `${targetOid}^{commit}`], {
      ...gitOptionsForWorktree(child.context.checkoutPath, options),
      env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    })
    childExpectedState = child.expectedState
  }
  let childRemote: ChildRemoteReview | undefined
  if (operation === 'syncUrl' && moduleEntry?.contextId) {
    const child = workspace.workspace.repositories.find(
      (repository) => repository.context.id === moduleEntry.contextId
    )
    if (!child) {
      throw new GitMutationError('stale', 'The child context disappeared before URL review')
    }
    await verifyWorkspaceContext(child.context, options)
    const name = await defaultRemote(child.context.checkoutPath, options)
    if (name) {
      const result = await runSubmoduleGit(
        ['remote', 'get-url', name],
        gitOptionsForWorktree(child.context.checkoutPath, options)
      )
      childRemote = {
        contextId: child.context.id,
        checkoutPath: child.context.checkoutPath,
        name,
        url: result.stdout.trim()
      }
    }
  }
  const detached = operation === 'checkout' || operation === 'initialize'
  const preview: GitSubmoduleLifecyclePreview = {
    contextId: workspace.context.id,
    expectedState: workspace.repository.expectedState,
    previewId: randomUUID(),
    operation,
    filePath,
    ...(declaredUrl ? { declaredUrl: redactUrl(declaredUrl) } : {}),
    ...(effectiveUrl ? { effectiveUrl: redactUrl(effectiveUrl) } : {}),
    ...(operation === 'syncUrl' && found?.url ? { previousDeclaredUrl: redactUrl(found.url) } : {}),
    ...(operation === 'syncUrl' && moduleEntry?.effectiveUrl
      ? { previousEffectiveUrl: redactUrl(moduleEntry.effectiveUrl) }
      : {}),
    ...(targetOid ? { targetOid } : {}),
    ...(request.refName ? { refName: request.refName } : {}),
    ...(childExpectedState ? { childExpectedState } : {}),
    detached,
    recursive: request.recursive === true,
    changes:
      operation === 'initialize'
        ? [
            `Initialize ${filePath}${request.recursive ? ' and explicitly selected descendants' : ''}`
          ]
        : operation === 'checkout'
          ? [`Checkout ${targetOid} in ${filePath}`]
          : operation === 'syncUrl'
            ? [
                request.url === undefined
                  ? 'Keep the current .gitmodules declaration'
                  : `Set declared URL for ${filePath}`,
                'Synchronize the effective local URL without network access'
              ]
            : operation === 'add'
              ? [
                  `Stage .gitmodules path/URL and gitlink for ${filePath}`,
                  'Register the local submodule config and retain its Git metadata',
                  `URL: ${redactUrl(url ?? '')}`
                ]
              : [
                  'Remove the worktree .gitmodules declaration and stage the gitlink deletion',
                  'Keep checkout files, local submodule config, and .git/modules data'
                ],
    ...(operation === 'remove'
      ? {
          warning:
            'Only the parent index and .gitmodules stanza change. Any existing checkout becomes untracked; checkout files, local submodule config, and .git/modules data are retained.'
        }
      : detached
        ? { warning: 'Checking out a commit directly leaves the submodule detached.' }
        : {})
  }
  storeSubmodulePreview({
    preview,
    childRemote,
    metadataFence: await readContentFence(
      workspace.context.checkoutPath,
      { filePath: '.gitmodules', oldPath: filePath },
      options
    ),
    args: submodulePreviewArguments(request, filePath, {
      declaredUrl: found?.url,
      effectiveUrl: currentEffectiveUrl,
      parentRemote,
      indexOid: moduleEntry?.indexOid,
      childContextId: moduleEntry?.contextId,
      headOid: moduleEntry?.headOid
    }),
    resolvedUrl: operation === 'syncUrl' || operation === 'add' ? url : undefined,
    expiresAt: Date.now() + TOKEN_TTL_MS
  })
  return { action, outcome: 'succeeded', preview }
}

import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { validateDiffPath } from './git-diff-path'
import { verifyWorkspaceContext } from './git-workspace-context'
import {
  hasOnlyUninitializedGaps,
  readAuthorizedWorkspace,
  submoduleForPath,
  type ResolvedWorkspace
} from './git-workspace-mutation-shared'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { getStatus } from './status-read'
import { withGitMutationQueue } from './git-mutation-queue'
import { readContentFence } from './git-content-fence'
import { resolveRelativeUrl } from './git-submodule-url'
import {
  assertSafeGitmodules,
  assertSafeSubmodulePath,
  declaration,
  remoteUrl,
  runSubmoduleGit,
  SUBMODULE_NETWORK_ENV,
  validateSubmoduleUrl
} from './git-workspace-submodule-metadata'
async function initializeOne(
  checkoutPath: string,
  filePath: string,
  urls: string[],
  options: GetStatusOptions
): Promise<void> {
  const fsRoot = resolveWorktreeFilesystemPath(checkoutPath, options)
  await assertSafeGitmodules(fsRoot, true)
  await assertSafeSubmodulePath(fsRoot, filePath, 'optional')
  const parentRemote = await remoteUrl(checkoutPath, options)
  if (!urls.length) {
    throw new GitMutationError(
      'incomplete',
      'Submodule URL could not be verified before initialization'
    )
  }
  for (const candidate of urls) {
    validateSubmoduleUrl(resolveRelativeUrl(validateSubmoduleUrl(candidate), parentRemote))
  }
  await runSubmoduleGit(
    [
      '-c',
      'submodule.recurse=false',
      '-c',
      'fetch.recurseSubmodules=false',
      'submodule',
      'update',
      '--init',
      '--checkout',
      '--',
      validateDiffPath(filePath)
    ],
    {
      ...gitOptionsForWorktree(checkoutPath, { ...options, admissionTier: 'interactive' }),
      env: SUBMODULE_NETWORK_ENV,
      timeout: 300_000
    }
  )
}

async function initializeStep(
  workspace: ResolvedWorkspace,
  contextId: string,
  filePath: string,
  options: GetStatusOptions,
  expectedState?: string,
  expectedMetadataFence?: string
): Promise<void> {
  const root = workspace.context.rootWorktreePath
  const initial = await readAuthorizedWorkspace(
    root,
    { action: 'submoduleInitialize', contextId },
    options
  )
  await withGitMutationQueue(initial.context.checkoutPath, options, async () => {
    const current = await readAuthorizedWorkspace(
      root,
      {
        action: 'submoduleInitialize',
        contextId,
        expectedState
      },
      options
    )
    if (current.context.id !== initial.context.id) {
      throw new GitMutationError('stale', 'Submodule parent identity changed before initialization')
    }
    await verifyWorkspaceContext(current.context, options)
    if (
      expectedMetadataFence !== undefined &&
      (await readContentFence(
        current.context.checkoutPath,
        { filePath: '.gitmodules', oldPath: filePath },
        options
      )) !== expectedMetadataFence
    ) {
      throw new GitMutationError(
        'stale',
        'Submodule metadata changed while initialization was queued'
      )
    }
    const entry = submoduleForPath(current.workspace, current.context, filePath)
    if (
      !entry ||
      entry.metadataIssues.some((issue) => !issue.startsWith('Declared and local URL differ')) ||
      entry.indexConflictOids.length ||
      !entry.indexOid
    ) {
      throw new GitMutationError(
        'incomplete',
        'Submodule metadata cannot safely authorize initialization'
      )
    }
    if (entry.availability === 'initialized') {
      return
    }
    if (entry.availability !== 'uninitialized') {
      throw new GitMutationError('incomplete', 'Submodule checkout is blocked or unavailable')
    }
    const found = await declaration(current.context.checkoutPath, filePath, options)
    await initializeOne(
      current.context.checkoutPath,
      filePath,
      [found?.url, ...entry.declaredUrls, entry.effectiveUrl].filter((url): url is string =>
        Boolean(url)
      ),
      options
    )
  })
}

export async function initializeSelected(
  workspace: ResolvedWorkspace,
  filePath: string,
  recursive: boolean,
  options: GetStatusOptions,
  expectedMetadataFence: string
): Promise<void> {
  const selected = submoduleForPath(workspace.workspace, workspace.context, filePath)
  if (!selected) {
    throw new GitMutationError('incomplete', 'Selected submodule metadata is unavailable')
  }
  await initializeStep(
    workspace,
    workspace.context.id,
    filePath,
    options,
    workspace.repository.expectedState,
    expectedMetadataFence
  )
  if (!recursive) {
    return
  }
  const contexts = new Set<string>()
  for (let count = 0; count < 128; count++) {
    const snapshot = (
      await getStatus(workspace.context.rootWorktreePath, {
        ...options,
        includeWorkspace: true,
        includeLineStats: false
      })
    ).workspace
    if (!snapshot || (snapshot.incomplete && !hasOnlyUninitializedGaps(snapshot))) {
      throw new GitMutationError(
        'incomplete',
        'Recursive initialization stopped because workspace discovery is incomplete'
      )
    }
    const current = snapshot.submodules.find(
      (entry) => entry.parentContextId === workspace.context.id && entry.path === selected.path
    )
    if (!current?.contextId) {
      throw new GitMutationError('incomplete', 'Initialized child context was not discovered')
    }
    contexts.add(current.contextId)
    for (const entry of snapshot.submodules) {
      if (entry.contextId && contexts.has(entry.parentContextId)) {
        contexts.add(entry.contextId)
      }
    }
    const next = snapshot.submodules.find(
      (entry) => contexts.has(entry.parentContextId) && entry.availability === 'uninitialized'
    )
    if (!next) {
      if (
        snapshot.submodules.some(
          (entry) =>
            contexts.has(entry.parentContextId) &&
            (entry.availability !== 'initialized' || entry.descendants !== 'complete')
        )
      ) {
        throw new GitMutationError(
          'incomplete',
          'Recursive initialization stopped before every selected descendant was verified'
        )
      }
      return
    }
    const parent = snapshot.repositories.find(
      (repository) => repository.context.id === next.parentContextId
    )
    if (!parent) {
      throw new GitMutationError('stale', 'A discovered submodule parent disappeared')
    }
    const parentPath = snapshot.submodules.find(
      (entry) => entry.contextId === parent.context.id
    )?.path
    const relative = parentPath ? next.path.slice(parentPath.length + 1) : next.path
    await initializeStep(
      workspace,
      parent.context.id,
      validateDiffPath(relative),
      options,
      parent.expectedState
    )
  }
  throw new GitMutationError(
    'incomplete',
    'Recursive initialization reached the 128-context safety limit'
  )
}

import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitDiffSelection } from '../../../shared/git-diff-document'
import { readFileDiffDocument, validateDiffPath } from './git-diff-document-read'
import { getStatus } from './status-read'
import { verifyWorkspaceContext } from './git-workspace-context'
import type { GetStatusOptions } from './get-status-options'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitRuntimeOptionsKey } from './git-runtime-options-cache-key'
import { gitDiffReadDedupe, settledDiffCache } from './git-read-cache-invalidation'
import { readWorktreeDiffStamp } from './worktree-diff-stamp'
import { findContainingSubmodule, listSubmodulePaths } from './submodule-paths'
import { getCommitDiff } from './commit-diff'

/**
 * Get original and modified content for diffing a file.
 */
export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false,
  options: GetStatusOptions = {},
  selection?: GitDiffSelection
): Promise<GitDiffResult> {
  filePath = validateDiffPath(filePath)
  if (selection?.contextId) {
    const snapshot = (await getStatus(worktreePath, { ...options, includeWorkspace: true, includeLineStats: false })).workspace
    const repository = snapshot?.repositories.find((item) => item.context.id === selection.contextId)
    if (!repository) {
      throw new Error('Access denied: Git context is not available in this authorized worktree')
    }
    await verifyWorkspaceContext(repository.context, options)
    const result = await readFileDiffDocument(repository.context.checkoutPath, filePath, selection, options)
    const module = snapshot?.submodules.find((item) => item.parentContextId === repository.context.id && item.path === [snapshot.submodules.find((item) => item.contextId === repository.context.id)?.path, filePath].filter(Boolean).join('/'))
    if (result.document?.special === 'gitlink' && module) {
      result.document.childContextId = module.contextId
      if (selection.right.kind === 'worktree') {
        result.document.right.oid = module.currentOid
      }
    }
    await verifyWorkspaceContext(repository.context, options)
    return result
  }
  if (selection) {
    return readFileDiffDocument(worktreePath, filePath, selection, options)
  }
  const readKey = stableInFlightKey([
    'diff',
    worktreePath,
    filePath,
    staged,
    compareAgainstHead,
    ...gitRuntimeOptionsKey(options)
  ])
  // Why: register the dedupe synchronously (before any await) so concurrent identical reads
  // coalesce — including on the settled-cache lookup, which is itself I/O.
  return gitDiffReadDedupe.run(readKey, () =>
    loadDiffThroughSettledCache(
      readKey,
      worktreePath,
      filePath,
      staged,
      compareAgainstHead,
      options
    )
  )
}

/**
 * Serve a settled diff when the git state it was built from is provably
 * unchanged, otherwise read and — only if the read proved everything it touched
 * — record it under the stamp taken *before* the read.
 *
 * Stamping first is what makes staleness impossible: anything that moves during
 * or after the read leaves the stored stamp behind, so the next lookup misses.
 */
async function loadDiffThroughSettledCache(
  readKey: string,
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  // Why before the stamp read: the stamp is itself several awaited stats, and a mutation that
  // lands entirely inside that window would otherwise leave the fence covering only the git read.
  const readGeneration = settledDiffCache.beginRead()
  // A staged diff compares HEAD to the index, so the working tree is not one of its inputs.
  const stamp = await readWorktreeDiffStamp(worktreePath, filePath, !staged, options)
  const cached = settledDiffCache.get(readKey, stamp)
  if (cached) {
    return cached
  }
  const loaded = await loadDiff(worktreePath, filePath, staged, compareAgainstHead, options)
  if (loaded.reusable) {
    settledDiffCache.set(readKey, stamp, loaded.result, readGeneration)
  }
  return loaded.result
}

/**
 * `reusable` is false when the result cannot be proven to describe the stamped
 * state: a submodule route, whose inputs live in another repo and are stamped by
 * that repo's own read, or a blob read that failed rather than proving absence.
 */
type LoadedDiff = { result: GitDiffResult; reusable: boolean }

async function loadDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<LoadedDiff> {
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
  if (matchedSubmodule) {
    const snapshot = (await getStatus(worktreePath, { ...options, includeWorkspace: true, includeLineStats: false })).workspace
    const module = snapshot?.submodules.find((item) => item.path === matchedSubmodule)
    if (filePath === matchedSubmodule && snapshot?.rootContextId) {
      return notReusable(await getDiff(worktreePath, filePath, staged, compareAgainstHead, options, {
        contextId: snapshot.rootContextId,
        left: { kind: staged || compareAgainstHead ? 'head' : 'index' },
        right: { kind: staged ? 'index' : 'worktree' }
      }))
    }
    const child = snapshot?.repositories.find((item) => item.context.id === module?.contextId)
    if (!child || !module) {
      throw new Error('Access denied: submodule checkout is not authorized or available')
    }
    await verifyWorkspaceContext(child.context, options)
    const innerPath = filePath.slice(matchedSubmodule.length + 1)
    const fromOid = staged || compareAgainstHead ? module.headOid : module.indexOid ?? module.headOid
    const toOid = staged ? module.indexOid : module.currentOid
    const result = fromOid && toOid && fromOid !== toOid
      ? await getCommitDiff(child.context.checkoutPath, { filePath: innerPath, parentOid: fromOid, commitOid: toOid }, options)
      : await getDiff(child.context.checkoutPath, innerPath, staged, compareAgainstHead, options)
    await verifyWorkspaceContext(child.context, options)
    return notReusable(result)
  }

  const status = await getStatus(worktreePath, { ...options, includeLineStats: false })
  const entry = status.entries.find((entry) => entry.path === filePath && entry.area === (staged ? 'staged' : 'unstaged'))
  const result = await readFileDiffDocument(worktreePath, filePath, {
    oldPath: staged ? entry?.oldPath : undefined,
    left: { kind: staged || compareAgainstHead ? 'head' : 'index' },
    right: { kind: staged ? 'index' : 'worktree' }
  }, options)
  return { result, reusable: !result.document?.stale }
}


function notReusable(result: GitDiffResult): LoadedDiff {
  return { result, reusable: false }
}

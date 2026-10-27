import type { GitCommitCompareResult } from '../../../shared/git-diff-compare-types'
import type { GitHistoryOptions, GitHistoryResult } from '../../../shared/git-history'
import {
  GitHistoryReadError,
  loadGitHistoryFromExecutor,
  type GitHistoryExecutor
} from '../../../shared/git-history'
import { gitReadOptionsForWorktree, type GitRuntimeOptions } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import type { GetStatusOptions } from './get-status-options'
import { readAuthorizedGitContext } from './git-workspace-read'
import { GitWorkspaceReadError } from './git-workspace-error'
import { getCommitCompare } from './commit-compare'
import { validateFullGitObjectId } from '../../ipc/filesystem-path-containment'

const HISTORY_OUTPUT_LIMIT = 8 * 1024 * 1024
const HISTORY_TIMEOUT_MS = 15_000

/** Reads history lazily and offline; no fetch, clone or external diff is allowed. */
function createHistoryExecutor(options: GitRuntimeOptions): GitHistoryExecutor {
  return async (args, cwd) => {
    const { stdout } = await gitExecFileAsync(args, {
      ...gitReadOptionsForWorktree(cwd, options),
      env: {
        ...gitOptionalLocksDisabledEnv(),
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: ''
      },
      maxBuffer: HISTORY_OUTPUT_LIMIT,
      timeout: HISTORY_TIMEOUT_MS
    })
    return { stdout }
  }
}

function historyReadError(error: unknown): Error {
  if (error instanceof GitHistoryReadError) {
    const category =
      error.reason === 'unavailable'
        ? 'unavailable'
        : error.reason === 'limit'
          ? 'limit'
          : error.reason === 'git-error'
            ? 'git-error'
            : 'access-denied'
    return new GitWorkspaceReadError(category, error.message)
  }
  if (error instanceof GitWorkspaceReadError) {
    return error
  }
  const message = error instanceof Error ? error.message : 'Git history could not be read'
  if (/maxBuffer|buffer.*exceed/i.test(message)) {
    return new GitWorkspaceReadError('limit', 'Git history exceeds the bounded output limit.')
  }
  return new GitWorkspaceReadError('git-error', message)
}

/**
 * Single host entry point for history reads. A host-issued `contextId` selects an
 * authorized checkout after a fresh discovery pass; without one the root worktree is
 * read exactly like the legacy history path, which keeps existing callers working.
 */
export async function getWorkspaceHistory(
  root: string,
  options: GitHistoryOptions & GetStatusOptions = {}
): Promise<GitHistoryResult> {
  let checkout = root
  if (options.contextId) {
    const { repository } = await readAuthorizedGitContext(root, options.contextId, options)
    checkout = repository.context.checkoutPath
  }
  try {
    return await loadGitHistoryFromExecutor(createHistoryExecutor(options), checkout, options)
  } catch (error) {
    throw historyReadError(error)
  }
}

/**
 * Lists commit changes for the selected context. The optional base revision is the
 * user's explicit comparison choice (a merge parent or any other commit); it is
 * resolved as a local commit and never fetched.
 */
export async function getWorkspaceCommitCompare(
  root: string,
  request: { contextId?: string; commitOid: string; baseOid?: string | null },
  options: GetStatusOptions = {}
): Promise<GitCommitCompareResult> {
  const commitOid = validateFullGitObjectId(request.commitOid, 'commitOid')
  let checkout = root
  if (request.contextId) {
    const { repository } = await readAuthorizedGitContext(root, request.contextId, options)
    checkout = repository.context.checkoutPath
  }
  return getCommitCompare(checkout, commitOid, options, request.baseOid ?? null)
}

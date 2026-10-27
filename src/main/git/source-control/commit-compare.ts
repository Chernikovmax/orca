import type { GitCommitCompareResult } from '../../../shared/git-diff-compare-types'
import { parseGitRevListFirstParentOid } from '../../../shared/git-rev-list-output'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { loadCommitChanges } from './branch-change-entries'
import { resolveRefOid } from './compare-ref-oids'

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

/**
 * Lists one commit's changed files. `explicitBase` is a caller-chosen comparison
 * revision (a merge parent or any other commit); when absent the first parent is
 * the base, and a root commit is compared against the empty tree.
 */
export async function getCommitCompare(
  worktreePath: string,
  commitId: string,
  options: GitRuntimeOptions = {},
  explicitBase?: string | null
): Promise<GitCommitCompareResult> {
  let commitOid = ''
  try {
    commitOid = await resolveRefOid(worktreePath, `${commitId}^{commit}`, options)
  } catch {
    return {
      summary: {
        commitOid: '',
        parentOid: null,
        compareRef: commitId,
        baseRef: 'parent',
        changedFiles: 0,
        status: 'invalid-commit',
        errorMessage: `Commit ${commitId} could not be resolved in this repository.`
      },
      entries: []
    }
  }

  const summary = {
    commitOid,
    parentOid: null as string | null,
    compareRef: commitOid.slice(0, 7),
    baseRef: 'empty tree',
    changedFiles: 0,
    status: 'ready' as const
  }

  if (explicitBase) {
    if (!FULL_OID.test(explicitBase)) {
      return {
        summary: {
          ...summary,
          status: 'invalid-base' as const,
          errorMessage: 'A comparison revision must be a full commit object id.'
        },
        entries: []
      }
    }
    try {
      summary.parentOid = await resolveRefOid(worktreePath, `${explicitBase}^{commit}`, options)
      summary.baseRef = explicitBase.slice(0, 7)
    } catch {
      return {
        summary: {
          ...summary,
          status: 'invalid-base' as const,
          errorMessage: `Comparison commit ${explicitBase} is not available locally; no fetch was attempted.`
        },
        entries: []
      }
    }
  }

  try {
    if (!explicitBase) {
      const { stdout } = await gitExecFileAsync(
        ['rev-list', '--parents', '-n', '1', commitOid],
        gitOptionsForWorktree(worktreePath, options)
      )
      const firstParent = parseGitRevListFirstParentOid(stdout)
      summary.parentOid = firstParent
      summary.baseRef = firstParent ? firstParent.slice(0, 7) : 'empty tree'
    }

    const entries = await loadCommitChanges(worktreePath, summary.parentOid, commitOid, options)
    summary.changedFiles = entries.length
    return { summary, entries }
  } catch (error) {
    return {
      summary: {
        ...summary,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to load commit diff'
      },
      entries: []
    }
  }
}

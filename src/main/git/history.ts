import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { GitRuntimeOptions } from './git-runtime-options'
import { getWorkspaceHistory } from './source-control/git-workspace-history'

/**
 * The main-process history entry point. It delegates to the single bounded reader
 * and adds host-authorized Git context resolution when `contextId` is present.
 */
export async function getHistory(
  worktreePath: string,
  options: GitHistoryOptions & GitRuntimeOptions = {}
): Promise<GitHistoryResult> {
  return getWorkspaceHistory(worktreePath, options)
}

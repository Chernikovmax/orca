import { ipcMain } from 'electron'
import type {
  GitBranchCompareResult,
  GitCommitCompareResult
} from '../../../../shared/git-diff-compare-types'
import { getBranchCompare } from '../../../git/status'
import { getWorkspaceCommitCompare } from '../../../git/source-control/git-workspace-history'
import { resolveRegisteredWorktreePath } from '../../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../../local-worktree-runtime-options'
import { validateFullGitObjectId } from '../../filesystem-path-containment'
import type { FilesystemHandlerContext } from '../filesystem-handler-context'
import type { GitAdmissionTier } from '../../../git/command-runner/git-exec-options'
import { requireReachableGitRoute } from '../../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export function registerGitRemoteCompareHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'git:branchCompare',
    async (
      _event,
      args: {
        worktreePath: string
        baseRef: string
        connectionId?: string
        admissionTier?: GitAdmissionTier
      }
    ): Promise<GitBranchCompareResult> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getBranchCompare(worktreePath, args.baseRef, {
        ...gitOptions,
        ...(args.admissionTier ? { admissionTier: args.admissionTier } : {})
      })
    }
  )

  ipcMain.handle(
    'git:commitCompare',
    async (
      _event,
      args: {
        worktreePath: string
        commitId: string
        contextId?: string
        baseOid?: string | null
        connectionId?: string
      }
    ): Promise<GitCommitCompareResult> => {
      const commitId = validateFullGitObjectId(args.commitId, 'commitId')
      const baseOid =
        args.baseOid === undefined || args.baseOid === null
          ? undefined
          : validateFullGitObjectId(args.baseOid, 'baseOid')
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getWorkspaceCommitCompare(
        worktreePath,
        { contextId: args.contextId, commitOid: commitId, baseOid },
        gitOptions
      )
    }
  )
}

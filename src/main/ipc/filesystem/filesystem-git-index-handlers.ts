import { ipcMain } from 'electron'
import {
  stageFile,
  unstageFile,
  discardChanges,
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  stageWorktreeChanges
} from '../../git/status'
import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import { mutateGitWorkspace } from '../../git/source-control/git-workspace-mutation'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import {
  getLocalGitOptionsForRegisteredWorktree,
  getLocalRepoForRegisteredWorktree
} from '../local-worktree-runtime-options'
import { getWorktreeSharedLinkPaths } from '../../git/worktree-shared-directories'
import { validateGitRelativeFilePath } from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { parseGitStageWorktreeScope } from '../../../shared/git-stage-worktree-scope'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitIndexHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:mutate',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string } & GitWorkspaceMutationRequest
    ): Promise<GitMutationReceipt> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath =
        args.filePath === undefined
          ? undefined
          : validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath =
        args.oldPath === undefined
          ? undefined
          : validateGitRelativeFilePath(worktreePath, args.oldPath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
      return mutateGitWorkspace(
        worktreePath,
        {
          ...args,
          ...(filePath === undefined ? {} : { filePath }),
          ...(oldPath === undefined ? {} : { oldPath })
        },
        {
          ...gitOptions,
          admissionTier: 'interactive',
          ...(repo ? { sharedLinkPaths: getWorktreeSharedLinkPaths(repo) } : {})
        }
      )
    }
  )
  ipcMain.handle(
    'git:stage',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await stageFile(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await unstageFile(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:discard',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await discardChanges(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:bulkDiscard',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkDiscardChanges(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:bulkStage',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string; scope?: unknown }
    ): Promise<void> => {
      const scope = parseGitStageWorktreeScope(args.scope)
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (scope) {
        const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
        await stageWorktreeChanges(worktreePath, scope, {
          ...gitOptions,
          admissionTier: 'interactive',
          sharedLinkPaths: repo ? getWorktreeSharedLinkPaths(repo) : []
        })
        return
      }
      await bulkStageFiles(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:bulkUnstage',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkUnstageFiles(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}

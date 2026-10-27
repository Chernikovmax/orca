import type {
  GitStageWorktreeScope,
  GitStageWorktreeScopeReceipt
} from '../../shared/git-stage-worktree-scope'
import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../shared/git-workspace-mutation'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { mutateGitWorkspace } from '../git/source-control/git-workspace-mutation'
import {
  localGitOptionsForTarget,
  normalizeRuntimeGitRelativePath,
  requireLocalRuntimeGitRoute,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitStagingCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  /**
   * The single runtime entry point for workspace writes: authorization, freshness
   * fences, the common-git-dir queue and outcomes all live in the host service.
   */
  async mutateRuntimeGitWorkspace(
    worktreeSelector: string,
    request: GitWorkspaceMutationRequest,
    signal?: AbortSignal
  ): Promise<GitMutationReceipt> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    requireLocalRuntimeGitRoute(target)
    return mutateGitWorkspace(target.worktree.path, request, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive',
      ...(signal ? { signal } : {}),
      ...(target.repo ? { sharedLinkPaths: getWorktreeSharedLinkPaths(target.repo) } : {})
    })
  }

  async stageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const receipt = await this.mutateRuntimeGitWorkspace(worktreeSelector, {
      action: 'stage',
      filePath: relativePath
    })
    if (receipt.outcome !== 'succeeded') {
      throw new Error(receipt.error ?? 'Git stage failed')
    }
    return { ok: true }
  }

  async unstageRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    const receipt = await this.mutateRuntimeGitWorkspace(worktreeSelector, {
      action: 'unstage',
      filePath: relativePath
    })
    if (receipt.outcome !== 'succeeded') {
      throw new Error(receipt.error ?? 'Git unstage failed')
    }
    return { ok: true }
  }

  async bulkStageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[],
    scope?: GitStageWorktreeScope
  ): Promise<{ ok: true } & Partial<GitStageWorktreeScopeReceipt>> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    // Why: every provider throws when its host did not run the scoped stage, so success is a receipt.
    await requireRuntimeGitProvider(target).bulkStageFiles(
      target.worktree.path,
      relativePaths,
      scope
    )
    return scope ? { ok: true, stagedScope: scope } : { ok: true }
  }

  async bulkUnstageRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    await requireRuntimeGitProvider(target).bulkUnstageFiles(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async bulkDiscardRuntimeGitPaths(
    worktreeSelector: string,
    filePaths: string[]
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePaths = filePaths.map((path) => normalizeRuntimeGitRelativePath(path))
    await requireRuntimeGitProvider(target).bulkDiscardChanges(target.worktree.path, relativePaths)
    return { ok: true }
  }

  async discardRuntimeGitPath(worktreeSelector: string, filePath: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const relativePath = normalizeRuntimeGitRelativePath(filePath)
    await requireRuntimeGitProvider(target).discardChanges(target.worktree.path, relativePath)
    return { ok: true }
  }
}

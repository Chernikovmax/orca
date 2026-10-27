import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest,
  GitWorkspaceOperationReceipt
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { GitMutationError } from './git-workspace-mutation-error'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'
import {
  assertValidBranchRefFormat,
  localRefExists,
  readCurrentBranch,
  readHead,
  resolveLocalCommit,
  validateNewBranchName,
  validateWorkspaceRefName
} from './git-workspace-branch-refs'
import {
  assertBranchNotCheckedOutElsewhere,
  assertCheckoutKeepsLocalChanges,
  assertNoUnfinishedOperation,
  readRemoteNames,
  splitRemoteBranch
} from './git-workspace-branch-guards'

function checkoutOperation(
  refName: string,
  targetOid: string,
  branch: string | undefined
): GitWorkspaceOperationReceipt {
  return {
    kind: 'checkout',
    refName,
    oid: targetOid,
    ...(branch ? { branch } : {}),
    detached: branch === undefined,
    completed: true,
    conflicts: false
  }
}

async function runCheckout(
  workspace: ResolvedWorkspace,
  args: string[],
  targetOid: string,
  branch: string | undefined,
  options: GetStatusOptions
): Promise<void> {
  await gitExecFileAsync(args, {
    ...gitOptionsForWorktree(workspace.context.checkoutPath, options),
    admissionTier: 'interactive',
    timeout: 120_000
  })
  const head = await readHead(workspace, options)
  if (head !== targetOid) {
    throw new GitMutationError(
      'git-error',
      'Git reported a checkout, but HEAD does not match the requested revision; verify the real state'
    )
  }
  const current = await readCurrentBranch(workspace, options)
  if (current !== branch) {
    throw new GitMutationError(
      'git-error',
      'Git reported a checkout, but the current branch does not match the request; verify the real state'
    )
  }
}

/**
 * Checkout is a separate, explicit action from browsing a context or a ref.
 * It reuses the authorized workspace and runs inside the common-git-dir queue.
 */
export async function checkoutImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository } = workspace
  const refName = validateWorkspaceRefName(request.refName)
  assertNoUnfinishedOperation(repository)
  if (refName.startsWith('refs/heads/') && repository.branch === refName) {
    throw new GitMutationError('invalid', 'This branch is already checked out in this worktree')
  }
  const targetOid = await resolveLocalCommit(workspace, refName, options)
  let args: string[]
  let branch: string | undefined
  if (refName.startsWith('refs/heads/')) {
    await assertBranchNotCheckedOutElsewhere(workspace, refName, options)
    await assertCheckoutKeepsLocalChanges(workspace, targetOid, options)
    branch = refName
    args = ['checkout', refName.slice('refs/heads/'.length), '--']
  } else if (refName.startsWith('refs/remotes/')) {
    const remotes = await readRemoteNames(workspace, options)
    const remoteBranch = splitRemoteBranch(refName, remotes)
    branch = `refs/heads/${remoteBranch.branch}`
    if (await localRefExists(workspace, branch, options)) {
      throw new GitMutationError(
        'invalid',
        `A local branch ${remoteBranch.branch} already exists; check it out by name instead`
      )
    }
    await assertValidBranchRefFormat(workspace, remoteBranch.branch, options)
    await assertCheckoutKeepsLocalChanges(workspace, targetOid, options)
    args = ['checkout', '-b', remoteBranch.branch, '--track', refName, '--']
  } else {
    await assertCheckoutKeepsLocalChanges(workspace, targetOid, options)
    branch = undefined
    args = ['checkout', '--detach', targetOid, '--']
  }
  await runCheckout(workspace, args, targetOid, branch, options)
  return {
    action: 'checkout',
    outcome: 'succeeded',
    contextId: repository.context.id,
    operation: checkoutOperation(refName, targetOid, branch)
  }
}

/** New Branch always creates and checks out the named local branch explicitly. */
export async function createBranchImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository } = workspace
  assertNoUnfinishedOperation(repository)
  const name = validateNewBranchName(request.branch)
  await assertValidBranchRefFormat(workspace, name, options)
  const branchRef = `refs/heads/${name}`
  if (await localRefExists(workspace, branchRef, options)) {
    throw new GitMutationError('invalid', `Branch ${name} already exists`)
  }
  const rawStart = typeof request.startRef === 'string' ? request.startRef.trim() : ''
  const startRef = rawStart && rawStart !== 'HEAD' ? validateWorkspaceRefName(rawStart) : 'HEAD'
  const targetOid = await resolveLocalCommit(workspace, startRef, options)
  await assertCheckoutKeepsLocalChanges(workspace, targetOid, options)
  const args = startRef.startsWith('refs/remotes/')
    ? ['checkout', '-b', name, '--track', startRef, '--']
    : ['checkout', '-b', name, targetOid, '--']
  await runCheckout(workspace, args, targetOid, branchRef, options)
  return {
    action: 'createBranch',
    outcome: 'succeeded',
    contextId: repository.context.id,
    operation: {
      kind: 'createBranch',
      refName: branchRef,
      oid: targetOid,
      branch: branchRef,
      detached: false,
      completed: true,
      conflicts: false
    }
  }
}

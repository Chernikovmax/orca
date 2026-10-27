import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GitWorkspaceBatchStepResult } from '../../../shared/git-workspace-batch'
import type { GetStatusOptions } from './get-status-options'
import type { BatchState } from './git-workspace-batch-state'
import { GitMutationError } from './git-workspace-mutation-error'
import { workspaceGitRead } from './git-workspace-discovery'
import { remoteEndpoints } from './git-workspace-batch-runtime'
import { resolveRelativeUrl } from './git-submodule-url'

function comparableUrl(value: string): string {
  const local = value.startsWith('file://') ? fileURLToPath(value) : value
  return path.isAbsolute(local) ? path.normalize(local) : value.replace(/\/+$/, '')
}

export async function assertPublishedChildDestination(
  state: BatchState,
  step: GitWorkspaceBatchStepResult,
  childDestination: string,
  options: GetStatusOptions
): Promise<void> {
  const parentId = step.parentContextId
  const parent = parentId ? state.identities.get(parentId) : undefined
  const target = parentId ? state.publication.get(parentId) : undefined
  const parentHead = parentId ? state.committedOids.get(parentId) : undefined
  const module = state.lastWorkspace?.submodules.find(
    (entry) => entry.parentContextId === parentId && entry.contextId === step.childContextId
  )
  const parentPath = state.lastWorkspace?.submodules.find(
    (entry) => entry.contextId === parentId
  )?.path
  if (!parent || !target || !parentHead || !module) {
    throw new GitMutationError(
      'incomplete',
      'The parent publication tree cannot identify its child destination'
    )
  }
  const childPath = parentPath ? module.path.slice(parentPath.length + 1) : module.path
  const gitlink = (
    await workspaceGitRead(
      parent.checkoutPath,
      ['ls-tree', '-z', parentHead, '--', childPath],
      options
    )
  )
    .split('\0')
    .filter(Boolean)
  if (gitlink.length !== 1 || gitlink[0] !== `160000 commit ${step.childOid}\t${childPath}`) {
    throw new GitMutationError(
      'stale',
      'The published parent does not record the reviewed child commit; confirm and commit its gitlink first'
    )
  }
  const records = (
    await workspaceGitRead(
      parent.checkoutPath,
      [
        'config',
        '--blob',
        `${parentHead}:.gitmodules`,
        '-z',
        '--get-regexp',
        '^submodule\\..*\\.path$'
      ],
      options
    )
  )
    .split('\0')
    .filter(Boolean)
  const matching = records.filter((record) => record.slice(record.indexOf('\n') + 1) === childPath)
  if (matching.length !== 1) {
    throw new GitMutationError(
      'incomplete',
      'The published parent has no unique declaration for this child path'
    )
  }
  const key = matching[0].slice(0, matching[0].indexOf('\n')).replace(/\.path$/, '.url')
  const declared = (
    await workspaceGitRead(
      parent.checkoutPath,
      ['config', '--blob', `${parentHead}:.gitmodules`, '--get', key],
      options
    )
  ).trim()
  const parentEndpoints = await remoteEndpoints(parent.checkoutPath, target.remote, options)
  if (parentEndpoints.push.length !== 1) {
    throw new GitMutationError(
      'incomplete',
      'Relative child URLs require one unambiguous parent publication destination'
    )
  }
  const resolved = resolveRelativeUrl(declared, parentEndpoints.push[0])
  if (comparableUrl(resolved) !== comparableUrl(childDestination)) {
    throw new GitMutationError(
      'incomplete',
      'The child publication destination differs from the URL recorded in the published parent. Review .gitmodules and the selected remotes before publishing the parent.'
    )
  }
}

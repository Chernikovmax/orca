import type {
  GitMutationNetworkAction,
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import {
  GIT_AUTHENTICATION_FAILED_MESSAGE,
  normalizeGitErrorMessage,
  stripCredentialsFromMessage
} from '../../../shared/git-remote-error'
import type { GetStatusOptions } from './get-status-options'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { FULL_OID, type ResolvedWorkspace } from './git-workspace-mutation-shared'
import {
  resolveLocalCommit,
  safeGitMessage,
  validateWorkspaceRefName
} from './git-workspace-branch-refs'
import { readRemoteNames, requireRemoteName } from './git-workspace-branch-guards'
import {
  createWorkspaceNetworkProgressReader,
  publishGitWorkspaceProgress
} from './git-workspace-progress'

export const NETWORK_TIMEOUT_MS = 300_000
const PROGRESS_ID = /^[A-Za-z0-9_-]{8,64}$/

const AUTH_FAILURE =
  /could not read Username|could not read Password|Authentication failed|terminal prompts disabled|permission denied \(publickey\)|host key verification failed|repository not found|invalid username or password|fatal: unable to get password from user/i
const UNKNOWN_NETWORK =
  /connection reset|remote end hung up|unexpected disconnect|early eof|rpc failed|timed out|timeout|aborted|killed|broken pipe|ssl.*unexpected/i
const KNOWN_NETWORK =
  /could not resolve host|connection refused|network is unreachable|no route to host|failed to connect|unable to access|could not resolve proxy/i

function progressPublisher(
  request: GitWorkspaceMutationRequest,
  contextId: string,
  operation: GitMutationNetworkAction
): {
  start: (phase: string) => void
  record: (phase: string, record: { percent: number; completed: number; total: number }) => void
  done: () => void
} {
  const progressId = request.progressId
  if (!progressId || !PROGRESS_ID.test(progressId)) {
    return { start: () => {}, record: () => {}, done: () => {} }
  }
  let lastPercent = -1
  let lastPhase = ''
  const publish = (
    phase: string,
    extra: { percent?: number; completed?: number; total?: number; done: boolean }
  ) =>
    publishGitWorkspaceProgress({
      progressId,
      contextId,
      operation,
      phase,
      done: extra.done,
      ...(extra.percent === undefined ? {} : { percent: extra.percent }),
      ...(extra.completed === undefined ? {} : { completed: extra.completed }),
      ...(extra.total === undefined ? {} : { total: extra.total })
    })
  return {
    start: (phase) => publish(phase, { done: false }),
    record: (phase, record) => {
      // Why: Git redraws far faster than a human reads; one frame per changed
      // percentage keeps the transport bounded without hiding progress.
      if (phase === lastPhase && record.percent === lastPercent) {
        return
      }
      lastPhase = phase
      lastPercent = record.percent
      publish(phase, {
        percent: record.percent,
        completed: record.completed,
        total: record.total,
        done: false
      })
    },
    done: () => publish('done', { percent: 100, done: true })
  }
}

function classifyNetworkFailure(error: unknown, operation: 'fetch' | 'push'): GitMutationError {
  const raw = safeGitMessage(error)
  const text = stripCredentialsFromMessage(raw)
  if (AUTH_FAILURE.test(text)) {
    return new GitMutationError('authentication', GIT_AUTHENTICATION_FAILED_MESSAGE)
  }
  if (UNKNOWN_NETWORK.test(text)) {
    return new GitMutationError(
      'unknown-outcome',
      `${operation === 'push' ? 'Push' : 'Fetch'} was interrupted before Git reported a result. The remote may or may not have changed; verify the real refs before retrying. Nothing is retried automatically.\n${normalizeGitErrorMessage(new Error(text), operation)}`,
      { unknownOutcome: true }
    )
  }
  if (KNOWN_NETWORK.test(text)) {
    return new GitMutationError('network', normalizeGitErrorMessage(new Error(text), operation))
  }
  if (
    operation === 'push' &&
    /non-fast-forward|fetch first|\[rejected\]|updates were rejected|remote contains work/i.test(
      text
    )
  ) {
    return new GitMutationError(
      'rejected',
      `Push rejected: the remote has commits this checkout does not have. Fetch and integrate them explicitly; Orca does not force-push or retry automatically.\n${normalizeGitErrorMessage(new Error(text), 'push')}`
    )
  }
  if (operation === 'fetch' && /couldn't find remote ref|no such remote ref/i.test(text)) {
    return new GitMutationError('invalid', normalizeGitErrorMessage(new Error(text), 'fetch'))
  }
  if (/index\.lock|Unable to create .*\.lock|Another git process/i.test(text)) {
    return new GitMutationError('busy', normalizeGitErrorMessage(error, operation))
  }
  return new GitMutationError('git-error', normalizeGitErrorMessage(error, operation))
}

function validateFetchBranch(raw: unknown): string | undefined {
  if (raw === undefined || raw === '') {
    return undefined
  }
  if (
    typeof raw !== 'string' ||
    raw.length > 200 ||
    raw.startsWith('-') ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    raw.includes('..') ||
    raw.includes('@{') ||
    /[\p{Cc}\s~^:?*[\]\\]/u.test(raw)
  ) {
    throw new GitMutationError('invalid', 'A valid remote branch name is required')
  }
  return raw
}

/** One explicit fetch of a named remote (optionally a single branch). */
export async function fetchImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const remotes = await readRemoteNames(workspace, options)
  const remote = requireRemoteName(request.remote, remotes)
  const branch = validateFetchBranch(request.branch)
  const progress = progressPublisher(request, workspace.repository.context.id, 'fetch')
  const readProgress = createWorkspaceNetworkProgressReader('fetch', progress.record)
  progress.start('connecting')
  try {
    await gitExecFileAsync(
      [
        'fetch',
        '--progress',
        '--prune',
        '--no-recurse-submodules',
        remote,
        ...(branch ? [branch] : [])
      ],
      {
        ...gitOptionsForWorktree(workspace.context.checkoutPath, options),
        admissionTier: 'interactive',
        timeout: NETWORK_TIMEOUT_MS,
        onStderr: readProgress
      }
    )
  } catch (error) {
    throw classifyNetworkFailure(error, 'fetch')
  } finally {
    progress.done()
  }
  return {
    action: 'fetch',
    outcome: 'succeeded',
    contextId: workspace.repository.context.id,
    operation: {
      kind: 'fetch',
      remote,
      ...(branch ? { refName: `refs/remotes/${remote}/${branch}` } : {}),
      completed: true,
      conflicts: false
    }
  }
}

/** One explicit non-forced push of a reviewed local branch to a named remote. */
export async function pushImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository } = workspace
  const remotes = await readRemoteNames(workspace, options)
  const remote = requireRemoteName(request.remote, remotes)
  const refName = validateWorkspaceRefName(request.refName)
  if (!refName.startsWith('refs/heads/')) {
    throw new GitMutationError('invalid', 'Only a local branch can be pushed')
  }
  const expected = request.expectedRefOid
  if (typeof expected !== 'string' || !FULL_OID.test(expected)) {
    throw new GitMutationError(
      'invalid',
      'The reviewed branch object id is required before pushing'
    )
  }
  const currentOid = await resolveLocalCommit(workspace, refName, options)
  const head = repository.head
  if (currentOid !== expected || (repository.branch === refName && head !== expected)) {
    throw new GitMutationError(
      'stale',
      'The branch moved since it was reviewed; refresh the refs before pushing'
    )
  }
  const progress = progressPublisher(request, repository.context.id, 'push')
  const readProgress = createWorkspaceNetworkProgressReader('push', progress.record)
  progress.start('connecting')
  try {
    await gitExecFileAsync(
      [
        'push',
        '--progress',
        '--no-recurse-submodules',
        ...(request.setUpstream === true ? ['--set-upstream'] : []),
        remote,
        `${refName}:${refName}`
      ],
      {
        ...gitOptionsForWorktree(workspace.context.checkoutPath, options),
        admissionTier: 'interactive',
        timeout: NETWORK_TIMEOUT_MS,
        onStderr: readProgress
      }
    )
  } catch (error) {
    throw classifyNetworkFailure(error, 'push')
  } finally {
    progress.done()
  }
  return {
    action: 'push',
    outcome: 'succeeded',
    contextId: repository.context.id,
    operation: {
      kind: 'push',
      remote,
      refName,
      oid: currentOid,
      completed: true,
      conflicts: false
    }
  }
}

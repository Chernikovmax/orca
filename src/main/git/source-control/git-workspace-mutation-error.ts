import type {
  GitMutationErrorCategory,
  GitWorkspaceMutationRequest,
  GitWorkspaceOperationReceipt
} from '../../../shared/git-workspace-mutation'
import type { RepositoryState } from '../../../shared/git-workspace-types'

/** A categorized, user-facing refusal from the Git mutation service. */
export class GitMutationError extends Error {
  readonly unknownOutcome: boolean

  constructor(
    readonly category: GitMutationErrorCategory,
    message: string,
    options: { unknownOutcome?: boolean } = {}
  ) {
    super(message)
    this.name = 'GitMutationError'
    this.unknownOutcome = options.unknownOutcome === true
  }
}

function textOf(error: unknown): string {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
    const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : ''
    if (stderr) {
      return stderr
    }
    if (stdout) {
      return stdout
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Classifies a real Git failure without hiding it. Hook and signing messages come
 * from Git itself and are shown to the user unchanged.
 */
export function classifyMutationError(error: unknown): {
  category: GitMutationErrorCategory
  message: string
} {
  if (error instanceof GitMutationError) {
    return { category: error.category, message: error.message }
  }
  const message = textOf(error)
  if (
    /index\.lock|Unable to create .*\.lock|File exists.*\.lock|Another git process/i.test(message)
  ) {
    return { category: 'busy', message }
  }
  if (/gpg|signing failed|gpg failed to sign|secret key not available/i.test(message)) {
    return { category: 'signing', message }
  }
  if (/hook|husky|pre-commit|commit-msg|pre-merge-commit/i.test(message)) {
    return { category: 'hook', message }
  }
  if (/pathspec|did not match any file/i.test(message)) {
    return { category: 'invalid', message }
  }
  return { category: 'git-error', message }
}

/** True when the process may already have changed the repository before dying. */
export function isUnknownOutcome(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof GitMutationError && error.unknownOutcome) {
    return true
  }
  if (signal?.aborted) {
    return true
  }
  if (!error || typeof error !== 'object') {
    return false
  }
  const record = error as Record<string, unknown>
  return (
    record.killed === true ||
    record.code === 'ABORT_ERR' ||
    record.code === 'ETIMEDOUT' ||
    record.name === 'GitCommandTimeoutError' ||
    record.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  )
}

export function failedOperation(
  request: GitWorkspaceMutationRequest,
  repository: RepositoryState | undefined
): GitWorkspaceOperationReceipt | undefined {
  const conflicts = repository?.conflicted === true
  switch (request.action) {
    case 'checkout':
      return { kind: 'checkout', completed: false, conflicts }
    case 'createBranch':
      return { kind: 'createBranch', completed: false, conflicts }
    case 'fetch':
      return { kind: 'fetch', completed: false, conflicts }
    case 'push':
      return { kind: 'push', completed: false, conflicts }
    case 'merge':
      return { kind: 'merge', completed: false, conflicts }
    case 'rebase':
      return { kind: 'rebase', completed: false, conflicts }
    case 'continueOperation':
      return { kind: 'continue', completed: false, conflicts }
    case 'abortOperation':
      return { kind: 'abort', completed: false, conflicts }
    default:
      return undefined
  }
}

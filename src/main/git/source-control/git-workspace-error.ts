import type { GitContextError } from '../../../shared/git-workspace-types'

export class GitWorkspaceReadError extends Error {
  constructor(
    readonly category: GitContextError['category'],
    message: string
  ) {
    super(message)
  }
}

export function workspaceReadError(error: unknown): GitContextError {
  if (error instanceof GitWorkspaceReadError) {
    return { category: error.category, message: error.message }
  }
  // Git diagnostics may contain credentials from repository configuration.
  return {
    category: 'git-error',
    message: 'Git context could not be read; refresh after checking its local metadata and objects.'
  }
}

export function redactUrl(raw: string): string {
  return raw.replace(/(\/\/)[^/@]*@/g, '$1[redacted]@').replace(/[?#].*$/, '')
}

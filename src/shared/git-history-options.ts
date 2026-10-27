import { GIT_HISTORY_MAX_OFFSET, type GitHistoryCursor, type GitHistoryOptions } from './git-history-types'

const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const MESSAGE_FILTER_LIMIT = 200

/**
 * A history read failed for a reason the UI must show verbatim. `unavailable`
 * means an object is missing locally; it never implies a fetch was attempted.
 */
export class GitHistoryReadError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'invalid-input' | 'limit' | 'git-error',
    message: string
  ) {
    super(message)
    this.name = 'GitHistoryReadError'
  }
}

/**
 * Equality token for one pinned walk. The browsed ref name is deliberately
 * absent: continuation pages may omit it, while the tip OID still identifies
 * exactly which commits were walked. A different tip or filter set must never
 * be appended to this history.
 */
export function gitHistoryGeneration(options: GitHistoryOptions, tipOid: string): string {
  return JSON.stringify([
    options.contextId ?? '',
    tipOid,
    options.path ?? '',
    options.message ?? ''
  ])
}

export function validateHistoryCursor(cursor: GitHistoryCursor | undefined): GitHistoryCursor | undefined {
  if (!cursor) {
    return undefined
  }
  if (!FULL_OID_PATTERN.test(cursor.tipOid)) {
    throw new GitHistoryReadError(
      'invalid-input',
      'A pinned history requires the full commit id of its first page.'
    )
  }
  if (
    !Number.isInteger(cursor.offset) ||
    cursor.offset < 0 ||
    cursor.offset > GIT_HISTORY_MAX_OFFSET
  ) {
    throw new GitHistoryReadError(
      'limit',
      `History pages stop after ${GIT_HISTORY_MAX_OFFSET} loaded commits; narrow the filters to continue.`
    )
  }
  return { tipOid: cursor.tipOid, offset: cursor.offset }
}

export function validateHistoryPath(value: string): string {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new GitHistoryReadError('invalid-input', 'Invalid path filter for Git history.')
  }
  return value
}

export function validateMessageFilter(value: string): string {
  if (value.includes('\0') || value.length > MESSAGE_FILTER_LIMIT) {
    throw new GitHistoryReadError(
      'invalid-input',
      `Commit message filters are limited to ${MESSAGE_FILTER_LIMIT} characters.`
    )
  }
  return value
}

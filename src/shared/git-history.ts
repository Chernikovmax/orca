import { GIT_HISTORY_COMMIT_FORMAT, parseGitHistoryLog, shortGitHash } from './git-history-log-parser'
import {
  resolveHistoryCommit,
  resolveHistoryCurrentRef,
  resolveHistoryNamedRef,
  resolveHistoryUpstreamRef
} from './git-history-refs'
import { GitHistoryReadError, gitHistoryGeneration, validateHistoryCursor, validateHistoryPath, validateMessageFilter } from './git-history-options'
import {
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  type GitHistoryExecutor,
  type GitHistoryItemRef,
  type GitHistoryOptions,
  type GitHistoryResult
} from './git-history-types'

export type {
  GitHistoryCursor,
  GitHistoryExecutor,
  GitHistoryGraphColorId,
  GitHistoryItem,
  GitHistoryItemRef,
  GitHistoryItemStatistics,
  GitHistoryOptions,
  GitHistoryRefCategory,
  GitHistoryResult
} from './git-history-types'
export {
  GIT_HISTORY_BASE_REF_COLOR,
  GIT_HISTORY_DEFAULT_LIMIT,
  GIT_HISTORY_LANE_COLORS,
  GIT_HISTORY_MAX_LIMIT,
  GIT_HISTORY_MAX_OFFSET,
  GIT_HISTORY_REF_COLOR,
  GIT_HISTORY_REMOTE_REF_COLOR
} from './git-history-types'
export { compareGitHistoryItemRefsByCategory, parseGitHistoryLog } from './git-history-log-parser'
export { GitHistoryReadError } from './git-history-options'

function clampHistoryLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return GIT_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(
    GIT_HISTORY_MAX_LIMIT,
    Math.max(1, Math.trunc(limit ?? GIT_HISTORY_DEFAULT_LIMIT))
  )
}

export async function loadGitHistoryFromExecutor(
  git: GitHistoryExecutor,
  cwd: string,
  options: GitHistoryOptions = {}
): Promise<GitHistoryResult> {
  const limit = clampHistoryLimit(options.limit)
  const cursor = validateHistoryCursor(options.cursor)
  const revision = options.revision?.trim() || null
  const pathFilter = options.path ? validateHistoryPath(options.path) : null
  const messageFilter = options.message?.trim() ? validateMessageFilter(options.message.trim()) : null
  const headOid = await resolveHistoryCommit(git, cwd, 'HEAD')

  if (!cursor && !revision && !headOid) {
    return {
      items: [],
      hasIncomingChanges: false,
      hasOutgoingChanges: false,
      hasMore: false,
      limit,
      generation: gitHistoryGeneration(options, ''),
      tipOid: '',
      empty: true
    }
  }

  let tipOid: string
  let browsedRef: GitHistoryItemRef | undefined
  if (cursor) {
    const pinned = await resolveHistoryCommit(git, cwd, cursor.tipOid)
    if (!pinned) {
      throw new GitHistoryReadError(
        'unavailable',
        `Commit ${cursor.tipOid} is not available locally; no fetch was attempted.`
      )
    }
    tipOid = pinned
  } else if (revision) {
    const resolved = await resolveHistoryCommit(git, cwd, revision)
    if (!resolved) {
      throw new GitHistoryReadError(
        'unavailable',
        `Revision ${revision} is not available locally; no fetch was attempted.`
      )
    }
    tipOid = resolved
    if (revision.toUpperCase() !== 'HEAD') {
      browsedRef = (await resolveHistoryNamedRef(git, cwd, revision)) ?? {
        id: tipOid,
        name: shortGitHash(tipOid),
        revision: tipOid,
        category: 'commits'
      }
    }
  } else {
    tipOid = headOid!
  }

  let currentRef: GitHistoryItemRef
  let branchName: string | null = null
  if (headOid) {
    const resolved = await resolveHistoryCurrentRef(git, cwd, headOid)
    currentRef = resolved.currentRef
    branchName = resolved.branchName
  } else {
    currentRef = browsedRef ?? {
      id: tipOid,
      name: shortGitHash(tipOid),
      revision: tipOid,
      category: 'commits'
    }
  }

  // Why: a continuation page must not re-resolve upstream/base, because those refs
  // may have moved after the first page was pinned.
  const [remoteRef, rawBaseRef] =
    cursor === undefined
      ? await Promise.all([
          resolveHistoryUpstreamRef(git, cwd, branchName),
          resolveHistoryNamedRef(git, cwd, options.baseRef)
        ])
      : [undefined, undefined]

  const baseRef =
    rawBaseRef && rawBaseRef.id !== remoteRef?.id && rawBaseRef.id !== currentRef.id
      ? rawBaseRef
      : undefined

  // Why: incoming/outgoing boundary rows describe HEAD against its upstream, so
  // they are only meaningful for the default HEAD walk without filters.
  const tracksHead = cursor === undefined && revision === null && !pathFilter && !messageFilter

  let mergeBase: string | undefined
  if (tracksHead && remoteRef?.revision && currentRef.revision && remoteRef.revision !== currentRef.revision) {
    try {
      const { stdout } = await git(['merge-base', currentRef.revision, remoteRef.revision], cwd)
      mergeBase = stdout.trim() || undefined
    } catch {
      mergeBase = undefined
    }
  }

  const offset = cursor?.offset ?? 0
  const logArgs = [
    'log',
    '--no-show-signature',
    '--no-color',
    `--format=${GIT_HISTORY_COMMIT_FORMAT}`,
    '-z',
    '--topo-order',
    '--decorate=full'
  ]
  if (offset > 0) {
    logArgs.push(`--skip=${offset}`)
  }
  logArgs.push(`-n${limit + 1}`)
  if (messageFilter) {
    logArgs.push('--fixed-strings', '--regexp-ignore-case', `--grep=${messageFilter}`)
  }
  logArgs.push(tipOid)
  if (pathFilter) {
    logArgs.push('--', `:(literal)${pathFilter}`)
  }

  let stdout: string
  try {
    stdout = (await git(logArgs, cwd)).stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/bad object|missing|not a tree|unable to read|could not read|revision walk setup failed/i.test(message)) {
      throw new GitHistoryReadError(
        'unavailable',
        'Git history references an object that is not available locally; no fetch was attempted.'
      )
    }
    throw new GitHistoryReadError('git-error', message || 'git log failed')
  }

  const parsed = parseGitHistoryLog(stdout)
  const items = parsed.slice(0, limit)
  const hasMore = parsed.length > limit
  const hasIncomingChanges =
    tracksHead && Boolean(remoteRef?.revision && mergeBase) && remoteRef?.revision !== mergeBase
  const hasOutgoingChanges =
    tracksHead &&
    Boolean(currentRef.revision && remoteRef?.revision && mergeBase) &&
    currentRef.revision !== mergeBase

  return {
    items,
    currentRef,
    remoteRef,
    baseRef,
    mergeBase,
    hasIncomingChanges,
    hasOutgoingChanges,
    hasMore,
    limit,
    generation: gitHistoryGeneration(options, tipOid),
    tipOid,
    ...(browsedRef ? { browsedRef } : {}),
    empty: false,
    ...(hasMore ? { nextCursor: { tipOid, offset: offset + items.length } } : {})
  }
}

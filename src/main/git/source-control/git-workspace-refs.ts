import { lstat } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitContextRef,
  GitWorkspaceRef,
  RepositoryState
} from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitWorkspaceReadError, workspaceReadError } from './git-workspace-error'

const REF_LIMIT = 10_000
const REMOTE_LIMIT = 200

export type UpstreamTrack = { ahead?: number; behind?: number; gone?: boolean }

/**
 * `%(upstream:track)` is Git's own local comparison of a branch with its
 * upstream. It never contacts a remote: it reports what the fetched tracking
 * refs say right now.
 */
export function parseUpstreamTrack(track: string, hasUpstream: boolean): UpstreamTrack {
  if (track.includes('gone')) {
    return { gone: true }
  }
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  if (ahead || behind) {
    return {
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0
    }
  }
  // Why: Git prints an empty tracker for a branch that is exactly in sync, so
  // an existing upstream with no counters means 0/0 rather than "unknown".
  return hasUpstream ? { ahead: 0, behind: 0 } : {}
}

async function readWorkspaceRefs(
  context: GitContextRef,
  options: GetStatusOptions
): Promise<GitWorkspaceRef[]> {
  const output = await workspaceGitRead(
    context.checkoutPath,
    [
      'for-each-ref',
      `--count=${REF_LIMIT + 1}`,
      '--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track)',
      'refs/heads/',
      'refs/remotes/',
      'refs/tags/'
    ],
    options
  )
  const rows = output.trimEnd().split('\n').filter(Boolean)
  if (rows.length > REF_LIMIT) {
    throw new GitWorkspaceReadError('limit', `Ref catalog exceeds ${REF_LIMIT} entries.`)
  }
  return rows.map((row) => {
    const [name, oid, upstream, track] = row.split('\0')
    const parsed = parseUpstreamTrack(track ?? '', !!upstream)
    return {
      name,
      oid,
      ...(upstream ? { upstream } : {}),
      ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
      ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
      ...(parsed.gone ? { upstreamGone: true } : {})
    }
  })
}

async function readWorkspaceRemotes(
  context: GitContextRef,
  options: GetStatusOptions
): Promise<string[]> {
  const output = await workspaceGitRead(context.checkoutPath, ['remote'], options)
  return output
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !/\p{Cc}/u.test(name))
    .slice(0, REMOTE_LIMIT)
}

async function readLastFetchAt(context: GitContextRef): Promise<string | undefined> {
  try {
    const info = await lstat(path.join(context.gitDir, 'FETCH_HEAD'))
    return info.isFile() && !info.isSymbolicLink() ? info.mtime.toISOString() : undefined
  } catch {
    // No fetch has run in this checkout yet (or the file is unreadable metadata).
    return undefined
  }
}

export async function attachWorkspaceRefs(
  repository: RepositoryState,
  options: GetStatusOptions
): Promise<void> {
  if (options.workspaceRefsContextId !== repository.context.id) {
    return
  }
  try {
    const [refs, remotes, lastFetchAt] = await Promise.all([
      readWorkspaceRefs(repository.context, options),
      readWorkspaceRemotes(repository.context, options),
      readLastFetchAt(repository.context)
    ])
    repository.refs = refs
    repository.remotes = remotes
    repository.refsReadAt = new Date().toISOString()
    if (lastFetchAt) {
      repository.lastFetchAt = lastFetchAt
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    repository.refsError = workspaceReadError(error)
  }
}

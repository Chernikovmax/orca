import { describe, expect, it } from 'vitest'
import { parseUpstreamTrack, attachWorkspaceRefs } from './git-workspace-refs'
import { splitRemoteBranch, requireRemoteName } from './git-workspace-branch-guards'
import { validateNewBranchName, validateWorkspaceRefName } from './git-workspace-branch-refs'
import {
  createWorkspaceNetworkProgressReader,
  publishGitWorkspaceProgress,
  subscribeGitWorkspaceProgress
} from './git-workspace-progress'
import type { GitMutationProgress } from '../../../shared/git-workspace-mutation'
import type { GitContextRef, RepositoryState } from '../../../shared/git-workspace-types'

describe('workspace ref metadata parsing', () => {
  it('reads the local upstream tracker without inventing a remote answer', () => {
    expect(parseUpstreamTrack('', true)).toEqual({ ahead: 0, behind: 0 })
    expect(parseUpstreamTrack('[ahead 2]', true)).toEqual({ ahead: 2, behind: 0 })
    expect(parseUpstreamTrack('[behind 3]', true)).toEqual({ ahead: 0, behind: 3 })
    expect(parseUpstreamTrack('[ahead 2, behind 3]', true)).toEqual({ ahead: 2, behind: 3 })
    expect(parseUpstreamTrack('[gone]', true)).toEqual({ gone: true })
    expect(parseUpstreamTrack('', false)).toEqual({})
  })

  it('splits remote refs using configured remote names, including slash names', () => {
    expect(splitRemoteBranch('refs/remotes/origin/feature/x', ['origin'])).toEqual({
      remote: 'origin',
      branch: 'feature/x'
    })
    expect(splitRemoteBranch('refs/remotes/team/fork/main', ['team/fork', 'team'])).toEqual({
      remote: 'team/fork',
      branch: 'main'
    })
    expect(() => splitRemoteBranch('refs/remotes/origin/HEAD', ['origin'])).toThrow()
    expect(() => splitRemoteBranch('refs/remotes/unknown/main', ['origin'])).toThrow()
  })

  it('requires an explicitly configured remote and never accepts a URL', () => {
    expect(requireRemoteName('origin', ['origin'])).toBe('origin')
    expect(() => requireRemoteName('https://example.invalid/r.git', ['origin'])).toThrow()
    expect(() => requireRemoteName('-origin', ['origin'])).toThrow()
  })

  it('accepts full refs and full ids and rejects option-like or path-like input', () => {
    expect(validateWorkspaceRefName('refs/heads/main')).toBe('refs/heads/main')
    expect(validateWorkspaceRefName('refs/tags/v1')).toBe('refs/tags/v1')
    expect(validateWorkspaceRefName('a'.repeat(40))).toBe('a'.repeat(40))
    for (const invalid of [
      'HEAD',
      'main',
      'refs/heads/../main',
      'refs/heads/main..other',
      'refs/heads/-force',
      'refs/heads/main@{1}',
      'refs/heads/main lock',
      'refs/heads/main\u0000',
      'refs/heads/'
    ]) {
      expect(() => validateWorkspaceRefName(invalid)).toThrow()
    }
    expect(validateNewBranchName('feature/one')).toBe('feature/one')
    for (const invalid of ['-force', 'a..b', 'a.', 'a.lock', 'a b', 'a\u0001']) {
      expect(() => validateNewBranchName(invalid)).toThrow()
    }
  })
})

describe('workspace network progress', () => {
  it('parses per-title meters and ignores unrelated stderr text', () => {
    const events: string[] = []
    const read = createWorkspaceNetworkProgressReader('fetch', (phase, record) =>
      events.push(`${phase}:${record.percent}:${record.total}`)
    )
    read('remote: Counting objects: 50% (5/10)\rReceiving objects: 10% (1/10)\r')
    read('Receiving objects: 100% (10/10), done.\r\nResolving deltas: 0% (0/2)\r')
    expect(events).toContain('receiving:10:10')
    expect(events).toContain('receiving:100:10')
    expect(events).toContain('resolving:0:2')
    expect(events.join('\n')).not.toContain('fatal')
  })

  it('delivers a done frame to a subscriber that arrives after the operation', () => {
    publishGitWorkspaceProgress({
      progressId: 'progress-late-1',
      operation: 'push',
      phase: 'writing',
      percent: 50,
      done: false
    })
    publishGitWorkspaceProgress({
      progressId: 'progress-late-1',
      operation: 'push',
      phase: 'done',
      percent: 100,
      done: true
    })
    const received: GitMutationProgress[] = []
    const stop = subscribeGitWorkspaceProgress('progress-late-1', (event) => received.push(event))
    stop()
    expect(received).toEqual([expect.objectContaining({ phase: 'done', percent: 100, done: true })])
  })
})

describe('workspace refs freshness', () => {
  it('attaches no refs to a context the caller did not select', async () => {
    const context: GitContextRef = {
      id: 'context-1',
      executionHostId: 'local',
      rootWorktreePath: '/tmp/root',
      checkoutPath: '/tmp/root/child',
      gitDir: '/tmp/root/.git/modules/child',
      commonGitDir: '/tmp/root/.git/modules/child'
    }
    const repository: RepositoryState = {
      context,
      unborn: false,
      detached: false,
      conflictOperation: 'unknown',
      entries: [],
      dirty: false,
      conflicted: false,
      incomplete: false,
      expectedState: 'state'
    }
    await attachWorkspaceRefs(repository, { workspaceRefsContextId: 'other' })
    expect(repository.refs).toBeUndefined()
    expect(repository.remotes).toBeUndefined()
    expect(repository.lastFetchAt).toBeUndefined()
  })
})

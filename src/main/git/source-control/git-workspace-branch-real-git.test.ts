import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getStatus } from './status-read'
import { mutateGitWorkspace } from './git-workspace-mutation'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'
import { subscribeGitWorkspaceProgress } from './git-workspace-progress'
import type { GitMutationProgress } from '../../../shared/git-workspace-mutation'
import type { RepositoryState } from '../../../shared/git-workspace-types'

const fixtures: GitWorkspaceFixture[] = []
const savedEnv = { ...process.env }
let fixtureHome = ''

beforeAll(async () => {
  fixtureHome = await mkdtemp(path.join(tmpdir(), 'orca-stage6-home-'))
  process.env.HOME = fixtureHome
  process.env.USERPROFILE = fixtureHome
  process.env.GIT_CONFIG_GLOBAL = path.join(fixtureHome, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
})

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture.directory, { recursive: true, force: true }))
  )
})

afterAll(async () => {
  process.env = { ...savedEnv }
  await rm(fixtureHome, { recursive: true, force: true })
})

async function fixtureWithRemote(): Promise<{ fixture: GitWorkspaceFixture; bare: string }> {
  const fixture = await createGitWorkspaceFixture()
  fixtures.push(fixture)
  const bare = path.join(fixture.directory, 'stage6-remote.git')
  await fixture.git(fixture.directory, ['init', '-q', '--bare', bare])
  for (const checkout of [fixture.root, fixture.one, fixture.two, fixture.nested]) {
    await fixture.git(checkout, ['remote', 'add', 'stage6', bare])
  }
  // Why: only one checkout owns the shared bare main; four unrelated histories
  // cannot all be that ref's fast-forward source.
  await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:main'])
  await fixture.git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const checkout of [fixture.root, fixture.one, fixture.two, fixture.nested]) {
    await fixture.git(checkout, ['fetch', '-q', '--no-recurse-submodules', 'stage6'])
  }
  return { fixture, bare }
}

async function repositoryFor(
  root: string,
  checkoutPath: string
): Promise<{ repository: RepositoryState; workspaceRoot: string }> {
  const canonical = await realpath(checkoutPath)
  const status = await getStatus(root, { includeWorkspace: true, includeLineStats: false })
  if (!status.workspace) {
    throw new Error('workspace snapshot missing')
  }
  const repository = status.workspace.repositories.find(
    (item) => item.context.checkoutPath === canonical
  )
  if (!repository) {
    throw new Error(`context missing for ${checkoutPath}`)
  }
  return { repository, workspaceRoot: root }
}

async function repositoryWithRefs(root: string, checkoutPath: string): Promise<RepositoryState> {
  const initial = await repositoryFor(root, checkoutPath)
  const status = await getStatus(root, {
    includeWorkspace: true,
    includeLineStats: false,
    workspaceRefsContextId: initial.repository.context.id
  })
  const repository = status.workspace?.repositories.find(
    (item) => item.context.id === initial.repository.context.id
  )
  if (!repository) {
    throw new Error(`context refs missing for ${checkoutPath}`)
  }
  return repository
}

async function mutate(
  root: string,
  repository: RepositoryState,
  request: {
    action: Parameters<typeof mutateGitWorkspace>[1]['action']
    refName?: string
    branch?: string
    startRef?: string
    remote?: string
    expectedRefOid?: string
    setUpstream?: boolean
    progressId?: string
    expectedState?: string
    expectedHead?: string
  },
  signal?: AbortSignal
) {
  return mutateGitWorkspace(
    root,
    {
      contextId: repository.context.id,
      expectedState: request.expectedState ?? repository.expectedState,
      expectedHead: request.expectedHead ?? repository.head ?? '',
      ...request
    },
    signal ? { signal } : {}
  )
}

async function checkoutState(
  fixture: GitWorkspaceFixture,
  cwd: string
): Promise<{ head: string; branch: string; refs: string; index: string }> {
  return {
    head: await fixture.git(cwd, ['rev-parse', '--verify', 'HEAD']),
    branch: await fixture.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    refs: await fixture.git(cwd, ['show-ref']),
    index: await fixture.git(cwd, ['ls-files', '--stage'])
  }
}

describe('workspace checkout and branch actions on real Git', () => {
  it('checks out a local branch in only the selected submodule checkout', async () => {
    const { fixture } = await fixtureWithRemote()
    const before = await Promise.all(
      [fixture.root, fixture.two, fixture.nested].map((cwd) => checkoutState(fixture, cwd))
    )
    const oneBefore = await checkoutState(fixture, fixture.one)
    await fixture.git(fixture.one, ['checkout', '-qb', 'feature-one'])
    await writeFile(path.join(fixture.one, 'feature-one.txt'), 'feature one\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'feature one'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    const branchOid = await fixture.git(fixture.one, ['rev-parse', 'feature-one'])

    const { repository } = await repositoryFor(fixture.root, fixture.one)
    const receipt = await mutate(fixture.root, repository, {
      action: 'checkout',
      refName: 'refs/heads/feature-one'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(receipt.operation).toMatchObject({
      kind: 'checkout',
      branch: 'refs/heads/feature-one',
      oid: branchOid,
      detached: false,
      completed: true
    })
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(branchOid)
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature-one')
    const after = await Promise.all(
      [fixture.root, fixture.two, fixture.nested].map((cwd) => checkoutState(fixture, cwd))
    )
    expect(after).toEqual(before)
    expect(oneBefore.head).not.toBe(branchOid)

    const back = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      {
        action: 'checkout',
        refName: 'refs/heads/main'
      }
    )
    expect(back.outcome).toBe('succeeded')
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(oneBefore.head)
  })

  it('creates and checks out a new branch from an explicit remote start point', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:remote-feature'])
    await fixture.git(fixture.one, ['fetch', '-q', 'stage6'])
    const { repository } = await repositoryFor(fixture.root, fixture.one)
    const receipt = await mutate(fixture.root, repository, {
      action: 'createBranch',
      branch: 'from-remote',
      startRef: 'refs/remotes/stage6/remote-feature'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(receipt.operation).toMatchObject({
      kind: 'createBranch',
      branch: 'refs/heads/from-remote'
    })
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/from-remote')
    expect(
      await fixture.git(fixture.one, [
        'for-each-ref',
        '--format=%(upstream)',
        'refs/heads/from-remote'
      ])
    ).toBe('refs/remotes/stage6/remote-feature')
  })

  it('checks out a remote branch as a tracking local branch and a tag or revision detached', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:remote-only'])
    const { repository } = await repositoryFor(fixture.root, fixture.one)
    const remote = await mutate(fixture.root, repository, {
      action: 'checkout',
      refName: 'refs/remotes/stage6/remote-only'
    })
    expect(remote.outcome).toBe('succeeded')
    expect(remote.operation?.branch).toBe('refs/heads/remote-only')
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/remote-only')
    expect(
      await fixture.git(fixture.one, [
        'for-each-ref',
        '--format=%(upstream)',
        'refs/heads/remote-only'
      ])
    ).toBe('refs/remotes/stage6/remote-only')

    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'tag-base.txt'), 'tag base\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'tag base'])
    await fixture.git(fixture.one, ['tag', 'stage6-tag'])
    const tagged = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'checkout', refName: 'refs/tags/stage6-tag' }
    )
    expect(tagged.outcome).toBe('succeeded')
    expect(tagged.operation?.detached).toBe(true)
    expect(await fixture.git(fixture.one, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    const parentOid = await fixture.git(fixture.one, ['rev-parse', 'refs/heads/main~1'])
    const detachedOid = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'checkout', refName: parentOid }
    )
    expect(detachedOid.outcome).toBe('succeeded')
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(parentOid)
    expect(await fixture.git(fixture.one, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(await fixture.git(fixture.one, ['cat-file', '-e', 'HEAD:tag-base.txt'], 128)).toBe('')
  })

  it('refuses to check out a branch attached to another worktree', async () => {
    const { fixture } = await fixtureWithRemote()
    const before = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
    const { repository } = await repositoryFor(fixture.root, fixture.root)
    const receipt = await mutate(fixture.root, repository, {
      action: 'checkout',
      refName: 'refs/heads/second'
    })
    expect(receipt.outcome).toBe('failed')
    expect(receipt.errorCategory).toBe('busy')
    expect(receipt.error).toContain('another worktree')
    expect(receipt.error).toContain(await realpath(fixture.second))
    expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('blocks only checkout paths that would overwrite local work', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'touch-file'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'branch content\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'touch file'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])

    await writeFile(path.join(fixture.one, 'file.txt'), 'local edit\n')
    const blocking = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'checkout', refName: 'refs/heads/touch-file' }
    )
    expect(blocking.outcome).toBe('failed')
    expect(blocking.errorCategory).toBe('dirty')
    expect(blocking.error).toContain('file.txt')
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')

    await fixture.git(fixture.one, ['checkout', '--', 'file.txt'])
    await writeFile(path.join(fixture.one, 'unrelated-draft.txt'), 'keep me\n')
    const allowed = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      {
        action: 'checkout',
        refName: 'refs/heads/touch-file'
      }
    )
    expect(allowed.outcome).toBe('succeeded')
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/touch-file')
    expect(await fixture.git(fixture.one, ['status', '--porcelain'])).toBe('?? unrelated-draft.txt')
  })
})

describe('workspace refs freshness, fetch and push on real Git', () => {
  it('reports upstream ahead/behind from loaded refs and updates them after an explicit fetch', async () => {
    const { fixture, bare } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['branch', '--set-upstream-to=stage6/main', 'main'])
    let repository = await repositoryWithRefs(fixture.root, fixture.one)
    expect(repository.remotes).toContain('stage6')
    expect(repository.refsReadAt).toBeTruthy()
    expect(repository.lastFetchAt).toBeTruthy()
    const main = repository.refs?.find((ref) => ref.name === 'refs/heads/main')
    expect(main).toMatchObject({
      upstream: 'refs/remotes/stage6/main',
      ahead: 0,
      behind: 0
    })
    const fetchedAt = repository.lastFetchAt
    await writeFile(path.join(fixture.one, 'ahead.txt'), 'ahead\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'ahead one'])
    repository = await repositoryWithRefs(fixture.root, fixture.one)
    expect(repository.refs?.find((ref) => ref.name === 'refs/heads/main')).toMatchObject({
      ahead: 1,
      behind: 0
    })

    // Advance the bare remote without touching this checkout.
    const clone = path.join(fixture.directory, 'advance-clone')
    await fixture.git(fixture.directory, ['clone', '-q', bare, clone])
    await writeFile(path.join(clone, 'remote.txt'), 'remote\n')
    await fixture.git(clone, ['add', '.'])
    await fixture.git(clone, ['commit', '-qm', 'remote advance'])
    await fixture.git(clone, ['push', '-q', 'origin', 'main'])

    const stale = await repositoryWithRefs(fixture.root, fixture.one)
    expect(stale.refs?.find((ref) => ref.name === 'refs/heads/main')).toMatchObject({
      ahead: 1,
      behind: 0
    })
    expect(stale.lastFetchAt).toBe(fetchedAt)

    const events: GitMutationProgress[] = []
    const stop = subscribeGitWorkspaceProgress('progress-fetch-1', (event) => events.push(event))
    const receipt = await mutate(fixture.root, stale, {
      action: 'fetch',
      remote: 'stage6',
      progressId: 'progress-fetch-1'
    })
    stop()
    expect(receipt.outcome).toBe('succeeded')
    expect(receipt.operation).toMatchObject({ kind: 'fetch', remote: 'stage6', completed: true })
    expect(events.at(-1)).toMatchObject({ done: true, operation: 'fetch' })
    const fetched = await repositoryWithRefs(fixture.root, fixture.one)
    expect(fetched.lastFetchAt).not.toBe(fetchedAt)
    expect(fetched.refs?.find((ref) => ref.name === 'refs/heads/main')).toMatchObject({
      ahead: 1,
      behind: 1
    })
    expect(fetched.refs?.find((ref) => ref.name === 'refs/remotes/stage6/main')?.oid).toBe(
      await fixture.git(clone, ['rev-parse', 'HEAD'])
    )
  })

  it('fetches one explicit remote branch without touching other refs', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:only-this'])
    await fixture.git(fixture.one, ['update-ref', '-d', 'refs/remotes/stage6/only-this'])
    const repository = await repositoryWithRefs(fixture.root, fixture.one)
    const before = repository.refs?.find((ref) => ref.name === 'refs/remotes/stage6/only-this')
    expect(before).toBeUndefined()
    const receipt = await mutate(fixture.root, repository, {
      action: 'fetch',
      remote: 'stage6',
      branch: 'only-this'
    })
    expect(receipt.outcome).toBe('succeeded')
    const after = await repositoryWithRefs(fixture.root, fixture.one)
    expect(after.refs?.find((ref) => ref.name === 'refs/remotes/stage6/only-this')?.oid).toBe(
      await fixture.git(fixture.one, ['rev-parse', 'main'])
    )
  })

  it('pushes a reviewed branch explicitly and rejects a non-fast-forward without force', async () => {
    const { fixture, bare } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'publish-me'])
    await writeFile(path.join(fixture.one, 'publish.txt'), 'publish\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'publish me'])
    const repository = await repositoryWithRefs(fixture.root, fixture.one)
    const local = repository.refs?.find((ref) => ref.name === 'refs/heads/publish-me')
    expect(local?.oid).toBeTruthy()
    const events: GitMutationProgress[] = []
    const stop = subscribeGitWorkspaceProgress('progress-push-1', (event) => events.push(event))
    const pushed = await mutate(fixture.root, repository, {
      action: 'push',
      remote: 'stage6',
      refName: 'refs/heads/publish-me',
      expectedRefOid: local?.oid,
      setUpstream: true,
      progressId: 'progress-push-1'
    })
    stop()
    expect(pushed.outcome).toBe('succeeded')
    expect(pushed.operation).toMatchObject({ kind: 'push', remote: 'stage6', oid: local?.oid })
    expect(events.at(-1)).toMatchObject({ done: true, operation: 'push' })
    expect(await fixture.git(bare, ['rev-parse', 'refs/heads/publish-me'])).toBe(local?.oid)
    expect(
      await fixture.git(fixture.one, [
        'for-each-ref',
        '--format=%(upstream)',
        'refs/heads/publish-me'
      ])
    ).toBe('refs/remotes/stage6/publish-me')

    // A branch that moved after review must never be pushed as the reviewed object.
    await writeFile(path.join(fixture.one, 'moved.txt'), 'moved\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'moved after review'])
    const moved = await repositoryWithRefs(fixture.root, fixture.one)
    const staleView = await mutate(fixture.root, moved, {
      action: 'push',
      remote: 'stage6',
      refName: 'refs/heads/publish-me',
      expectedRefOid: local?.oid
    })
    expect(staleView.outcome).toBe('failed')
    expect(staleView.errorCategory).toBe('stale')

    // Advance the remote; the local branch now cannot fast-forward push.
    const clone = path.join(fixture.directory, 'reject-clone')
    await fixture.git(fixture.directory, ['clone', '-q', bare, clone])
    await fixture.git(clone, ['checkout', 'publish-me'])
    await writeFile(path.join(clone, 'remote-publish.txt'), 'remote\n')
    await fixture.git(clone, ['add', '.'])
    await fixture.git(clone, ['commit', '-qm', 'remote publish'])
    await fixture.git(clone, ['push', '-q', 'origin', 'publish-me'])
    const remote = await fixture.git(clone, ['rev-parse', 'HEAD'])

    const fresh = await repositoryWithRefs(fixture.root, fixture.one)
    const movedOid = fresh.refs?.find((ref) => ref.name === 'refs/heads/publish-me')?.oid
    const rejected = await mutate(fixture.root, fresh, {
      action: 'push',
      remote: 'stage6',
      refName: 'refs/heads/publish-me',
      expectedRefOid: movedOid
    })
    expect(rejected.outcome).toBe('failed')
    expect(rejected.errorCategory).toBe('rejected')
    expect(rejected.error).toContain('does not force-push')
    expect(await fixture.git(bare, ['rev-parse', 'refs/heads/publish-me'])).toBe(remote)
    expect(await fixture.git(fixture.one, ['rev-parse', 'publish-me'])).toBe(movedOid)
  })

  it('distinguishes an authentication failure from an unknown network result', async () => {
    const { fixture } = await fixtureWithRemote()
    let unauthorized = 0
    const authServer = createServer((_request, response) => {
      unauthorized += 1
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      response.end('authentication required')
    })
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve))
    const authUrl = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}/repo.git`
    let hanging = 0
    const firstHangRequest = Promise.withResolvers<void>()
    const hangServer = createServer(() => {
      hanging += 1
      firstHangRequest.resolve()
    })
    await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', resolve))
    const hangUrl = `http://127.0.0.1:${(hangServer.address() as AddressInfo).port}/repo.git`
    try {
      await fixture.git(fixture.one, ['remote', 'add', 'authfail', authUrl])
      await fixture.git(fixture.one, ['remote', 'add', 'hang', hangUrl])
      const repository = await repositoryWithRefs(fixture.root, fixture.one)
      const local = repository.refs?.find((ref) => ref.name === 'refs/heads/main')
      const auth = await mutate(fixture.root, repository, {
        action: 'push',
        remote: 'authfail',
        refName: 'refs/heads/main',
        expectedRefOid: local?.oid
      })
      expect(auth.outcome).toBe('failed')
      expect(auth.errorCategory).toBe('authentication')
      expect(auth.error).not.toContain(authUrl)
      expect(unauthorized).toBeGreaterThan(0)
      const authFetch = await mutate(fixture.root, repository, {
        action: 'fetch',
        remote: 'authfail'
      })
      expect(authFetch.outcome).toBe('failed')
      expect(authFetch.errorCategory).toBe('authentication')

      const controller = new AbortController()
      const unknown = mutate(
        fixture.root,
        repository,
        {
          action: 'push',
          remote: 'hang',
          refName: 'refs/heads/main',
          expectedRefOid: local?.oid
        },
        controller.signal
      )
      // Why: abort only once the real git child is blocked on the OS socket, so
      // the interrupted-push outcome is exercised rather than a pre-flight cancel.
      await firstHangRequest.promise
      controller.abort()
      const receipt = await unknown
      expect(receipt.outcome).toBe('unknown')
      expect(receipt.errorCategory).toBe('unknown-outcome')
      expect(receipt.error).toContain('Verify the real Git state')
      expect(hanging).toBeGreaterThanOrEqual(1)
      // Recovery starts from the real state, not from an automatic retry.
      const verified = await repositoryWithRefs(fixture.root, fixture.one)
      expect(verified.refs?.find((ref) => ref.name === 'refs/heads/main')?.oid).toBe(local?.oid)
      const retried = await mutate(fixture.root, verified, {
        action: 'push',
        remote: 'stage6',
        refName: 'refs/heads/main',
        expectedRefOid: local?.oid
      })
      expect(retried.outcome).toBe('succeeded')
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()))
      hangServer.closeAllConnections()
      await new Promise<void>((resolve) => hangServer.close(() => resolve()))
    }
  })
})

describe('workspace merge and rebase on real Git', () => {
  it('merges explicitly, reports conflicts truthfully, continues after resolution and aborts', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'fast', 'main'])
    await writeFile(path.join(fixture.one, 'fast.txt'), 'fast\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'fast'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    const base = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    const merged = await mutate(fixture.root, base, {
      action: 'merge',
      refName: 'refs/heads/fast'
    })
    expect(merged.outcome).toBe('succeeded')
    expect(merged.operation).toMatchObject({
      kind: 'merge',
      completed: true,
      detail: 'fast-forward'
    })
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')
    expect(await fixture.git(fixture.one, ['show', 'main:fast.txt'])).toBe('fast')

    await fixture.git(fixture.one, ['checkout', '-qb', 'conflicting', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'conflicting\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'conflicting'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'main side\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'main side'])
    const beforeMerge = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    const conflict = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'merge', refName: 'refs/heads/conflicting' }
    )
    expect(conflict.outcome).toBe('failed')
    expect(conflict.errorCategory).toBe('conflict')
    expect(conflict.error).toContain('not complete')
    const conflicted = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    expect(conflicted.operationInProgress).toBe(true)
    expect(conflicted.conflictOperation).toBe('merge')
    expect(conflicted.conflicted).toBe(true)
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(beforeMerge)

    const unresolved = await mutate(fixture.root, conflicted, { action: 'continueOperation' })
    expect(unresolved.outcome).toBe('failed')
    expect(unresolved.errorCategory).toBe('conflict')

    await writeFile(path.join(fixture.one, 'file.txt'), 'resolved\n')
    await fixture.git(fixture.one, ['add', 'file.txt'])
    const resolvable = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    const continued = await mutate(fixture.root, resolvable, { action: 'continueOperation' })
    expect(continued.outcome).toBe('succeeded')
    expect(continued.operation).toMatchObject({ kind: 'continue', detail: 'continued' })
    expect(
      (await fixture.git(fixture.one, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')
    ).toHaveLength(3)
    expect(
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository.operationInProgress)
    ).toBeFalsy()

    await fixture.git(fixture.one, ['checkout', '-qb', 'conflicting-2', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'conflicting two\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'conflicting two'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'main two\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'main two'])
    const abortBase = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    const failed = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'merge', refName: 'refs/heads/conflicting-2' }
    )
    expect(failed.errorCategory).toBe('conflict')
    const aborted = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'abortOperation' }
    )
    expect(aborted.outcome).toBe('succeeded')
    expect(aborted.operation).toMatchObject({ kind: 'abort', detail: 'aborted' })
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(abortBase)
    const clean = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    expect(clean.operationInProgress).toBe(false)
    expect(clean.dirty).toBe(false)
  })

  it('requires a clean tree for merge and rejects a second operation while one is unfinished', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'side', 'main'])
    await writeFile(path.join(fixture.one, 'side.txt'), 'side\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'side'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'dirty.txt'), 'dirty\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'dirty base'])
    await writeFile(path.join(fixture.one, 'dirty.txt'), 'still dirty\n')
    const blocked = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'merge', refName: 'refs/heads/side' }
    )
    expect(blocked.outcome).toBe('failed')
    expect(blocked.errorCategory).toBe('dirty')
    expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')
    await fixture.git(fixture.one, ['checkout', '--', 'dirty.txt'])
    // Create an unfinished merge, then refuse a second checkout/merge.
    await fixture.git(fixture.one, ['checkout', '-qb', 'other', 'main'])
    await writeFile(path.join(fixture.one, 'dirty.txt'), 'other\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'other'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'dirty.txt'), 'main\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'main'])
    await fixture.git(fixture.one, ['merge', 'other'], 1)
    const unfinished = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    expect(unfinished.operationInProgress).toBe(true)
    const second = await mutate(fixture.root, unfinished, {
      action: 'checkout',
      refName: 'refs/heads/side'
    })
    expect(second.outcome).toBe('failed')
    expect(second.errorCategory).toBe('operation-in-progress')
    const abort = await mutate(fixture.root, unfinished, { action: 'abortOperation' })
    expect(abort.outcome).toBe('succeeded')
  })

  it('rebases explicitly and aborts a conflicted rebase without claiming completion', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'base', 'main'])
    await writeFile(path.join(fixture.one, 'base.txt'), 'base\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'base'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'main2.txt'), 'main2\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'main2'])
    const rebased = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'rebase', refName: 'refs/heads/base' }
    )
    expect(rebased.outcome).toBe('succeeded')
    expect(rebased.operation).toMatchObject({ kind: 'rebase', completed: true })
    expect(
      (await fixture.git(fixture.one, ['rev-list', '--parents', '-n', '1', 'HEAD'])).split(' ')
    ).toHaveLength(2)
    expect(await fixture.git(fixture.one, ['show', 'HEAD:base.txt'])).toBe('base')
    expect(await fixture.git(fixture.one, ['show', 'HEAD:main2.txt'])).toBe('main2')

    await fixture.git(fixture.one, ['checkout', '-qb', 'rbase', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'rbase\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'rbase'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'main rebase\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'main rebase'])
    const before = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    const conflict = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'rebase', refName: 'refs/heads/rbase' }
    )
    expect(conflict.outcome).toBe('failed')
    expect(conflict.errorCategory).toBe('conflict')
    const state = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    expect(state.operationInProgress).toBe(true)
    expect(state.conflictOperation).toBe('rebase')
    const aborted = await mutate(fixture.root, state, { action: 'abortOperation' })
    expect(aborted.outcome).toBe('succeeded')
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(before)
    expect(
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository.operationInProgress)
    ).toBe(false)
  })

  it('continues a rebase only after the conflict is resolved and staged', async () => {
    const { fixture } = await fixtureWithRemote()
    await fixture.git(fixture.one, ['checkout', '-qb', 'rbase2', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'rbase2\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'rbase2'])
    await fixture.git(fixture.one, ['checkout', '-q', 'main'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'main rbase2\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'main rbase2'])
    const conflict = await mutate(
      fixture.root,
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository),
      { action: 'rebase', refName: 'refs/heads/rbase2' }
    )
    expect(conflict.errorCategory).toBe('conflict')
    await writeFile(path.join(fixture.one, 'file.txt'), 'resolved rebase\n')
    await fixture.git(fixture.one, ['add', 'file.txt'])
    const state = await repositoryFor(fixture.root, fixture.one).then((r) => r.repository)
    const continued = await mutate(fixture.root, state, { action: 'continueOperation' })
    expect(continued.outcome).toBe('succeeded')
    expect(
      await repositoryFor(fixture.root, fixture.one).then((r) => r.repository.operationInProgress)
    ).toBe(false)
    expect(await fixture.git(fixture.one, ['show', 'HEAD:file.txt'])).toBe('resolved rebase')
  })
})

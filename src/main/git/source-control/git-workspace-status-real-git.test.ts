import { createServer } from 'node:http'
import { readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStatus } from './status-read'
import { getSubmoduleStatus } from './submodule-status'
import { createGitWorkspaceFixture } from './git-workspace-test-fixture'

// Owns catalog semantics at the real Git boundary: no subprocess/result mocks.
describe('Git workspace catalog with real recursive checkouts', () => {
  let fixture: Awaited<ReturnType<typeof createGitWorkspaceFixture>>
  beforeEach(async () => {
    fixture = await createGitWorkspaceFixture()
    for (const key of [
      'HOME',
      'USERPROFILE',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT'
    ] as const) {
      vi.stubEnv(key, fixture.env[key])
    }
  }, 30_000)
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(fixture.directory, { recursive: true, force: true })
  })
  async function catalog(root = fixture.root) {
    const result = await getStatus(root, {
      includeWorkspace: true,
      includeLineStats: false,
      executionHostId: 'local'
    })
    if (!result.workspace) {
      throw new Error('Missing workspace catalog')
    }
    return result.workspace
  }
  it('routes legacy expanded rows through authorized contexts and preserves staged range limits', async () => {
    await writeFile(path.join(fixture.one, 'file.txt'), 'child committed\n')
    await writeFile(path.join(fixture.one, 'added.txt'), 'another committed file\n')
    await fixture.git(fixture.one, ['add', '.'])
    await fixture.git(fixture.one, ['commit', '-qm', 'child changes'])
    await writeFile(path.join(fixture.one, 'working.txt'), 'untracked\n')
    const unstaged = await getSubmoduleStatus(fixture.root, 'one')
    expect(unstaged.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'file.txt', status: 'modified' }),
        expect.objectContaining({ path: 'added.txt', status: 'added' }),
        expect.objectContaining({ path: 'working.txt', area: 'untracked' })
      ])
    )
    await fixture.git(fixture.root, ['add', 'one'])
    const staged = await getSubmoduleStatus(fixture.root, 'one', { staged: true, limit: 1 })
    expect(staged.didHitLimit).toBe(true)
    expect(staged.statusLength).toBe(2)
    expect(staged.entries[0]).toMatchObject({ path: 'added.txt', status: 'added' })
    await expect(getSubmoduleStatus(fixture.root, '../leaf')).rejects.toThrow('Access denied')
    await expect(getSubmoduleStatus(fixture.root, 'one/same')).resolves.toMatchObject({
      entries: []
    })
  }, 30_000)

  it('keeps root/worktree identities separate and reports dirty files independently from moved HEAD and staged gitlinks', async () => {
    await writeFile(path.join(fixture.one, 'file.txt'), 'new committed version\n')
    await fixture.git(fixture.one, ['add', 'file.txt'])
    await fixture.git(fixture.one, ['commit', '-qm', 'child commit'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'new committed version\nworking change\n')
    await writeFile(path.join(fixture.one, 'odd\n\t путь.txt'), 'untracked\n')
    const snapshot = await catalog()
    expect(snapshot.errors).toEqual([])
    expect(snapshot.incomplete).toBe(false)
    expect(snapshot.submodules.map((entry) => entry.path)).toEqual(['one', 'one/same', 'two'])
    const one = snapshot.submodules.find((entry) => entry.path === 'one')!
    expect(one).toMatchObject({
      availability: 'initialized',
      commitChanged: true,
      stagedGitlinkChanged: false,
      dirty: true,
      conflicted: false,
      descendants: 'complete'
    })
    expect(one.currentOid).not.toBe(one.indexOid)
    expect(one.headOid).toBe(one.indexOid)
    const child = snapshot.repositories.find(
      (repository) => repository.context.id === one.contextId
    )!
    expect(child.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'file.txt', area: 'unstaged' }),
        expect.objectContaining({ path: 'odd\n\t путь.txt', area: 'untracked' })
      ])
    )
    expect(snapshot.submodules.find((entry) => entry.path === 'two')).toMatchObject({
      dirty: false,
      commitChanged: false,
      availability: 'initialized'
    })
    await fixture.git(fixture.root, ['add', 'one'])
    const staged = await catalog()
    expect(staged.submodules.find((entry) => entry.path === 'one')).toMatchObject({
      dirty: true,
      commitChanged: false,
      stagedGitlinkChanged: true
    })
    expect(
      staged.repositories.find((item) => item.context.id === staged.rootContextId)?.expectedState
    ).not.toBe(
      snapshot.repositories.find((item) => item.context.id === snapshot.rootContextId)
        ?.expectedState
    )
    const other = await catalog(fixture.second)
    const firstRoot = staged.repositories.find((item) => item.context.id === staged.rootContextId)!
    const secondRoot = other.repositories.find((item) => item.context.id === other.rootContextId)!
    expect(secondRoot.context.id).not.toBe(firstRoot.context.id)
    expect(secondRoot.context.commonGitDir).toBe(firstRoot.context.commonGitDir)
    expect(secondRoot.context.gitDir).not.toBe(firstRoot.context.gitDir)
    expect(other.submodules.find((entry) => entry.path === 'one')).toMatchObject({
      availability: 'uninitialized',
      descendants: 'unknown'
    })
  }, 30_000)

  it('preserves conflicts, absent checkout and disagreeing HEAD/index/worktree/config metadata without hiding healthy contexts', async () => {
    await fixture.git(fixture.two, ['checkout', '-b', 'side'])
    await writeFile(path.join(fixture.two, 'file.txt'), 'side\n')
    await fixture.git(fixture.two, ['commit', '-qam', 'side'])
    await fixture.git(fixture.two, ['checkout', 'main'])
    await writeFile(path.join(fixture.two, 'file.txt'), 'main\n')
    await fixture.git(fixture.two, ['commit', '-qam', 'main'])
    await fixture.git(fixture.two, ['merge', 'side'], 1)
    await fixture.git(fixture.one, ['submodule', 'deinit', '-f', 'same'])
    await fixture.git(fixture.root, [
      'config',
      '--file',
      '.gitmodules',
      'submodule.same.path',
      'renamed-one'
    ])
    await fixture.git(fixture.root, [
      'config',
      'submodule.same.url',
      'https://user:secret@example.invalid/repo?token=hidden'
    ])
    const unknownOid = '1234567890123456789012345678901234567890'
    await fixture.git(fixture.root, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${unknownOid},orphan`
    ])
    const snapshot = await catalog()
    expect(snapshot.submodules.find((entry) => entry.path === 'two')).toMatchObject({
      availability: 'initialized',
      conflicted: true,
      dirty: true,
      commitChanged: true
    })
    const two = snapshot.submodules.find((entry) => entry.path === 'two')!
    expect(
      snapshot.repositories.find((item) => item.context.id === two.contextId)?.entries
    ).toContainEqual(expect.objectContaining({ path: 'file.txt', conflictStatus: 'unresolved' }))
    expect(snapshot.submodules.find((entry) => entry.path === 'one/same')).toMatchObject({
      availability: 'uninitialized',
      descendants: 'unknown'
    })
    expect(snapshot.submodules.find((entry) => entry.path === 'one')?.metadataIssues).toContain(
      'Submodule name declares different paths across metadata sources'
    )
    expect(
      snapshot.submodules.find((entry) => entry.path === 'renamed-one')?.metadataIssues
    ).toContain('Declaration has no HEAD/index gitlink')
    expect(snapshot.submodules.find((entry) => entry.path === 'orphan')).toMatchObject({
      indexOid: unknownOid,
      availability: 'uninitialized'
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|hidden/)
    expect(snapshot.incomplete).toBe(true)
  }, 30_000)

  it('denies checkout symlinks, outside gitfiles, unsafe declarations and keeps unaffected repositories usable', async () => {
    await rename(fixture.one, path.join(fixture.directory, 'outside-checkout'))
    await symlink(path.join(fixture.directory, 'outside-checkout'), fixture.one, 'dir')
    await fixture.git(fixture.root, [
      'config',
      '--file',
      '.gitmodules',
      'submodule.escape.path',
      '../outside-checkout'
    ])
    let snapshot = await catalog()
    expect(snapshot.submodules.find((entry) => entry.path === 'one')).toMatchObject({
      availability: 'blocked',
      error: { category: 'access-denied' },
      descendants: 'unknown'
    })
    expect(snapshot.submodules.find((entry) => entry.path === '../outside-checkout')).toMatchObject(
      { availability: 'blocked', error: { category: 'access-denied' } }
    )
    expect(snapshot.submodules.find((entry) => entry.path === 'two')?.availability).toBe(
      'initialized'
    )
    await writeFile(
      path.join(fixture.two, '.git'),
      `gitdir: ${path.join(fixture.directory, 'leaf', '.git')}\n`
    )
    snapshot = await catalog()
    expect(snapshot.submodules.find((entry) => entry.path === 'two')).toMatchObject({
      availability: 'blocked',
      error: { category: 'access-denied' }
    })
    expect(
      snapshot.repositories.map((repository) => repository.context.checkoutPath)
    ).not.toContain(path.join(fixture.directory, 'outside-checkout'))
  }, 30_000)

  it('isolates missing-object errors and forbids lazy network access even for a partial-clone promisor', async () => {
    let requests = 0
    const server = createServer((_req, res) => {
      requests += 1
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No loopback listener')
      }
      await fixture.git(fixture.one, [
        'remote',
        'set-url',
        'origin',
        `http://127.0.0.1:${address.port}/repo`
      ])
      await fixture.git(fixture.one, ['config', 'remote.origin.promisor', 'true'])
      await fixture.git(fixture.one, ['config', 'extensions.partialClone', 'origin'])
      const gitDir = await fixture.git(fixture.one, ['rev-parse', '--absolute-git-dir'])
      const tree = await fixture.git(fixture.one, ['rev-parse', 'HEAD^{tree}'])
      await rm(path.join(gitDir, 'objects', tree.slice(0, 2), tree.slice(2)))
      const snapshot = await catalog()
      expect(snapshot.submodules.find((entry) => entry.path === 'one')).toMatchObject({
        availability: 'unavailable',
        descendants: 'unknown'
      })
      expect(snapshot.submodules.find((entry) => entry.path === 'two')?.availability).toBe(
        'initialized'
      )
      expect(snapshot.errors.some((detail) => detail.path === 'one')).toBe(true)
      expect(snapshot.incomplete).toBe(true)
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }, 30_000)

  it('reads only the requested authorized context refs and keeps identical names distinct', async () => {
    await fixture.git(fixture.root, ['branch', 'shared'])
    await fixture.git(fixture.nested, ['branch', 'shared'])
    await fixture.git(fixture.nested, ['tag', 'release'])
    await fixture.git(fixture.nested, ['update-ref', 'refs/remotes/offline/shared', 'HEAD'])
    const initial = await catalog()
    const child = initial.submodules.find((entry) => entry.path === 'one/same')!
    const result = await getStatus(fixture.root, {
      includeWorkspace: true,
      includeLineStats: false,
      executionHostId: 'local',
      workspaceRefsContextId: child.contextId
    })
    const repositories = result.workspace!.repositories
    expect(repositories.find((item) => item.context.id === child.contextId)?.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'refs/heads/shared' }),
        expect.objectContaining({ name: 'refs/remotes/offline/shared' }),
        expect.objectContaining({ name: 'refs/tags/release' })
      ])
    )
    expect(
      repositories.filter((item) => item.refs !== undefined).map((item) => item.context.id)
    ).toEqual([child.contextId])
    const denied = await getStatus(fixture.root, {
      includeWorkspace: true,
      includeLineStats: false,
      executionHostId: 'local',
      workspaceRefsContextId: '../leaf'
    })
    expect(denied.workspace!.repositories.every((item) => item.refs === undefined)).toBe(true)
  }, 30_000)

  it('marks oversized metadata discovery incomplete rather than returning an empty healthy tree', async () => {
    let modules = await readFile(path.join(fixture.root, '.gitmodules'), 'utf8')
    for (let index = 0; index < 130; index++) {
      modules += `\n[submodule "absent-${index}"]\n path = absent-${index}\n url = ./offline\n`
    }
    await writeFile(path.join(fixture.root, '.gitmodules'), modules)
    const snapshot = await catalog()
    expect(snapshot.incomplete).toBe(true)
    expect(snapshot.errors).toContainEqual(
      expect.objectContaining({ path: '.', error: expect.objectContaining({ category: 'limit' }) })
    )
    expect(
      snapshot.repositories.find((repository) => repository.context.id === snapshot.rootContextId)
        ?.incomplete
    ).toBe(true)
    expect(snapshot.repositories.length).toBeLessThanOrEqual(snapshot.limits.maxContexts)
  }, 30_000)
})

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mutateGitWorkspace } from './git-workspace-mutation'
import { getStatus } from './status-read'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'

const fixtures: GitWorkspaceFixture[] = []
const savedEnv = { ...process.env }
let fixtureHome = ''

beforeAll(async () => {
  fixtureHome = await mkdtemp(path.join(tmpdir(), 'orca-submodule-lifecycle-home-'))
  process.env.HOME = fixtureHome
  process.env.USERPROFILE = fixtureHome
  process.env.GIT_CONFIG_GLOBAL = path.join(fixtureHome, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

afterAll(async () => {
  process.env = { ...savedEnv }
  await rm(fixtureHome, { recursive: true, force: true })
})
describe('submodule lifecycle (real Git)', () => {
  it('removes parent metadata without deleting the initialized checkout or its local commit', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    await writeFile(path.join(fixture.one, 'file.txt'), 'unpublished child work\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'unpublished child commit'])
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.two.branch',
      'protected-local-choice'
    ])
    const status = await getStatus(fixture.root, {
      includeWorkspace: true,
      includeLineStats: false
    })
    const root = status.workspace?.repositories.find(
      (repository) => repository.context.id === status.workspace?.rootContextId
    )
    if (!root) {
      throw new Error('root repository missing from workspace discovery')
    }
    const childHead = await fixture.git(path.join(fixture.root, 'one'), ['rev-parse', 'HEAD'])
    const localUrl = await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleRemove',
      contextId: root.context.id,
      filePath: 'one'
    })
    expect(preview.outcome).toBe('succeeded')
    expect(preview.preview).toMatchObject({ operation: 'remove', filePath: 'one' })
    const previewId =
      preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    if (!previewId) {
      throw new Error('remove preview token missing')
    }
    const removed = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleRemove',
      contextId: root.context.id,
      filePath: 'one',
      previewId
    })
    expect(removed.outcome).toBe('succeeded')
    await expect(access(path.join(fixture.root, 'one', 'file.txt'))).resolves.toBeUndefined()
    await expect(fixture.git(path.join(fixture.root, 'one'), ['rev-parse', 'HEAD'])).resolves.toBe(
      childHead
    )
    await expect(
      fixture.git(fixture.root, ['config', '-f', '.gitmodules', '--get', 'submodule.same.path'], 1)
    ).resolves.toBe('')
    await expect(
      fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
    ).resolves.toBe(localUrl)
    await expect(fixture.git(fixture.root, ['ls-files', '--stage', '--', 'one'])).resolves.toBe('')
    expect(
      await fixture.git(fixture.root, [
        'config',
        '-f',
        '.gitmodules',
        '--get',
        'submodule.two.branch'
      ])
    ).toBe('protected-local-choice')
    expect(await fixture.git(fixture.root, ['diff', '--cached', '--name-only'])).toBe('one')
  })
  it('previews relative URL resolution without changing repository state or reading the remote', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const remote = path.join(fixture.directory, 'parent.git')
    await fixture.git(fixture.directory, ['init', '-q', '--bare', remote])
    await fixture.git(fixture.root, ['remote', 'add', 'origin', remote])
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.same.url',
      '../old-child.git'
    ])
    const before = await getStatus(fixture.root, {
      includeWorkspace: true,
      includeLineStats: false
    })
    const root = before.workspace?.repositories.find(
      (repository) => repository.context.id === before.workspace?.rootContextId
    )
    if (!root) {
      throw new Error('root repository missing from workspace discovery')
    }
    const localUrl = await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleSyncUrl',
      contextId: root.context.id,
      filePath: 'one',
      url: '../new-child.git'
    })
    expect(preview.outcome).toBe('succeeded')
    expect(preview.preview).toMatchObject({
      operation: 'syncUrl',
      declaredUrl: '../new-child.git',
      effectiveUrl: path.join(fixture.directory, 'new-child.git'),
      previousDeclaredUrl: '../old-child.git',
      previousEffectiveUrl: localUrl
    })
    const after = await getStatus(fixture.root, { includeWorkspace: true, includeLineStats: false })
    expect(
      after.workspace?.repositories.find((repository) => repository.context.id === root.context.id)
        ?.expectedState
    ).toBe(root.expectedState)
    await expect(
      fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
    ).resolves.toBe(localUrl)
  })
  it('checks out a reviewed remote-tracking OID without fetching and revalidates it on apply', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const childPath = path.join(fixture.root, 'one')
    const parentHead = await fixture.git(childPath, ['rev-parse', 'HEAD'])
    await fixture.git(childPath, ['commit', '--allow-empty', '-m', 'remote target'])
    const remoteOid = await fixture.git(childPath, ['rev-parse', 'HEAD'])
    await fixture.git(childPath, ['reset', '--hard', parentHead])
    await fixture.git(childPath, ['update-ref', 'refs/remotes/origin/remote-target', remoteOid])
    const status = await getStatus(fixture.root, {
      includeWorkspace: true,
      includeLineStats: false
    })
    const root = status.workspace?.repositories.find(
      (repository) => repository.context.id === status.workspace?.rootContextId
    )
    if (!root) {
      throw new Error('root repository missing from workspace discovery')
    }
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleCheckout',
      contextId: root.context.id,
      filePath: 'one',
      refName: remoteOid
    })
    expect(preview.outcome).toBe('succeeded')
    expect(preview.preview).toMatchObject({
      operation: 'checkout',
      targetOid: remoteOid,
      detached: true
    })
    const previewId =
      preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    if (!previewId) {
      throw new Error('checkout preview token missing')
    }
    const applied = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleCheckout',
      contextId: root.context.id,
      filePath: 'one',
      refName: remoteOid,
      previewId
    })
    expect(applied.outcome).toBe('succeeded')
    await expect(fixture.git(childPath, ['rev-parse', 'HEAD'])).resolves.toBe(remoteOid)
    await expect(
      fixture.git(childPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 1)
    ).resolves.toBe('')
  })
  it.each([
    { checkout: 'root', target: 'two', recursive: false },
    { checkout: 'root', target: 'one', recursive: true },
    { checkout: 'one', target: 'same', recursive: true }
  ] as const)(
    'initializes $target relative to $checkout without changing its index',
    async ({ checkout, target, recursive }) => {
      const fixture = await createGitWorkspaceFixture()
      fixtures.push(fixture)
      const parentPath = checkout === 'root' ? fixture.root : fixture.one
      if (target === 'one') {
        await fixture.git(fixture.one, ['submodule', 'deinit', 'same'])
      }
      await fixture.git(parentPath, ['submodule', 'deinit', target])
      const parentIndex = await fixture.git(parentPath, ['ls-files', '--stage'])
      const status = await getStatus(fixture.root, {
        includeWorkspace: true,
        includeLineStats: false
      })
      if (target === 'one') {
        expect(status.workspace?.submodules.some((entry) => entry.path === 'one/same')).toBe(false)
      }
      const parent = status.workspace?.repositories.find(
        (repository) =>
          repository.context.checkoutPath === parentPath ||
          repository.context.checkoutPath.replace(/^\/private(?=\/var\/)/, '') ===
            parentPath.replace(/^\/private(?=\/var\/)/, '')
      )
      if (!parent) {
        throw new Error('parent context not discovered')
      }
      const request = { contextId: parent.context.id, filePath: target, recursive }
      const preview = await mutateGitWorkspace(fixture.root, {
        action: 'previewSubmoduleInitialize',
        ...request
      })
      expect(preview.outcome, preview.error).toBe('succeeded')
      const applied = await mutateGitWorkspace(fixture.root, {
        action: 'submoduleInitialize',
        ...request,
        previewId:
          preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
      })
      expect(applied.outcome, applied.error).toBe('succeeded')
      expect(await fixture.git(path.join(parentPath, target), ['rev-parse', 'HEAD'])).toBe(
        await fixture.git(parentPath, ['rev-parse', `:${target}`])
      )
      expect(await fixture.git(parentPath, ['ls-files', '--stage'])).toBe(parentIndex)
      if (target === 'one') {
        const initialized = await getStatus(fixture.root, {
          includeWorkspace: true,
          includeLineStats: false
        })
        expect(
          initialized.workspace?.submodules.find((entry) => entry.path === 'one/same')
        ).toMatchObject({
          availability: 'initialized',
          currentOid: await fixture.git(fixture.nested, ['rev-parse', 'HEAD'])
        })
        expect(await fixture.git(fixture.nested, ['rev-parse', 'HEAD'])).toBe(
          await fixture.git(fixture.one, ['rev-parse', ':same'])
        )
      }
    }
  )

  it('applies relative URL synchronization locally and rejects a reused stale preview', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const remote = path.join(fixture.directory, 'parent.git')
    await fixture.git(fixture.root, ['remote', 'add', 'origin', remote])
    const request = { filePath: 'one', url: '../new-child.git' }
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleSyncUrl',
      ...request
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    const previewId =
      preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    const applied = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleSyncUrl',
      ...request,
      previewId
    })
    expect(applied.outcome, applied.error).toBe('succeeded')
    expect(
      await fixture.git(fixture.root, [
        'config',
        '-f',
        '.gitmodules',
        '--get',
        'submodule.same.url'
      ])
    ).toBe('../new-child.git')
    expect(await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])).toBe(
      path.join(fixture.directory, 'new-child.git')
    )
    expect(await fixture.git(fixture.one, ['remote', 'get-url', 'origin'])).toBe(
      path.join(fixture.directory, 'new-child.git')
    )
    const reused = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleSyncUrl',
      ...request,
      previewId
    })
    expect(reused).toMatchObject({ outcome: 'failed', errorCategory: 'stale' })
  })

  it('adds an explicitly reviewed local source without writing during preview', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const request = { filePath: 'added', url: path.join(fixture.directory, 'leaf') }
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleAdd',
      ...request
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    await expect(access(path.join(fixture.root, 'added'))).rejects.toThrow()
    const added = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleAdd',
      ...request,
      previewId:
        preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    })
    expect(added.outcome, added.error).toBe('succeeded')
    const oid = await fixture.git(path.join(fixture.root, 'added'), ['rev-parse', 'HEAD'])
    expect(await fixture.git(fixture.root, ['rev-parse', ':added'])).toBe(oid)
    expect(
      await fixture.git(fixture.root, [
        'config',
        '-f',
        '.gitmodules',
        '--get',
        'submodule.added.path'
      ])
    ).toBe('added')
  })

  it('refuses checkout after an external child edit without overwriting the local bytes', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const childOid = await fixture.git(fixture.root, ['rev-parse', ':one'])
    const request = { filePath: 'one', childOid }
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleCheckout',
      ...request
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    await writeFile(path.join(fixture.one, 'file.txt'), 'outside edit must survive\n')
    const applied = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleCheckout',
      ...request,
      previewId:
        preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    })
    expect(applied).toMatchObject({ outcome: 'failed', errorCategory: 'stale' })
    expect(await fixture.git(fixture.one, ['diff', '--', 'file.txt'])).toContain(
      '+outside edit must survive'
    )
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(childOid)
  })
  it('refuses a missing gitlink object in a shallow checkout without fetching or moving HEAD', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const head = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    const gitDir = await fixture.git(fixture.one, ['rev-parse', '--absolute-git-dir'])
    await writeFile(path.join(gitDir, 'shallow'), `${head}\n`)
    const missing = '0123456789012345678901234567890123456789'
    await fixture.git(fixture.root, ['update-index', '--cacheinfo', '160000', missing, 'one'])
    await fixture.git(fixture.one, [
      'remote',
      'set-url',
      'origin',
      'http://127.0.0.1:1/unreachable.git'
    ])
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleCheckout',
      filePath: 'one',
      childOid: missing
    })
    expect(preview).toMatchObject({ outcome: 'failed', errorCategory: 'incomplete' })
    expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(head)
    expect(await fixture.git(fixture.one, ['rev-parse', '--is-shallow-repository'])).toBe('true')
    expect(await fixture.git(fixture.root, ['rev-parse', ':one'])).toBe(missing)
  })

  it('rejects inconsistent declarations rather than writing a guessed checkout', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const before = await fixture.git(fixture.root, ['ls-files', '--stage'])
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.same.path',
      'other-path'
    ])
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleRemove',
      filePath: 'one'
    })
    expect(preview).toMatchObject({ outcome: 'failed', errorCategory: 'incomplete' })
    expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(before)
    await expect(access(path.join(fixture.one, 'file.txt'))).resolves.toBeUndefined()
  })

  it('initializes a linked parent worktree without changing the original parent checkout', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const originalHead = await fixture.git(fixture.two, ['rev-parse', 'HEAD'])
    const originalIndex = await fixture.git(fixture.root, ['ls-files', '--stage'])
    const request = { filePath: 'two', recursive: false }
    const preview = await mutateGitWorkspace(fixture.second, {
      action: 'previewSubmoduleInitialize',
      ...request
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    const result = await mutateGitWorkspace(fixture.second, {
      action: 'submoduleInitialize',
      ...request,
      previewId:
        preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    })
    expect(result.outcome, result.error).toBe('succeeded')
    expect(await fixture.git(path.join(fixture.second, 'two'), ['rev-parse', 'HEAD'])).toBe(
      originalHead
    )
    expect(await fixture.git(fixture.two, ['rev-parse', 'HEAD'])).toBe(originalHead)
    expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(originalIndex)
  })
  it('reports an unavailable initialize remote without staging parent files and consumes the failed preview', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    await fixture.git(fixture.root, ['submodule', 'deinit', 'two'])
    const modulesPath = await fixture.git(fixture.root, ['rev-parse', '--git-path', 'modules/two'])
    await rm(path.resolve(fixture.root, modulesPath), { recursive: true, force: true })
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.two.url',
      'http://127.0.0.1:1/offline.git'
    ])
    const index = await fixture.git(fixture.root, ['ls-files', '--stage'])
    const request = { filePath: 'two', recursive: false }
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleInitialize',
      ...request
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    const previewId =
      preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    const result = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleInitialize',
      ...request,
      previewId
    })
    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/connect|clone|access|refused/i)
    expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(index)
    const reused = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleInitialize',
      ...request,
      previewId
    })
    expect(reused).toMatchObject({ outcome: 'failed', errorCategory: 'stale' })
  })
  it('refuses synchronization if unreviewed .gitmodules bytes change without changing the path or URL', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.same.branch',
      'main'
    ])
    const originalUrl = await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
    const preview = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleSyncUrl',
      filePath: 'one'
    })
    expect(preview.outcome, preview.error).toBe('succeeded')
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.same.branch',
      'external'
    ])
    const result = await mutateGitWorkspace(fixture.root, {
      action: 'submoduleSyncUrl',
      filePath: 'one',
      previewId:
        preview.preview && 'previewId' in preview.preview ? preview.preview.previewId : undefined
    })
    expect(result).toMatchObject({ outcome: 'failed', errorCategory: 'stale' })
    expect(
      await fixture.git(fixture.root, [
        'config',
        '-f',
        '.gitmodules',
        '--get',
        'submodule.same.branch'
      ])
    ).toBe('external')
    expect(await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])).toBe(
      originalUrl
    )
  })

  it('does not implicitly stage unrelated .gitmodules edits during add', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    await fixture.git(fixture.root, [
      'config',
      '-f',
      '.gitmodules',
      'submodule.same.branch',
      'external'
    ])
    const index = await fixture.git(fixture.root, ['ls-files', '--stage'])
    const result = await mutateGitWorkspace(fixture.root, {
      action: 'previewSubmoduleAdd',
      filePath: 'new-module',
      url: path.join(fixture.directory, 'leaf')
    })
    expect(result).toMatchObject({ outcome: 'failed', errorCategory: 'dirty' })
    expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(index)
    await expect(access(path.join(fixture.root, 'new-module'))).rejects.toThrow()
  })
})

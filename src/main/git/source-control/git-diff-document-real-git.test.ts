import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'
import { getDiff } from './file-diff'
import { getStatus } from './status-read'
import { getCommitDiff } from './commit-diff'
import { getBranchDiff } from './branch-diff'

describe('Git diff documents at the real repository boundary', () => {
  let fixture: GitWorkspaceFixture
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

  it('compares both rename paths and keeps index separate from worktree in a child context', async () => {
    const before = await readFile(path.join(fixture.one, 'file.txt'), 'utf8')
    await fixture.git(fixture.one, ['mv', 'file.txt', 'новое\n\t name.txt'])
    await writeFile(
      path.join(fixture.one, 'новое\n\t name.txt'),
      'working\r\nwithout final newline'
    )
    const snapshot = (await getStatus(fixture.root, { includeWorkspace: true })).workspace!
    const contextId = snapshot.submodules.find((entry) => entry.path === 'one')!.contextId!
    const staged = await getDiff(
      fixture.root,
      'новое\n\t name.txt',
      true,
      false,
      {},
      {
        contextId,
        oldPath: 'file.txt',
        left: { kind: 'head' },
        right: { kind: 'index' }
      }
    )
    expect(staged.originalContent).toBe(before)
    expect(staged.modifiedContent).toBe(before)
    const unstaged = await getDiff(
      fixture.root,
      'новое\n\t name.txt',
      false,
      false,
      {},
      {
        contextId,
        left: { kind: 'index' },
        right: { kind: 'worktree' }
      }
    )
    expect(unstaged.originalContent).toBe(before)
    expect(unstaged.modifiedContent).toBe('working\r\nwithout final newline')
    expect(await fixture.git(fixture.one, ['show', ':новое\n\t name.txt'])).toBe(before.trim())
  }, 30_000)

  it.each(['root', 'one'] as const)(
    'preserves added/deleted/text/binary/large/symlink/mode and pinned commit sides in %s',
    async (name) => {
      const cwd = fixture[name]
      await writeFile(path.join(cwd, 'file.txt'), 'staged\r\nno newline')
      await writeFile(path.join(cwd, 'delete.txt'), 'deleted original\n')
      await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]))
      await fixture.git(cwd, ['add', '.'])
      await fixture.git(cwd, ['commit', '-qm', 'diff baseline'])
      const base = await fixture.git(cwd, ['rev-parse', 'HEAD'])
      await rm(path.join(cwd, 'delete.txt'))
      await writeFile(path.join(cwd, 'added.txt'), 'added content\n')
      await writeFile(path.join(cwd, 'file.txt'), 'index\r\nno newline')
      await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 3, 4]))
      await fixture.git(cwd, ['add', '.'])
      await writeFile(path.join(cwd, 'file.txt'), 'working\r\nno final newline')
      const statusBefore = await fixture.git(cwd, ['status', '--porcelain=v2'])
      const staged = await getDiff(cwd, 'file.txt', true)
      const unstaged = await getDiff(cwd, 'file.txt', false)
      expect(staged).toMatchObject({
        originalContent: 'staged\r\nno newline',
        modifiedContent: 'index\r\nno newline',
        document: {
          stale: false,
          left: { lineEndings: 'CRLF', finalNewline: false },
          right: { source: { kind: 'index' } }
        }
      })
      expect(unstaged).toMatchObject({
        originalContent: 'index\r\nno newline',
        modifiedContent: 'working\r\nno final newline'
      })
      expect(await getDiff(cwd, 'added.txt', true)).toMatchObject({
        originalContent: '',
        modifiedContent: 'added content\n',
        document: { left: { exists: false } }
      })
      expect(await getDiff(cwd, 'delete.txt', true)).toMatchObject({
        originalContent: 'deleted original\n',
        modifiedContent: '',
        document: { right: { exists: false } }
      })
      expect(await getDiff(cwd, 'binary.bin', true)).toMatchObject({
        kind: 'binary',
        originalIsBinary: true,
        modifiedIsBinary: true
      })
      expect(await fixture.git(cwd, ['status', '--porcelain=v2'])).toBe(statusBefore)
      await fixture.git(cwd, ['commit', '-qm', 'pinned commit'])
      const head = await fixture.git(cwd, ['rev-parse', 'HEAD'])
      const expected = {
        originalContent: 'staged\r\nno newline',
        modifiedContent: 'index\r\nno newline'
      }
      expect(
        await getCommitDiff(cwd, { commitOid: head, parentOid: base, filePath: 'file.txt' })
      ).toMatchObject(expected)
      expect(
        await getBranchDiff(cwd, { headOid: head, mergeBase: base, filePath: 'file.txt' })
      ).toMatchObject(expected)
      await writeFile(path.join(cwd, 'huge.txt'), Buffer.alloc(9 * 1024 * 1024, 65))
      expect(await getDiff(cwd, 'huge.txt', false)).toMatchObject({
        modifiedContent: '',
        document: { special: 'large', right: { bytes: 9 * 1024 * 1024 } }
      })
      await fixture.git(cwd, ['add', 'huge.txt'])
      expect(await getDiff(cwd, 'huge.txt', true)).toMatchObject({
        modifiedContent: '',
        document: { special: 'large' }
      })
      await writeFile(path.join(cwd, 'unsupported.txt'), Buffer.from([0xc3, 0x28]))
      expect(await getDiff(cwd, 'unsupported.txt', false)).toMatchObject({
        modifiedContent: '',
        document: { special: 'encoding' }
      })
      await symlink('/outside-workspace-not-readable', path.join(cwd, 'link'))
      expect(await getDiff(cwd, 'link', false)).toMatchObject({
        modifiedContent: '/outside-workspace-not-readable',
        document: { special: 'symlink', right: { mode: '120000' } }
      })
      await chmod(path.join(cwd, 'file.txt'), 0o755)
      expect(await getDiff(cwd, 'file.txt', false)).toMatchObject({
        document: { special: 'mode', left: { mode: '100644' }, right: { mode: '100755' } }
      })
    },
    60_000
  )

  it('rejects borrowed contexts and escaping paths, exposes gitlink commit identity, and handles unborn HEAD', async () => {
    await writeFile(path.join(fixture.one, 'file.txt'), 'new child commit\n')
    await fixture.git(fixture.one, ['commit', '-qam', 'new child'])
    await writeFile(path.join(fixture.two, 'file.txt'), 'second child commit\n')
    await fixture.git(fixture.two, ['commit', '-qam', 'new sibling'])
    const snapshot = (await getStatus(fixture.root, { includeWorkspace: true })).workspace!
    const rootId = snapshot.rootContextId!
    expect(
      snapshot.repositories.find((repo) => repo.context.id === rootId)?.entries
    ).toContainEqual(expect.objectContaining({ path: 'one', area: 'unstaged', status: 'modified' }))
    expect(
      snapshot.repositories.find((repo) => repo.context.id === rootId)?.entries
    ).toContainEqual(expect.objectContaining({ path: 'two', area: 'unstaged', status: 'modified' }))
    expect(
      (await getStatus(fixture.root, { includeWorkspace: true })).workspace?.repositories.find(
        (repo) => repo.context.id === rootId
      )?.expectedState
    ).toBe(snapshot.repositories.find((repo) => repo.context.id === rootId)?.expectedState)
    expect(
      snapshot.repositories.find(
        (repo) =>
          repo.context.id === snapshot.submodules.find((module) => module.path === 'two')?.contextId
      )?.entries
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'one' })]))
    const selection = {
      contextId: rootId,
      left: { kind: 'index' as const },
      right: { kind: 'worktree' as const }
    }
    const pointer = await getDiff(fixture.root, 'one', false, false, {}, selection)
    expect(pointer.document).toMatchObject({
      special: 'gitlink',
      childContextId: snapshot.submodules.find((entry) => entry.path === 'one')!.contextId,
      right: { oid: await fixture.git(fixture.one, ['rev-parse', 'HEAD']) }
    })
    expect(pointer.document?.left.oid).not.toBe(pointer.document?.right.oid)
    const legacyPointer = await getDiff(fixture.root, 'one', false)
    expect(legacyPointer.document).toMatchObject({
      special: 'gitlink',
      childContextId: snapshot.submodules.find((entry) => entry.path === 'one')!.contextId
    })
    expect(await getDiff(fixture.root, 'one/file.txt', false)).toMatchObject({
      originalContent: 'source initial\n',
      modifiedContent: 'new child commit\n'
    })
    await expect(getDiff(fixture.second, 'file.txt', false, false, {}, selection)).rejects.toThrow(
      'Access denied'
    )
    await expect(getDiff(fixture.root, '../outside', false, false, {}, selection)).rejects.toThrow(
      'Access denied'
    )
    await symlink(fixture.home, path.join(fixture.root, 'escape'))
    await expect(
      getDiff(fixture.root, 'escape/secret.txt', false, false, {}, selection)
    ).rejects.toThrow('symlink')
    const unborn = path.join(fixture.directory, 'unborn')
    await mkdir(unborn)
    await fixture.git(unborn, ['init', '-q'])
    await writeFile(path.join(unborn, 'new.txt'), 'unborn staged\n')
    await fixture.git(unborn, ['add', '.'])
    expect(await getDiff(unborn, 'new.txt', true)).toMatchObject({
      originalContent: '',
      modifiedContent: 'unborn staged\n',
      document: { left: { exists: false } }
    })
  }, 60_000)
})

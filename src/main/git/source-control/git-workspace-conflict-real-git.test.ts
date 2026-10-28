import { link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'
import { mutateGitWorkspace } from './git-workspace-mutation'
import { getStatus } from './status-read'
import type { GitWorkspaceConflictDocument } from '../../../shared/git-workspace-conflict'

let fixture: GitWorkspaceFixture
const savedEnv = { ...process.env }
let sequence = 0
beforeAll(async () => {
  fixture = await createGitWorkspaceFixture()
  process.env = { ...fixture.env }
})
afterAll(async () => {
  process.env = savedEnv
  await rm(fixture.directory, { recursive: true, force: true })
})

async function conflictRepo(kind = 'text'): Promise<string> {
  const cwd = path.join(fixture.directory, `conflict-${sequence++}`)
  await mkdir(cwd)
  await fixture.git(cwd, ['init', '-b', 'main'])
  await fixture.git(cwd, ['config', 'user.name', 'Conflict Test'])
  await fixture.git(cwd, ['config', 'user.email', 'conflict@example.invalid'])
  await fixture.git(cwd, ['config', 'commit.gpgsign', 'false'])
  await writeFile(path.join(cwd, 'file'), kind === 'binary' ? Buffer.from([0, 1, 2]) : 'base\n')
  await fixture.git(cwd, ['add', '.'])
  await fixture.git(cwd, ['commit', '-qm', 'base'])
  await fixture.git(cwd, ['checkout', '-b', 'incoming'])
  await writeFile(
    path.join(cwd, 'file'),
    kind === 'binary' ? Buffer.from([0, 255, 254]) : 'incoming\n'
  )
  await fixture.git(cwd, ['add', '.'])
  await fixture.git(cwd, ['commit', '-qm', 'incoming'])
  await fixture.git(cwd, ['checkout', 'main'])
  await writeFile(
    path.join(cwd, 'file'),
    kind === 'binary' ? Buffer.from([0, 128, 129]) : 'current\n'
  )
  await fixture.git(cwd, ['add', '.'])
  await fixture.git(cwd, ['commit', '-qm', 'current'])
  return cwd
}

async function review(cwd: string, filePath = 'file'): Promise<GitWorkspaceConflictDocument> {
  const status = await getStatus(cwd, { includeWorkspace: true, includeLineStats: false })
  const contextId = status.workspace?.rootContextId
  const receipt = await mutateGitWorkspace(cwd, { action: 'readConflict', contextId, filePath })
  if (!receipt.conflict) {
    throw new Error(receipt.error ?? 'No conflict document')
  }
  return receipt.conflict
}

async function finish(cwd: string, action: 'continueOperation' | 'abortOperation') {
  const status = await getStatus(cwd, { includeWorkspace: true, includeLineStats: false })
  return mutateGitWorkspace(cwd, {
    action,
    contextId: status.workspace?.rootContextId,
    expectedHead: status.head ?? ''
  })
}

describe('host-authorized conflict documents with real Git', () => {
  it.each(['merge', 'rebase', 'cherry-pick'] as const)(
    'saves without resolving, explicitly resolves and continues %s',
    async (operation) => {
      const cwd = await conflictRepo()
      await fixture.git(cwd, [operation, 'incoming'], 1)
      const document = await review(cwd)
      expect(document.operation).toBe(operation)
      expect(document.ours.content).toEqual({
        kind: 'text',
        content: operation === 'rebase' ? 'incoming\n' : 'current\n'
      })
      expect(document.theirs.content).toEqual({
        kind: 'text',
        content: operation === 'rebase' ? 'current\n' : 'incoming\n'
      })
      const before = await fixture.git(cwd, ['ls-files', '--unmerged'])
      const saved = await mutateGitWorkspace(cwd, {
        action: 'saveConflict',
        contextId: document.contextId,
        documentId: document.documentId,
        content: 'combined\n'
      })
      expect(saved.outcome).toBe('succeeded')
      expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe(before)
      expect((await finish(cwd, 'continueOperation')).outcome).toBe('failed')
      const resolved = await mutateGitWorkspace(cwd, {
        action: 'resolveConflict',
        contextId: document.contextId,
        documentId: saved.conflict?.documentId,
        resolution: 'result'
      })
      expect(resolved.outcome).toBe('succeeded')
      expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe('')
      expect((await finish(cwd, 'continueOperation')).outcome).toBe('succeeded')
      expect(await fixture.git(cwd, ['show', 'HEAD:file'])).toBe('combined')
      expect((await getStatus(cwd)).operationInProgress).toBe(false)
    }
  )

  it.each(['merge', 'rebase', 'cherry-pick'] as const)(
    'aborts the actual %s operation',
    async (operation) => {
      const cwd = await conflictRepo()
      const before = await fixture.git(cwd, ['rev-parse', 'HEAD'])
      await fixture.git(cwd, [operation, 'incoming'], 1)
      expect((await finish(cwd, 'abortOperation')).outcome).toBe('succeeded')
      expect(await fixture.git(cwd, ['rev-parse', 'HEAD'])).toBe(before)
      expect(await readFile(path.join(cwd, 'file'), 'utf8')).toBe('current\n')
    }
  )

  it('normalizes a saved CRLF result for the index using the path attributes', async () => {
    const cwd = await conflictRepo()
    await writeFile(path.join(cwd, '.gitattributes'), 'file text eol=crlf\n')
    await fixture.git(cwd, ['add', '.gitattributes'])
    await fixture.git(cwd, ['commit', '-qm', 'checkout line endings'])
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    const document = await review(cwd)
    const saved = await mutateGitWorkspace(cwd, {
      action: 'saveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      content: 'resolved\r\nsecond\r\n'
    })
    expect(saved.outcome).toBe('succeeded')
    const resolved = await mutateGitWorkspace(cwd, {
      action: 'resolveConflict',
      contextId: document.contextId,
      documentId: saved.conflict?.documentId,
      resolution: 'result'
    })
    expect(resolved.outcome).toBe('succeeded')
    expect(await fixture.git(cwd, ['show', ':file'])).toBe('resolved\nsecond')
    expect(await readFile(path.join(cwd, 'file'), 'utf8')).toBe('resolved\r\nsecond\r\n')
  })

  it('refuses external worktree edits and changed index stages, preserving unrelated state', async () => {
    const cwd = await conflictRepo()
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    let document = await review(cwd)
    await writeFile(path.join(cwd, 'unrelated'), 'staged\n')
    await fixture.git(cwd, ['add', 'unrelated'])
    await writeFile(path.join(cwd, 'unrelated'), 'working\n')
    await writeFile(path.join(cwd, 'file'), 'external\n')
    const stale = await mutateGitWorkspace(cwd, {
      action: 'saveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      content: 'overwrite\n'
    })
    expect(stale.errorCategory).toBe('stale')
    expect(await readFile(path.join(cwd, 'file'), 'utf8')).toBe('external\n')
    document = await review(cwd)
    await fixture.git(cwd, ['add', 'file'])
    const changedIndex = await mutateGitWorkspace(cwd, {
      action: 'resolveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      resolution: 'ours'
    })
    expect(changedIndex.errorCategory).toBe('stale')
    expect(await fixture.git(cwd, ['show', ':unrelated'])).toBe('staged')
    expect(await readFile(path.join(cwd, 'unrelated'), 'utf8')).toBe('working\n')
  })

  it('refuses to overwrite an outside file through a hardlinked conflict result', async () => {
    const cwd = await conflictRepo()
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    const outside = path.join(fixture.directory, `outside-hardlink-${sequence++}`)
    await writeFile(outside, 'outside original\n')
    await rm(path.join(cwd, 'file'))
    await link(outside, path.join(cwd, 'file'))
    const document = await review(cwd)
    const receipt = await mutateGitWorkspace(cwd, {
      action: 'saveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      content: 'saved inside the checkout\n'
    })
    expect(await readFile(outside, 'utf8')).toBe('outside original\n')
    expect(receipt.outcome).toBe('failed')
    expect(receipt.errorCategory).toBe('access-denied')
  })

  it('preserves exact binary bytes when selecting a side', async () => {
    const cwd = await conflictRepo('binary')
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    const document = await review(cwd)
    expect(document.kind).toBe('binary')
    expect(document.editable).toBe(false)
    const receipt = await mutateGitWorkspace(cwd, {
      action: 'resolveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      resolution: 'theirs'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(await readFile(path.join(cwd, 'file'))).toEqual(Buffer.from([0, 255, 254]))
    expect(await fixture.git(cwd, ['rev-parse', ':file'])).toBe(document.theirs.oid)
  })

  it('supports add/add and explicit modify/delete without guessing marker state', async () => {
    const cwd = await conflictRepo()
    await fixture.git(cwd, ['checkout', 'incoming'])
    await writeFile(path.join(cwd, 'added'), 'incoming addition\n')
    await fixture.git(cwd, ['add', 'added'])
    await fixture.git(cwd, ['rm', 'file'])
    await fixture.git(cwd, ['commit', '-qm', 'delete and add'])
    await fixture.git(cwd, ['checkout', 'main'])
    await writeFile(path.join(cwd, 'added'), 'current addition\n')
    await fixture.git(cwd, ['add', 'added'])
    await fixture.git(cwd, ['commit', '-qm', 'add'])
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    const added = await review(cwd, 'added')
    expect(added.kind).toBe('add-add')
    expect(
      (
        await mutateGitWorkspace(cwd, {
          action: 'resolveConflict',
          contextId: added.contextId,
          documentId: added.documentId,
          resolution: 'ours'
        })
      ).outcome
    ).toBe('succeeded')
    const deleted = await review(cwd)
    expect(deleted.kind).toBe('modify-delete')
    expect(
      (
        await mutateGitWorkspace(cwd, {
          action: 'resolveConflict',
          contextId: deleted.contextId,
          documentId: deleted.documentId,
          resolution: 'delete'
        })
      ).outcome
    ).toBe('succeeded')
    expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe('')
    expect(await fixture.git(cwd, ['ls-files', 'file'])).toBe('')
    expect(await readFile(path.join(cwd, 'added'), 'utf8')).toBe('current addition\n')
  })

  it('resolves rename/delete at the renamed index path and exposes its original path', async () => {
    const cwd = await conflictRepo()
    await fixture.git(cwd, ['checkout', '-b', 'rename-base', 'incoming'])
    await writeFile(path.join(cwd, 'file'), 'shared rename content\n')
    await fixture.git(cwd, ['commit', '-qam', 'rename base'])
    await fixture.git(cwd, ['checkout', '-b', 'rename-incoming'])
    await fixture.git(cwd, ['mv', 'file', 'renamed'])
    await fixture.git(cwd, ['commit', '-qm', 'rename'])
    await fixture.git(cwd, ['checkout', 'rename-base'])
    await fixture.git(cwd, ['rm', 'file'])
    await fixture.git(cwd, ['commit', '-qm', 'delete'])
    await fixture.git(cwd, ['merge', 'rename-incoming'], 1)
    const document = await review(cwd, 'renamed')
    expect(document.kind).toBe('rename')
    expect(document.relatedPaths).toContain('file')
    const receipt = await mutateGitWorkspace(cwd, {
      action: 'resolveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      resolution: 'theirs'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe('')
    expect(await fixture.git(cwd, ['show', ':renamed'])).toBe('shared rename content')
    expect(await fixture.git(cwd, ['ls-files', 'file'])).toBe('')
  })

  it('rejects traversal and a symlinked parent without changing outside content', async () => {
    const cwd = await conflictRepo()
    await fixture.git(cwd, ['merge', 'incoming'], 1)
    const document = await review(cwd)
    const denied = await mutateGitWorkspace(cwd, {
      action: 'readConflict',
      contextId: document.contextId,
      filePath: '..\\outside\\file'
    })
    expect(denied.outcome).toBe('failed')
    const outside = path.join(fixture.directory, `outside-${sequence++}`)
    await mkdir(outside)
    await writeFile(path.join(outside, 'file'), 'outside\n')
    await symlink(outside, path.join(cwd, 'linked'), 'dir')
    const linked = await mutateGitWorkspace(cwd, {
      action: 'readConflict',
      contextId: document.contextId,
      filePath: 'linked/file'
    })
    expect(linked.outcome).toBe('failed')
    expect(await readFile(path.join(outside, 'file'), 'utf8')).toBe('outside\n')
  })

  it('records parent gitlink resolution without modifying dirty child files or its index', async () => {
    const cwd = fixture.root
    const child = fixture.one
    const base = await fixture.git(child, ['rev-parse', 'HEAD'])
    await fixture.git(child, ['checkout', '-b', 'conflict-left'])
    await writeFile(path.join(child, 'file.txt'), 'left\n')
    await fixture.git(child, ['add', 'file.txt'])
    await fixture.git(child, ['commit', '-qm', 'left child'])
    const left = await fixture.git(child, ['rev-parse', 'HEAD'])
    await fixture.git(child, ['checkout', '-b', 'conflict-right', base])
    await writeFile(path.join(child, 'file.txt'), 'right\n')
    await fixture.git(child, ['add', 'file.txt'])
    await fixture.git(child, ['commit', '-qm', 'right child'])
    const right = await fixture.git(child, ['rev-parse', 'HEAD'])
    await fixture.git(cwd, ['checkout', '-b', 'gitlink-incoming'])
    await fixture.git(cwd, ['update-index', '--cacheinfo', `160000,${right},one`])
    await fixture.git(cwd, ['commit', '-qm', 'right link'])
    await fixture.git(cwd, ['checkout', 'main'])
    await fixture.git(cwd, ['update-index', '--cacheinfo', `160000,${left},one`])
    await fixture.git(cwd, ['commit', '-qm', 'left link'])
    await fixture.git(cwd, ['merge', 'gitlink-incoming'], 1)
    await writeFile(path.join(child, 'file.txt'), 'locally committed result\n')
    await fixture.git(child, ['add', 'file.txt'])
    await fixture.git(child, ['commit', '-qm', 'resulting child'])
    const resultingOid = await fixture.git(child, ['rev-parse', 'HEAD'])
    await writeFile(path.join(child, 'file.txt'), 'dirty child\n')
    const index = await fixture.git(child, ['write-tree'])
    const document = await review(cwd, 'one')
    expect(document.kind).toBe('gitlink')
    expect([document.ours.oid, document.theirs.oid]).toEqual([left, right])
    const receipt = await mutateGitWorkspace(cwd, {
      action: 'resolveConflict',
      contextId: document.contextId,
      documentId: document.documentId,
      resolution: 'gitlink',
      childOid: resultingOid
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(await fixture.git(cwd, ['ls-files', '--stage', 'one'])).toBe(
      `160000 ${resultingOid} 0\tone`
    )
    expect(await fixture.git(child, ['write-tree'])).toBe(index)
    expect(await fixture.git(child, ['rev-parse', 'HEAD'])).toBe(resultingOid)
    expect(await readFile(path.join(child, 'file.txt'), 'utf8')).toBe('dirty child\n')
  })
})

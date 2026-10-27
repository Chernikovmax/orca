import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getDiff } from './file-diff'
import { getStatus } from './status-read'
import { mutateGitWorkspace } from './git-workspace-mutation'
import type { GitDiffDocument } from '../../../shared/git-diff-document'
import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GitWorkspaceSnapshot, RepositoryState } from '../../../shared/git-workspace-types'

const tempRoots: string[] = []
const savedEnv = { ...process.env }
let fixtureHome = ''

beforeAll(async () => {
  fixtureHome = await mkdtemp(path.join(tmpdir(), 'orca-stage4-home-'))
  process.env.HOME = fixtureHome
  process.env.USERPROFILE = fixtureHome
  process.env.GIT_CONFIG_GLOBAL = path.join(fixtureHome, 'gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_TERMINAL_PROMPT = '0'
})

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  process.env = { ...savedEnv }
  await rm(fixtureHome, { recursive: true, force: true })
})

function git(cwd: string, args: string[], asBuffer = false): string | Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: asBuffer ? 'buffer' : 'utf8',
    env: process.env
  })
}

function text(cwd: string, args: string[]): string {
  return git(cwd, args) as string
}

function treeOid(cwd: string, revision: string, filePath: string): string {
  const row = text(cwd, ['ls-tree', revision, '--', filePath])
  const match = /^\d+ \w+ ([0-9a-f]+)\t/.exec(row)
  if (!match) {
    throw new Error(`no tree entry for ${filePath}`)
  }
  return match[1]
}

function statusLines(cwd: string, args: string[] = []): string[] {
  return text(cwd, ['status', '--porcelain=v1', ...args]).trimEnd().split('\n')
}

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orca-stage4-repo-'))
  tempRoots.push(dir)
  text(dir, ['init', '-q', '-b', 'main'])
  text(dir, ['config', 'user.email', 'stage4@example.invalid'])
  text(dir, ['config', 'user.name', 'Stage Four'])
  text(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

async function commitAll(repo: string, message: string): Promise<string> {
  text(repo, ['add', '.'])
  text(repo, ['commit', '-qm', message])
  return text(repo, ['rev-parse', 'HEAD']).trim()
}

async function rootState(
  root: string
): Promise<{ repository: RepositoryState; workspace: GitWorkspaceSnapshot }> {
  const status = await getStatus(root, { includeWorkspace: true, includeLineStats: false })
  const workspace = status.workspace
  if (!workspace) {
    throw new Error('workspace snapshot missing')
  }
  const repository = workspace.repositories.find(
    (item) => item.context.id === workspace.rootContextId
  )
  if (!repository) {
    throw new Error('root repository missing')
  }
  return { repository, workspace }
}

async function unstagedDocument(
  root: string,
  contextId: string,
  filePath: string
): Promise<GitDiffDocument> {
  const result = await getDiff(
    root,
    filePath,
    false,
    false,
    {},
    { contextId, left: { kind: 'index' }, right: { kind: 'worktree' } }
  )
  const document = result.document
  if (!document?.id || !document.hunks?.length) {
    throw new Error(`no issued selection for ${filePath}: ${document?.partialUnavailable ?? ''}`)
  }
  return document
}

async function stagedDocument(
  root: string,
  contextId: string,
  filePath: string
): Promise<GitDiffDocument> {
  const result = await getDiff(
    root,
    filePath,
    true,
    false,
    {},
    { contextId, left: { kind: 'head' }, right: { kind: 'index' } }
  )
  const document = result.document
  if (!document?.id || !document.hunks?.length) {
    throw new Error(`no issued staging selection for ${filePath}`)
  }
  return document
}

function lineId(document: GitDiffDocument, kind: 'add' | 'delete', value: string): string {
  const line = document.hunks?.flatMap((hunk) => hunk.lines).find(
    (item) => item.kind === kind && item.text === value
  )
  if (!line) {
    throw new Error(`line ${kind} "${value}" not found in issued hunks`)
  }
  return line.id
}

async function mutate(
  root: string,
  request: GitWorkspaceMutationRequest,
  signal?: AbortSignal
): Promise<GitMutationReceipt> {
  return mutateGitWorkspace(root, request, signal ? { signal } : {})
}

describe('workspace mutation service (real Git)', () => {
  it('stages only the selected line and preserves every other change', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'a.txt'), 'ONE\ntwo\nthree\nfour\nFIVE\n')

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'a.txt')
    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'a.txt',
      documentId: document.id,
      lineIds: [lineId(document, 'add', 'ONE')]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', ':a.txt'])).toBe('ONE\ntwo\nthree\nfour\nfive\n')
    expect(await readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
    expect(text(repo, ['diff', '--cached', '--name-only']).trim()).toBe('a.txt')
    expect(text(repo, ['diff', '--name-only']).trim()).toBe('a.txt')
  })

  it('stages an adjacent hunk in full by hunk id', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'b.txt'), 'one\ntwo\nthree\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'b.txt'), 'ONE\nTWO\nthree\n')

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'b.txt')
    expect(document.hunks).toHaveLength(1)
    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'b.txt',
      documentId: document.id,
      hunkIds: [document.hunks![0].id]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', ':b.txt'])).toBe('ONE\nTWO\nthree\n')
  })

  it('preserves a missing final newline in a partially staged addition', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'c.txt'), 'x')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'c.txt'), 'x\ny')

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'c.txt')
    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'c.txt',
      documentId: document.id,
      lineIds: [lineId(document, 'add', 'y')]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(git(repo, ['show', ':c.txt'], true) as Buffer).toEqual(Buffer.from('x\ny'))
  })

  it('partially stages an untracked file', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'seed.txt'), 'seed\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'd.txt'), 'l1\nl2\n')

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'd.txt')
    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'd.txt',
      documentId: document.id,
      lineIds: [lineId(document, 'add', 'l2')]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', ':d.txt'])).toBe('l2\n')
    expect(await readFile(path.join(repo, 'd.txt'), 'utf8')).toBe('l1\nl2\n')
  })

  it('partially stages a deletion and keeps the unselected lines in the index', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'e.txt'), 'a\nb\nc\n')
    await commitAll(repo, 'initial')
    await rm(path.join(repo, 'e.txt'))

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'e.txt')
    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'e.txt',
      documentId: document.id,
      lineIds: [lineId(document, 'delete', 'b')]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['ls-files', '--', 'e.txt']).trim()).toBe('e.txt')
    expect(text(repo, ['show', ':e.txt'])).toBe('a\nc\n')
    expect(statusLines(repo, ['--', 'e.txt'])).toEqual(['MD e.txt'])
  })

  it('partially unstages only the selected staged line', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'f.txt'), 'one\ntwo\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'f.txt'), 'ONE\nTWO\n')
    text(repo, ['add', 'f.txt'])

    const { repository } = await rootState(repo)
    const document = await stagedDocument(repo, repository.context.id, 'f.txt')
    const receipt = await mutate(repo, {
      action: 'unstage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'f.txt',
      documentId: document.id,
      lineIds: [lineId(document, 'add', 'ONE')]
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', ':f.txt'])).toBe('one\nTWO\n')
    expect(await readFile(path.join(repo, 'f.txt'), 'utf8')).toBe('ONE\nTWO\n')
  })

  it('refuses a stale selection after an external edit and leaves the index alone', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'g.txt'), 'one\ntwo\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'g.txt'), 'ONE\ntwo\n')

    const { repository } = await rootState(repo)
    const document = await unstagedDocument(repo, repository.context.id, 'g.txt')
    const selected = lineId(document, 'add', 'ONE')
    // Same status shape, different bytes: only the content fence can catch this.
    await writeFile(path.join(repo, 'g.txt'), 'OUTSIDE\ntwo\n')

    const receipt = await mutate(repo, {
      action: 'stage',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'g.txt',
      documentId: document.id,
      lineIds: [selected]
    })

    expect(receipt.outcome).toBe('failed')
    expect(receipt.errorCategory).toBe('stale')
    expect(text(repo, ['show', ':g.txt'])).toBe('one\ntwo\n')
    expect(await readFile(path.join(repo, 'g.txt'), 'utf8')).toBe('OUTSIDE\ntwo\n')
    expect(statusLines(repo, ['--', 'g.txt'])).toEqual([' M g.txt'])
  })

  it('commits exactly the real index and leaves other changes untouched', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'h.txt'), 'base\n')
    await writeFile(path.join(repo, 'i.txt'), 'base\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'h.txt'), 'staged\n')
    text(repo, ['add', 'h.txt'])
    await writeFile(path.join(repo, 'h.txt'), 'unstaged\n')
    await writeFile(path.join(repo, 'i.txt'), 'dirty\n')

    const { repository } = await rootState(repo)
    const preview = await mutate(repo, {
      action: 'previewCommit',
      contextId: repository.context.id,
      expectedState: repository.expectedState
    })
    expect(preview.outcome).toBe('succeeded')
    expect(preview.preview).toMatchObject({ stagedFiles: 1, truncated: false })

    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'stage four commit'
    })

    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', 'HEAD:h.txt'])).toBe('staged\n')
    expect(text(repo, ['show', `--format=`, '--name-only', 'HEAD']).trim()).toBe('h.txt')
    expect(await readFile(path.join(repo, 'h.txt'), 'utf8')).toBe('unstaged\n')
    expect(await readFile(path.join(repo, 'i.txt'), 'utf8')).toBe('dirty\n')
    expect(statusLines(repo).sort()).toEqual([
      ' M h.txt',
      ' M i.txt'
    ])
    expect(receipt.expectedState).toBeTruthy()
  })

  it('commits on an unborn HEAD', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'first.txt'), 'first\n')
    text(repo, ['add', 'first.txt'])

    const { repository } = await rootState(repo)
    expect(repository.unborn).toBe(true)
    const preview = await mutate(repo, {
      action: 'previewCommit',
      contextId: repository.context.id,
      expectedState: repository.expectedState
    })
    expect(preview.preview).toMatchObject({ unborn: true, stagedFiles: 1 })

    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'first commit'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', 'HEAD:first.txt'])).toBe('first\n')
  })

  it('commits on a detached HEAD without touching branches', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'file.txt'), 'base\n')
    const base = await commitAll(repo, 'initial')
    text(repo, ['checkout', '-q', '--detach'])
    await writeFile(path.join(repo, 'file.txt'), 'detached\n')
    text(repo, ['add', 'file.txt'])

    const { repository } = await rootState(repo)
    expect(repository.detached).toBe(true)
    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'detached commit'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['rev-parse', 'HEAD']).trim()).not.toBe(base)
    expect(text(repo, ['rev-parse', 'main']).trim()).toBe(base)
  })

  it('reports a busy index instead of writing through a stolen lock', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'lock.txt'), 'base\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'lock.txt'), 'changed\n')
    const lockFile = path.join(repo, '.git', 'index.lock')
    await writeFile(lockFile, '')

    try {
      const { repository } = await rootState(repo)
      const receipt = await mutate(repo, {
        action: 'stage',
        contextId: repository.context.id,
        expectedState: repository.expectedState,
        filePath: 'lock.txt'
      })
      expect(receipt.outcome).toBe('failed')
      expect(receipt.errorCategory).toBe('busy')
      expect(text(repo, ['show', ':lock.txt'])).toBe('base\n')
    } finally {
      await rm(lockFile, { force: true })
    }
  })

  it('surfaces a failing commit hook and reports fresh state', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'hook.txt'), 'base\n')
    const base = await commitAll(repo, 'initial')
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\necho "blocked by policy" >&2\nexit 1\n', { mode: 0o755 })
    await chmod(hook, 0o755)
    await writeFile(path.join(repo, 'hook.txt'), 'changed\n')
    text(repo, ['add', 'hook.txt'])

    const { repository } = await rootState(repo)
    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'should fail'
    })
    expect(receipt.outcome).toBe('failed')
    expect(receipt.errorCategory).toBe('hook')
    expect(receipt.error).toContain('blocked by policy')
    expect(receipt.expectedState).toBeTruthy()
    expect(text(repo, ['rev-parse', 'HEAD']).trim()).toBe(base)
  })

  it('does not hide files a commit hook stages', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
    await commitAll(repo, 'initial')
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    await writeFile(
      hook,
      '#!/bin/sh\necho "from hook" > extra.txt\ngit add extra.txt\n',
      { mode: 0o755 }
    )
    await chmod(hook, 0o755)
    await writeFile(path.join(repo, 'tracked.txt'), 'changed\n')
    text(repo, ['add', 'tracked.txt'])

    const { repository } = await rootState(repo)
    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'hook adds a file'
    })
    expect(receipt.outcome).toBe('succeeded')
    expect(text(repo, ['show', 'HEAD:extra.txt'])).toBe('from hook\n')
    const after = await rootState(repo)
    expect(after.repository.entries).toEqual([])
  })

  it('reports signing failures without disabling signing', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'signed.txt'), 'base\n')
    await commitAll(repo, 'initial')
    text(repo, ['config', 'commit.gpgsign', 'true'])
    text(repo, ['config', 'gpg.program', '/bin/false'])
    await writeFile(path.join(repo, 'signed.txt'), 'changed\n')
    text(repo, ['add', 'signed.txt'])

    const { repository } = await rootState(repo)
    const receipt = await mutate(repo, {
      action: 'commit',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      message: 'signed commit'
    })
    expect(receipt.outcome).toBe('failed')
    expect(receipt.errorCategory).toBe('signing')
    expect(statusLines(repo)).toEqual(['M  signed.txt'])
  })

  it('refuses a discard whose file changed after the preview and then recovers the copy', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'j.txt'), 'base\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'j.txt'), 'first edit\n')
    await writeFile(path.join(repo, 'untracked.txt'), 'keep me\n')

    const { repository } = await rootState(repo)
    const preview = await mutate(repo, {
      action: 'previewDiscard',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'j.txt'
    })
    expect(preview.outcome).toBe('succeeded')
    const discardPreview = preview.preview
    if (!discardPreview || !('previewId' in discardPreview)) {
      throw new Error('missing discard preview')
    }

    await writeFile(path.join(repo, 'j.txt'), 'external edit\n')
    const refused = await mutate(repo, {
      action: 'discard',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'j.txt',
      previewId: discardPreview.previewId
    })
    expect(refused.outcome).toBe('failed')
    expect(refused.errorCategory).toBe('stale')
    expect(await readFile(path.join(repo, 'j.txt'), 'utf8')).toBe('external edit\n')

    const fresh = await mutate(repo, {
      action: 'previewDiscard',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'j.txt'
    })
    if (!fresh.preview || !('previewId' in fresh.preview)) {
      throw new Error('missing discard preview')
    }
    const discarded = await mutate(repo, {
      action: 'discard',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'j.txt',
      previewId: fresh.preview.previewId
    })
    expect(discarded.outcome).toBe('succeeded')
    expect(discarded.recovery?.filePath).toBe('j.txt')
    expect(await readFile(path.join(repo, 'j.txt'), 'utf8')).toBe('base\n')
    expect(await readFile(path.join(repo, 'untracked.txt'), 'utf8')).toBe('keep me\n')

    const listed = await mutate(repo, {
      action: 'listRecoveries',
      contextId: repository.context.id,
      expectedState: (await rootState(repo)).repository.expectedState
    })
    expect(listed.recoveries?.some((item) => item.id === discarded.recovery?.id)).toBe(true)

    const restored = await mutate(repo, {
      action: 'restoreDiscard',
      contextId: repository.context.id,
      expectedState: (await rootState(repo)).repository.expectedState,
      recoveryId: discarded.recovery!.id
    })
    expect(restored.outcome).toBe('succeeded')
    expect(await readFile(path.join(repo, 'j.txt'), 'utf8')).toBe('external edit\n')
  })

  it('refuses to discard untracked files and when no recovery copy can be stored', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'tracked.txt'), 'base\n')
    await commitAll(repo, 'initial')
    await writeFile(path.join(repo, 'new.txt'), 'untracked\n')

    const { repository } = await rootState(repo)
    const untracked = await mutate(repo, {
      action: 'previewDiscard',
      contextId: repository.context.id,
      expectedState: repository.expectedState,
      filePath: 'new.txt'
    })
    expect(untracked.outcome).toBe('failed')
    expect(await readFile(path.join(repo, 'new.txt'), 'utf8')).toBe('untracked\n')

    await writeFile(path.join(repo, 'tracked.txt'), 'changed\n')
    const blocker = path.join(repository.context.gitDir, 'orca-recovery')
    await writeFile(blocker, 'not a directory')
    try {
      const fresh = await rootState(repo)
      const preview = await mutate(repo, {
        action: 'previewDiscard',
        contextId: repository.context.id,
        expectedState: fresh.repository.expectedState,
        filePath: 'tracked.txt'
      })
      expect(preview.outcome).toBe('succeeded')
      expect(preview.preview).toMatchObject({ recoveryAvailable: false })
      if (!preview.preview || !('previewId' in preview.preview)) {
        throw new Error('missing discard preview')
      }
      const refused = await mutate(repo, {
        action: 'discard',
        contextId: repository.context.id,
        expectedState: fresh.repository.expectedState,
        filePath: 'tracked.txt',
        previewId: preview.preview.previewId
      })
      expect(refused.outcome).toBe('failed')
      expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
    } finally {
      await rm(blocker, { force: true })
    }
  })

  it('stages a reviewed child gitlink without touching the child or its index', async () => {
    const child = await createRepo()
    await writeFile(path.join(child, 'child.txt'), 'child base\n')
    await commitAll(child, 'child initial')
    const parent = await createRepo()
    await writeFile(path.join(parent, 'root.txt'), 'root\n')
    await commitAll(parent, 'parent initial')
    text(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub'])
    await commitAll(parent, 'add submodule')

    const sub = path.join(parent, 'sub')
    await writeFile(path.join(sub, 'child.txt'), 'child moved\n')
    const childHead = await commitAll(sub, 'child moves')
    await writeFile(path.join(sub, 'dirty.txt'), 'child dirty\n')
    const childIndexBefore = text(sub, ['ls-files', '--stage'])
    const childFilesBefore = text(sub, ['status', '--porcelain=v1'])
    const parentHeadGitlink = treeOid(parent, 'HEAD', 'sub')

    const state = await rootState(parent)
    const module = state.workspace.submodules.find(
      (item) => item.path === 'sub' && item.parentContextId === state.repository.context.id
    )
    if (!module?.contextId) {
      throw new Error('submodule context missing')
    }
    const wrong = await mutate(parent, {
      action: 'stageGitlink',
      contextId: state.repository.context.id,
      expectedState: state.repository.expectedState,
      filePath: 'sub',
      childOid: parentHeadGitlink
    })
    expect(wrong.outcome).toBe('failed')

    const staged = await mutate(parent, {
      action: 'stageGitlink',
      contextId: state.repository.context.id,
      expectedState: state.repository.expectedState,
      filePath: 'sub',
      childOid: childHead.trim()
    })
    expect(staged.outcome).toBe('succeeded')
    expect(text(parent, ['ls-files', '--stage', '--', 'sub']).split(' ')[1]).toBe(childHead.trim())
    expect(treeOid(parent, 'HEAD', 'sub')).toBe(parentHeadGitlink)
    expect(text(sub, ['ls-files', '--stage'])).toBe(childIndexBefore)
    expect(text(sub, ['status', '--porcelain=v1'])).toBe(childFilesBefore)
    expect(text(sub, ['rev-parse', 'HEAD']).trim()).toBe(childHead.trim())

    const fileStage = await mutate(parent, {
      action: 'stage',
      contextId: state.repository.context.id,
      expectedState: (await rootState(parent)).repository.expectedState,
      filePath: 'sub'
    })
    expect(fileStage.outcome).toBe('failed')
    expect(fileStage.errorCategory).toBe('unsupported')

    const commit = await mutate(parent, {
      action: 'commit',
      contextId: state.repository.context.id,
      expectedState: (await rootState(parent)).repository.expectedState,
      message: 'record child commit'
    })
    expect(commit.outcome).toBe('succeeded')
    expect(treeOid(parent, 'HEAD', 'sub')).toBe(childHead.trim())
  })

  it('keeps the parent index untouched when the child commits', async () => {
    const child = await createRepo()
    await writeFile(path.join(child, 'child.txt'), 'base\n')
    await commitAll(child, 'child initial')
    const parent = await createRepo()
    await writeFile(path.join(parent, 'root.txt'), 'root\n')
    await commitAll(parent, 'parent initial')
    text(parent, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub'])
    await commitAll(parent, 'add submodule')

    const sub = path.join(parent, 'sub')
    await writeFile(path.join(sub, 'child.txt'), 'moved\n')
    text(sub, ['add', 'child.txt'])
    const parentIndexBefore = text(parent, ['ls-files', '--stage'])
    const state = await rootState(parent)
    const childRepository = state.workspace.repositories.find((item) => item.context.id !== state.repository.context.id)
    if (!childRepository) {
      throw new Error('child repository missing')
    }
    const commit = await mutate(parent, {
      action: 'commit',
      contextId: childRepository.context.id,
      expectedState: childRepository.expectedState,
      message: 'child commit'
    })
    expect(commit.outcome).toBe('succeeded')
    expect(text(sub, ['rev-parse', 'HEAD']).trim()).toBe(commit.head)
    expect(text(parent, ['ls-files', '--stage'])).toBe(parentIndexBefore)
    const after = await rootState(parent)
    const module = after.workspace.submodules.find((item) => item.path === 'sub')
    expect(module?.currentOid).toBe(commit.head)
    expect(module?.indexOid).not.toBe(commit.head)
  })

  it('reports an unknown outcome when the request is aborted during a hook, and never retries', async () => {
    const repo = await createRepo()
    await writeFile(path.join(repo, 'slow.txt'), 'base\n')
    const base = await commitAll(repo, 'initial')
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    await writeFile(hook, '#!/bin/sh\nsleep 3\n', { mode: 0o755 })
    await chmod(hook, 0o755)
    await writeFile(path.join(repo, 'slow.txt'), 'changed\n')
    text(repo, ['add', 'slow.txt'])

    const { repository } = await rootState(repo)
    const controller = new AbortController()
    const pending = mutate(
      repo,
      {
        action: 'commit',
        contextId: repository.context.id,
        expectedState: repository.expectedState,
        message: 'aborted commit'
      },
      controller.signal
    )
    // Why a real timer: the abort has to land while a real `git commit` child sits in its
    // hook; fake timers cannot advance the subprocess, and waiting for the hook would defeat
    // the cancelled-request scenario under test.
    setTimeout(() => controller.abort(), 250)
    const receipt = await pending
    expect(receipt.outcome).toBe('unknown')
    expect(receipt.errorCategory).toBe('unknown-outcome')
    expect(text(repo, ['rev-parse', 'HEAD']).trim()).toBe(base)
    expect(text(repo, ['rev-list', '--count', 'HEAD']).trim()).toBe('1')
    expect(statusLines(repo)).toEqual(['M  slow.txt'])
  })
})

import { mkdtemp, realpath, rm, writeFile, chmod, readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getStatus } from './status-read'
import { previewGitWorkspaceBatch } from './git-workspace-batch'
import { runGitWorkspaceBatch } from './git-workspace-batch-run'
import { createGitWorkspaceFixture, type GitWorkspaceFixture } from './git-workspace-test-fixture'
import type { GitWorkspaceBatchRequest } from '../../../shared/git-workspace-batch'
import type { RepositoryState, GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'

const fixtures: GitWorkspaceFixture[] = []
const savedEnv = { ...process.env }
let fixtureHome = ''

beforeAll(async () => {
  fixtureHome = await mkdtemp(path.join(tmpdir(), 'orca-batch-home-'))
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

async function makeFixture(): Promise<{
  fixture: GitWorkspaceFixture
  remotes: Record<'root' | 'one' | 'two' | 'nested', string>
}> {
  const fixture = await createGitWorkspaceFixture()
  fixtures.push(fixture)
  const checkouts = {
    root: fixture.root,
    one: fixture.one,
    two: fixture.two,
    nested: fixture.nested
  }
  const remotes = {} as Record<'root' | 'one' | 'two' | 'nested', string>
  for (const [name, checkout] of Object.entries(checkouts) as [keyof typeof checkouts, string][]) {
    const remote = path.join(fixture.directory, `${name}-batch.git`)
    remotes[name] = remote
    await fixture.git(fixture.directory, ['init', '-q', '--bare', remote])
    await fixture.git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await fixture.git(checkout, ['checkout', '-q', 'main'])
    await fixture.git(checkout, ['config', 'user.name', 'Batch Test'])
    await fixture.git(checkout, ['config', 'user.email', 'batch@example.test'])
    await fixture.git(checkout, ['remote', 'add', 'batch', remote])
    await fixture.git(checkout, ['push', '-q', 'batch', 'HEAD:refs/heads/main'])
  }
  await configureSubmoduleUrls(fixture, fixture.root, { one: remotes.one, two: remotes.two })
  await configureSubmoduleUrls(fixture, fixture.one, { same: remotes.nested })
  return { fixture, remotes }
}

async function configureSubmoduleUrls(
  fixture: GitWorkspaceFixture,
  checkout: string,
  urls: Record<string, string>
): Promise<void> {
  const rows = (
    await fixture.git(checkout, [
      'config',
      '-f',
      '.gitmodules',
      '--get-regexp',
      '^submodule\\..*\\.path$'
    ])
  )
    .split('\n')
    .filter(Boolean)
  for (const row of rows) {
    const separator = row.indexOf(' ')
    const pathName = row.slice(separator + 1)
    const modulePath = row.slice('submodule.'.length, separator - '.path'.length)
    const url = urls[pathName]
    if (!url) {
      continue
    }
    await fixture.git(checkout, ['config', '-f', '.gitmodules', `submodule.${modulePath}.url`, url])
    await fixture.git(checkout, ['config', `submodule.${modulePath}.url`, url])
  }
  await fixture.git(checkout, ['add', '.gitmodules'])
}

async function workspace(fixture: GitWorkspaceFixture): Promise<GitWorkspaceSnapshot> {
  const result = await getStatus(fixture.root, { includeWorkspace: true, includeLineStats: false })
  if (!result.workspace) {
    throw new Error('Workspace snapshot unavailable in real-Git batch fixture')
  }
  return result.workspace
}

async function repositoryAt(
  snapshot: GitWorkspaceSnapshot,
  checkout: string
): Promise<RepositoryState> {
  const canonical = await realpath(checkout)
  const repository = snapshot.repositories.find((item) => item.context.checkoutPath === canonical)
  if (!repository) {
    throw new Error(`Missing workspace context for ${checkout}`)
  }
  return repository
}

async function batchRequest(
  fixture: GitWorkspaceFixture,
  selected: string[],
  stagedByCheckout: Record<string, string[]>,
  publishIds: string[] = selected
): Promise<{
  request: GitWorkspaceBatchRequest
  snapshot: GitWorkspaceSnapshot
  repos: Map<string, RepositoryState>
}> {
  const snapshot = await workspace(fixture)
  const checkouts = [fixture.root, fixture.one, fixture.nested, fixture.two]
  const repos = new Map<string, RepositoryState>()
  for (const checkout of checkouts) {
    repos.set(checkout, await repositoryAt(snapshot, checkout))
  }
  const ids = new Map(checkouts.map((checkout) => [checkout, repos.get(checkout)!.context.id]))
  const commits = selected.map((contextId) => {
    const checkout = checkouts.find((item) => repos.get(item)!.context.id === contextId)!
    return {
      contextId,
      message: `batch ${path.basename(checkout)}`,
      stagedPaths: stagedByCheckout[checkout] ?? []
    }
  })
  const publication: NonNullable<GitWorkspaceBatchRequest['publication']> = []
  for (const contextId of publishIds) {
    const checkout = checkouts.find((item) => repos.get(item)!.context.id === contextId)!
    const expectedRefOid = await fixture.git(checkout, ['rev-parse', '--verify', 'refs/heads/main'])
    publication.push({ contextId, remote: 'batch', refName: 'refs/heads/main', expectedRefOid })
  }
  return {
    snapshot,
    repos,
    request: {
      rootContextId: ids.get(fixture.root)!,
      contextIds: selected,
      recursive: true,
      commits,
      publication
    }
  }
}

async function confirmAll(
  root: string,
  previewId: string,
  confirmations: { parent: string; child: string; filePath: string; oid: string }[] = []
) {
  let receipt = await runGitWorkspaceBatch(root, { previewId })
  while (receipt.outcome === 'paused') {
    const next = receipt.nextConfirmation
    if (!next) {
      throw new Error('Paused batch did not return its required gitlink confirmation')
    }
    confirmations.push({
      parent: next.parentContextId,
      child: next.childContextId,
      filePath: next.filePath,
      oid: next.childOid
    })
    receipt = await runGitWorkspaceBatch(root, {
      previewId,
      confirmations: [{ ...next, confirmed: true }]
    })
  }
  return { receipt, confirmations }
}

describe('selected-context batch workflow on real Git', { timeout: 180_000 }, () => {
  it('commits nested contexts leaf-to-root, confirms each exact gitlink, publishes child-first, and clones cleanly', async () => {
    const { fixture, remotes } = await makeFixture()
    await configureSubmoduleUrls(fixture, fixture.root, {
      one: '../one-batch.git',
      two: '../two-batch.git'
    })
    await configureSubmoduleUrls(fixture, fixture.one, { same: '../nested-batch.git' })
    await writeFile(path.join(fixture.nested, 'file.txt'), 'nested batch change\n')
    await fixture.git(fixture.nested, ['add', 'file.txt'])
    await writeFile(path.join(fixture.one, 'file.txt'), 'one batch change\n')
    await fixture.git(fixture.one, ['add', 'file.txt'])
    await writeFile(path.join(fixture.root, 'file.txt'), 'root batch change\n')
    await fixture.git(fixture.root, ['add', 'file.txt'])
    const setup = await batchRequest(fixture, [], {})
    const idFor = (checkout: string) => setup.repos.get(checkout)!.context.id
    const selected = [fixture.root, fixture.one, fixture.nested, fixture.two].map(idFor)
    const staged = {
      [fixture.root]: ['.gitmodules', 'file.txt'],
      [fixture.one]: ['.gitmodules', 'file.txt'],
      [fixture.nested]: ['file.txt'],
      [fixture.two]: []
    }
    const { request } = await batchRequest(fixture, selected, staged)
    const preview = await previewGitWorkspaceBatch(fixture.root, request)
    expect(preview.incomplete).toBe(false)
    expect(preview.steps.map((step) => step.kind)).toContain('stageGitlink')
    const { receipt, confirmations } = await confirmAll(fixture.root, preview.previewId)
    expect(receipt.outcome).toBe('completed')
    expect(confirmations.map((item) => item.parent)).toEqual([
      idFor(fixture.one),
      idFor(fixture.root)
    ])
    expect(confirmations.map((item) => item.child)).toEqual([
      idFor(fixture.nested),
      idFor(fixture.one)
    ])
    expect(confirmations.map((item) => item.filePath)).toEqual(['same', 'one'])
    expect(
      receipt.steps.filter((step) => step.kind === 'commit').map((step) => step.contextId)
    ).toEqual([idFor(fixture.nested), idFor(fixture.one), idFor(fixture.root)])
    expect(confirmations.map((item) => item.oid)).toEqual([
      await fixture.git(fixture.nested, ['rev-parse', 'HEAD']),
      await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    ])
    expect(
      receipt.steps
        .filter((step) => step.kind === 'push')
        .every((step) => step.status === 'succeeded')
    ).toBe(true)
    expect(
      receipt.steps.findIndex(
        (step) => step.kind === 'push' && step.contextId === idFor(fixture.nested)
      )
    ).toBeLessThan(
      receipt.steps.findIndex(
        (step) => step.kind === 'push' && step.contextId === idFor(fixture.one)
      )
    )
    expect(await fixture.git(remotes.root, ['rev-parse', 'refs/heads/main'])).toBe(
      await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
    )

    const clone = path.join(fixture.directory, 'batch-clean-clone')
    await fixture.git(fixture.directory, ['clone', '-q', remotes.root, clone])
    await fixture.git(clone, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive'
    ])
    const rootRepo = await workspace(fixture)
    const rootContext = rootRepo.repositories.find(
      (item) => item.context.id === idFor(fixture.root)
    )!
    expect(rootContext.head).toBe(await fixture.git(clone, ['rev-parse', 'HEAD']))
    expect(await fixture.git(path.join(clone, 'one'), ['rev-parse', 'HEAD'])).toBe(
      await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
    )
    expect(await fixture.git(path.join(clone, 'one', 'same'), ['rev-parse', 'HEAD'])).toBe(
      await fixture.git(fixture.nested, ['rev-parse', 'HEAD'])
    )
    expect(await fixture.git(path.join(clone, 'two'), ['rev-parse', 'HEAD'])).toBe(
      await fixture.git(fixture.two, ['rev-parse', 'HEAD'])
    )
  })

  it('resumes only a known failed publication step and never republishes a completed child', async () => {
    const { fixture, remotes } = await makeFixture()
    await writeFile(path.join(fixture.nested, 'file.txt'), 'retry-safe child change\n')
    await fixture.git(fixture.nested, ['add', 'file.txt'])
    const initial = await batchRequest(fixture, [], {})
    const ids = [fixture.root, fixture.one, fixture.nested, fixture.two].map(
      (checkout) => initial.repos.get(checkout)!.context.id
    )
    const staged = {
      [fixture.root]: ['.gitmodules'],
      [fixture.one]: ['.gitmodules'],
      [fixture.nested]: ['file.txt']
    }
    const { request } = await batchRequest(fixture, ids, staged)
    const preview = await previewGitWorkspaceBatch(fixture.root, request)
    const log = path.join(fixture.directory, 'nested-push-count')
    const hook = path.join(remotes.nested, 'hooks', 'pre-receive')
    const quotedLog = log.replaceAll("'", "'\\''")
    await writeFile(hook, `#!/bin/sh\nprintf x >> '${quotedLog}'\n`)
    await chmod(hook, 0o755)

    await fixture.git(fixture.root, [
      'remote',
      'set-url',
      'batch',
      path.join(fixture.directory, 'unavailable-root.git')
    ])
    const first = await confirmAll(fixture.root, preview.previewId)
    expect(first.receipt.outcome).toBe('failed')
    const childPush = first.receipt.steps.find(
      (step) =>
        step.kind === 'push' && step.contextId === initial.repos.get(fixture.nested)!.context.id
    )
    expect(childPush?.status).toBe('succeeded')
    const completedPushes = first.receipt.steps
      .filter((step) => step.kind === 'push' && step.status === 'succeeded')
      .map((step) => step.contextId)
    expect(completedPushes.length).toBeGreaterThan(0)
    expect((await readFile(log, 'utf8')).length).toBe(1)

    await fixture.git(fixture.root, ['remote', 'set-url', 'batch', remotes.root])
    const retried = await runGitWorkspaceBatch(fixture.root, {
      previewId: preview.previewId,
      retryFailed: true
    })
    expect(retried.outcome).toBe('completed')
    expect(
      retried.steps
        .filter((step) => step.kind === 'push' && step.status === 'succeeded')
        .map((step) => step.contextId)
    ).toEqual(expect.arrayContaining(completedPushes))
    expect((await readFile(log, 'utf8')).length).toBe(1)
  })

  it('rejects a stale staged dependency before creating any commit', async () => {
    const { fixture } = await makeFixture()
    await writeFile(path.join(fixture.root, 'file.txt'), 'reviewed change\n')
    await fixture.git(fixture.root, ['add', 'file.txt'])
    const snapshot = await workspace(fixture)
    const rootRepo = await repositoryAt(snapshot, fixture.root)
    const before = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
    const request: GitWorkspaceBatchRequest = {
      rootContextId: rootRepo.context.id,
      contextIds: [rootRepo.context.id],
      recursive: false,
      commits: [
        {
          contextId: rootRepo.context.id,
          message: 'stale batch',
          stagedPaths: ['.gitmodules', 'file.txt']
        }
      ],
      publication: []
    }
    const preview = await previewGitWorkspaceBatch(fixture.root, request)
    await writeFile(path.join(fixture.root, 'unreviewed.txt'), 'unreviewed\n')
    await fixture.git(fixture.root, ['add', 'unreviewed.txt'])
    const result = await runGitWorkspaceBatch(fixture.root, { previewId: preview.previewId })
    expect(result.outcome).toBe('failed')
    expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(before)
  })

  it('blocks parent publication when the exact child commit is no longer reachable at its destination', async () => {
    const { fixture, remotes } = await makeFixture()
    await writeFile(path.join(fixture.nested, 'file.txt'), 'unreachable child change\n')
    await fixture.git(fixture.nested, ['add', 'file.txt'])
    const initial = await batchRequest(fixture, [], {})
    const ids = [fixture.root, fixture.one, fixture.nested, fixture.two].map(
      (checkout) => initial.repos.get(checkout)!.context.id
    )
    const { request } = await batchRequest(fixture, ids, {
      [fixture.root]: ['.gitmodules'],
      [fixture.one]: ['.gitmodules'],
      [fixture.nested]: ['file.txt']
    })
    const preview = await previewGitWorkspaceBatch(fixture.root, request)
    const hook = path.join(remotes.nested, 'hooks', 'post-receive')
    await writeFile(hook, '#!/bin/sh\ngit update-ref -d refs/heads/main\n')
    await chmod(hook, 0o755)
    const { receipt } = await confirmAll(fixture.root, preview.previewId)
    expect(receipt.outcome).toBe('failed')
    const verify = receipt.steps.find(
      (step) =>
        step.kind === 'verifyRemote' &&
        step.parentContextId === initial.repos.get(fixture.one)!.context.id
    )
    expect(verify?.status).toBe('failed')
    expect(
      receipt.steps.some(
        (step) =>
          step.kind === 'push' &&
          step.contextId === initial.repos.get(fixture.one)!.context.id &&
          step.status === 'succeeded'
      )
    ).toBe(false)
  })
  it('does not publish a parent whose committed child URL names a different destination', async () => {
    const { fixture, remotes } = await makeFixture()
    const before = await fixture.git(remotes.root, ['rev-parse', 'refs/heads/main'])
    await configureSubmoduleUrls(fixture, fixture.root, {
      one: path.join(fixture.directory, 'different-child.git'),
      two: remotes.two
    })
    const initial = await batchRequest(fixture, [], {})
    const selected = [fixture.root, fixture.one, fixture.nested, fixture.two].map(
      (checkout) => initial.repos.get(checkout)!.context.id
    )
    const { request } = await batchRequest(fixture, selected, {
      [fixture.root]: ['.gitmodules'],
      [fixture.one]: ['.gitmodules']
    })
    const preview = await previewGitWorkspaceBatch(fixture.root, request)
    const { receipt } = await confirmAll(fixture.root, preview.previewId)
    expect(receipt.outcome).toBe('failed')
    expect(
      receipt.steps.find(
        (step) =>
          step.kind === 'verifyRemote' &&
          step.parentContextId === initial.repos.get(fixture.root)!.context.id
      )
    ).toMatchObject({ status: 'failed', errorCategory: 'incomplete' })
    expect(await fixture.git(remotes.root, ['rev-parse', 'refs/heads/main'])).toBe(before)
  })
  it('records an interrupted publication as unknown and never replays it on a repeated run', async () => {
    const fixture = await createGitWorkspaceFixture()
    fixtures.push(fixture)
    const standalone = path.join(fixture.directory, 'standalone')
    await mkdir(standalone)
    await fixture.git(standalone, ['init', '-q'])
    await fixture.git(standalone, ['checkout', '-qb', 'main'])
    await fixture.git(standalone, ['commit', '--allow-empty', '-qm', 'initial'])
    const controller = new AbortController()
    let requests = 0
    const server = createServer(() => {
      requests++
      controller.abort()
    })
    const listening = Promise.withResolvers<void>()
    server.once('error', listening.reject)
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('HTTP fixture did not bind')
      }
      await fixture.git(standalone, [
        'remote',
        'add',
        'interrupted',
        `http://127.0.0.1:${address.port}/remote.git`
      ])
      const snapshot = (
        await getStatus(standalone, { includeWorkspace: true, includeLineStats: false })
      ).workspace
      const repo = snapshot?.repositories[0]
      if (!repo?.head || !snapshot?.rootContextId) {
        throw new Error('Standalone context missing')
      }
      const preview = await previewGitWorkspaceBatch(standalone, {
        rootContextId: snapshot.rootContextId,
        contextIds: [repo.context.id],
        recursive: false,
        commits: [],
        publication: [
          {
            contextId: repo.context.id,
            remote: 'interrupted',
            refName: 'refs/heads/main',
            expectedRefOid: repo.head
          }
        ]
      })
      const inspection = await runGitWorkspaceBatch(standalone, {
        previewId: preview.previewId,
        inspectOnly: true
      })
      expect(inspection.steps.find((step) => step.kind === 'push')).toMatchObject({
        status: 'pending'
      })
      expect(requests).toBe(0)
      const result = await runGitWorkspaceBatch(
        standalone,
        { previewId: preview.previewId },
        { signal: controller.signal }
      )
      expect(result.outcome).toBe('unknown')
      expect(result.steps.find((step) => step.kind === 'push')).toMatchObject({ status: 'unknown' })
      expect(requests).toBe(1)
      const repeated = await runGitWorkspaceBatch(standalone, { previewId: preview.previewId })
      expect(repeated.outcome).toBe('unknown')
      expect(requests).toBe(1)
    } finally {
      server.closeAllConnections()
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
    }
  })
})

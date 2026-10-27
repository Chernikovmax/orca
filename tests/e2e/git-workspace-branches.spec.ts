import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import {
  createGitWorkspaceFixture,
  type GitWorkspaceFixture
} from '../../src/main/git/source-control/git-workspace-test-fixture'

function rawGit(fixture: GitWorkspaceFixture, cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixture.env, encoding: 'utf8' })
}

function headRefOrEmpty(fixture: GitWorkspaceFixture, cwd: string): string {
  try {
    return rawGit(fixture, cwd, ['symbolic-ref', '-q', 'HEAD']).trim()
  } catch {
    return ''
  }
}

function operationMarkerExists(fixture: GitWorkspaceFixture, cwd: string, marker: string): boolean {
  const gitDir = rawGit(fixture, cwd, ['rev-parse', '--absolute-git-dir']).trim()
  return existsSync(path.join(gitDir, marker))
}

async function fingerprint(
  fixture: GitWorkspaceFixture,
  cwds: string[]
): Promise<{ head: string; refs: string; index: string }[]> {
  return Promise.all(
    cwds.map(async (cwd) => ({
      head: await fixture.git(cwd, ['rev-parse', '--verify', 'HEAD']),
      refs: await fixture.git(cwd, ['show-ref']),
      index: await fixture.git(cwd, ['ls-files', '--stage'])
    }))
  )
}

async function openProject(
  page: Parameters<typeof openGoldenSourceControl>[0],
  fixture: GitWorkspaceFixture
) {
  // The stock Source Control harness waits for the root commit box, which only
  // exists while the root has changes; this untracked note keeps that surface.
  await writeFile(path.join(fixture.root, 'e2e-root-note.txt'), 'root note\n')
  await waitForSessionReady(page)
  await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
  }, fixture.root)
  await openGoldenSourceControl(page, fixture.root, {
    worktreePath: fixture.root,
    branchName: 'main'
  })
}

async function openPopup(page: Parameters<typeof openGoldenSourceControl>[0]) {
  await page.keyboard.press('Control+Alt+KeyG')
  const popup = page.getByTestId('git-workspace-popup')
  await expect(popup).toBeVisible({ timeout: 15_000 })
  return popup
}

async function selectContext(
  popup: Awaited<ReturnType<typeof openPopup>>,
  which: 'root' | 'one' | 'nested' | 'two'
) {
  const repositories = popup.getByRole('group', { name: 'Repository results' })
  const row =
    which === 'root'
      ? repositories.locator('[data-context-key]').filter({ hasText: 'Root' })
      : which === 'one'
        ? repositories.locator('[data-context-key]').filter({ hasText: /^sameone(?!\/)/ })
        : which === 'nested'
          ? repositories.locator('[data-context-key]').filter({ hasText: 'one/same' })
          : repositories.locator('[data-context-key]').filter({ hasText: 'two' })
  await row.click()
  await expect(popup.getByRole('textbox', { name: 'Search refs' })).toBeEnabled({
    timeout: 30_000
  })
  return row
}

async function inspectRef(
  popup: Awaited<ReturnType<typeof openPopup>>,
  query: string,
  fullName: string
) {
  const group = fullName.startsWith('refs/heads/')
    ? 'Local'
    : fullName.startsWith('refs/remotes/')
      ? 'Remote'
      : 'Tags'
  const short = fullName.replace(/^refs\/(?:heads|remotes|tags)\//, '')
  const search = popup.getByRole('textbox', { name: 'Search refs' })
  await search.fill(query)
  await expect(popup.getByRole('region', { name: group, exact: true })).toContainText(short, {
    timeout: 30_000
  })
  await search.press('Enter')
  await expect(popup.getByRole('region', { name: 'Ref details' }).locator('p').first()).toHaveText(
    fullName,
    { timeout: 30_000 }
  )
}

function setupRemote(fixture: GitWorkspaceFixture) {
  const bare = path.join(fixture.directory, 'e2e-remote.git')
  const uploadpack = path.join(fixture.directory, 'uploadpack-delay.sh')
  const receivepack = path.join(fixture.directory, 'receivepack-delay.sh')
  return { bare, uploadpack, receivepack }
}

async function addRemoteWithProgressDelay(
  fixture: GitWorkspaceFixture,
  bare: string,
  uploadpack: string,
  receivepack: string
) {
  await writeFile(
    uploadpack,
    '#!/bin/sh\nsleep 1\nexec "$(git --exec-path)/git-upload-pack" "$@"\n',
    { mode: 0o755 }
  )
  await writeFile(
    receivepack,
    '#!/bin/sh\nsleep 1\nexec "$(git --exec-path)/git-receive-pack" "$@"\n',
    { mode: 0o755 }
  )
  await fixture.git(fixture.directory, ['init', '-q', '--bare', bare])
  await fixture.git(fixture.one, ['remote', 'add', 'stage6', bare])
  await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:main'])
  await fixture.git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await fixture.git(fixture.one, ['fetch', '-q', '--no-recurse-submodules', 'stage6'])
  await fixture.git(fixture.one, ['config', 'remote.stage6.uploadpack', uploadpack])
  await fixture.git(fixture.one, ['config', 'remote.stage6.receivepack', receivepack])
}

test('checkout from the popup changes only the selected submodule and preserves drafts', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await fixture.git(fixture.one, ['checkout', '-qb', 'selected-branch'])
  await writeFile(path.join(fixture.one, 'selected.txt'), 'selected\n')
  await fixture.git(fixture.one, ['add', '.'])
  await fixture.git(fixture.one, ['commit', '-qm', 'selected branch'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  await fixture.git(fixture.one, ['checkout', '-qb', 'dirty-target'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'dirty target\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'dirty target'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  await fixture.git(fixture.one, ['tag', 'release-e2e', 'main'])
  const beforeRoot = await fingerprint(fixture, [fixture.root])
  const beforeSiblings = await fingerprint(fixture, [fixture.two, fixture.nested])
  const oneBefore = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])

  await openProject(page, fixture)

  // Select the nested checkout in the popup and open its Changes, then write a draft.
  let popup = await openPopup(page)
  await selectContext(popup, 'nested')
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).click()
  await expect(page.getByTestId('git-context-changes')).toContainText('Changes · one/same', {
    timeout: 30_000
  })
  const childDraft = page.getByTestId('git-context-commit-message')
  await childDraft.fill('child draft must survive')

  // A dirty file that the target branch changes must block checkout.
  popup = await openPopup(page)
  await selectContext(popup, 'one')
  await writeFile(path.join(fixture.one, 'file.txt'), 'uncommitted local work\n')
  await inspectRef(popup, 'dirty-target', 'refs/heads/dirty-target')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText(
    'would overwrite local changes'
  )
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')

  // Restore the file and check out the reviewed branch for real.
  await fixture.git(fixture.one, ['checkout', '--', 'file.txt'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const oneRow = popup
    .getByRole('group', { name: 'Repository results' })
    .locator('[data-context-key]')
    .filter({ hasText: /^sameone(?!\/)/ })
  await expect(oneRow).toContainText('clean', { timeout: 12_000 })
  popup = await openPopup(page)
  await selectContext(popup, 'one')
  await inspectRef(popup, 'selected-branch', 'refs/heads/selected-branch')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(popup.getByTestId('git-branch-notice')).toContainText(
    'Checked out selected-branch',
    {
      timeout: 30_000
    }
  )
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe(
    'refs/heads/selected-branch'
  )
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).not.toBe(oneBefore)
  // Root HEAD/refs/index and sibling checkouts are untouched. Root status may
  // legitimately show the child's new commit as a gitlink change.
  expect(await fingerprint(fixture, [fixture.root])).toEqual(beforeRoot)
  expect(await fingerprint(fixture, [fixture.two, fixture.nested])).toEqual(beforeSiblings)

  // The child draft is kept across the checkout in the sibling context.
  await page.keyboard.press('Escape')
  await expect(popup).not.toBeVisible()
  popup = await openPopup(page)
  await selectContext(popup, 'nested')
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).click()
  await expect(page.getByTestId('git-context-changes')).toContainText('Changes · one/same')
  await expect(page.getByTestId('git-context-commit-message')).toHaveValue(
    'child draft must survive'
  )

  // New Branch from the popup form works entirely from the keyboard.
  popup = await openPopup(page)
  await selectContext(popup, 'one')
  const newBranch = popup.getByRole('textbox', { name: 'New branch name' })
  await newBranch.fill('from-popup')
  await newBranch.press('Enter')
  await expect(popup.getByTestId('git-branch-notice')).toContainText(
    'Created and checked out from-popup',
    { timeout: 30_000 }
  )
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/from-popup')

  // A branch attached to another worktree is refused with its real path.
  popup = await openPopup(page)
  await selectContext(popup, 'root')
  await inspectRef(popup, 'second', 'refs/heads/second')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('another worktree', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.root, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main')

  // A tag checks out detached; the context row reports it.
  await selectContext(popup, 'one')
  await inspectRef(popup, 'release-e2e', 'refs/tags/release-e2e')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Detached HEAD', {
    timeout: 30_000
  })
  expect(headRefOrEmpty(fixture, fixture.one)).toBe('')
  const revisionOid = await fixture.git(fixture.one, ['rev-parse', 'refs/heads/selected-branch'])
  const revisionInput = popup.getByRole('textbox', { name: 'Commit id' })
  await revisionInput.fill(revisionOid)
  await revisionInput.press('Enter')
  await expect(popup.getByTestId('git-branch-notice')).toContainText(
    `Detached HEAD at ${revisionOid.slice(0, 10)}`,
    { timeout: 30_000 }
  )
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(revisionOid)
  const repositories = popup.getByRole('group', { name: 'Repository results' })
  await expect(
    repositories.locator('[data-context-key]').filter({ hasText: /^sameone(?!\/)/ })
  ).toContainText('detached', { timeout: 30_000 })
  await page.screenshot({ path: '.cache/stage6-popup-branches.png' })
  await page.keyboard.press('Escape')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

test('remote fetch, push, tracking, ahead/behind and non-fast-forward rejection stay explicit', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  const { bare, uploadpack, receivepack } = setupRemote(fixture)
  await addRemoteWithProgressDelay(fixture, bare, uploadpack, receivepack)
  await fixture.git(fixture.one, ['branch', '--set-upstream-to=stage6/main', 'main'])
  await fixture.git(fixture.one, ['push', '-q', 'stage6', 'main:remote-feature'])
  await fixture.git(fixture.one, ['fetch', '-q', '--no-recurse-submodules', 'stage6'])
  await writeFile(path.join(fixture.one, 'ahead.txt'), 'ahead\n')
  await fixture.git(fixture.one, ['add', '.'])
  await fixture.git(fixture.one, ['commit', '-qm', 'local ahead'])

  await openProject(page, fixture)
  const popup = await openPopup(page)
  await selectContext(popup, 'one')
  await expect(popup.getByTestId('git-refs-freshness')).toContainText(
    'Orca never fetches automatically'
  )
  const local = popup.getByRole('region', { name: 'Local', exact: true })
  await expect(local).toContainText('ahead 1, behind 0', { timeout: 30_000 })

  // Fetch from an explicit remote; progress is visible while real Git runs.
  const remote = popup.getByTestId('git-sync-actions').getByLabel('Remote', { exact: true })
  await remote.selectOption('stage6')
  await popup.getByRole('button', { name: 'Fetch', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(popup.getByTestId('git-sync-progress')).toBeVisible({ timeout: 5_000 })
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Fetched stage6', {
    timeout: 30_000
  })

  // Push the reviewed local branch explicitly.
  await popup
    .getByTestId('git-sync-actions')
    .getByLabel('Push branch', { exact: true })
    .selectOption({ label: 'main' })
  await popup.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(popup.getByTestId('git-sync-progress')).toBeVisible({ timeout: 5_000 })
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Pushed main to stage6', {
    timeout: 30_000
  })
  expect(await fixture.git(bare, ['rev-parse', 'refs/heads/main'])).toBe(
    await fixture.git(fixture.one, ['rev-parse', 'main'])
  )

  // Remote branch checkout creates a tracking local branch.
  await inspectRef(popup, 'stage6/remote-feature', 'refs/remotes/stage6/remote-feature')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Checked out remote-feature', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/remote-feature')
  expect(
    await fixture.git(fixture.one, [
      'for-each-ref',
      '--format=%(upstream)',
      'refs/heads/remote-feature'
    ])
  ).toBe('refs/remotes/stage6/remote-feature')
  await selectContext(popup, 'one')
  await inspectRef(popup, 'main', 'refs/heads/main')
  await popup.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Checked out main')

  // Advance the remote behind the UI's back, then fetch explicitly and observe
  // both directions of ahead/behind with real remote-tracking data.
  const clone = path.join(fixture.directory, 'e2e-clone')
  await fixture.git(fixture.directory, ['clone', '-q', '-b', 'main', bare, clone])
  await writeFile(path.join(clone, 'remote.txt'), 'remote\n')
  await fixture.git(clone, ['add', '.'])
  await fixture.git(clone, ['commit', '-qm', 'remote advance'])
  await fixture.git(clone, ['push', '-q', 'origin', 'main'])
  const remoteOid = await fixture.git(clone, ['rev-parse', 'HEAD'])
  await popup.getByRole('button', { name: 'Fetch', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Fetched stage6', {
    timeout: 30_000
  })
  await expect(local).toContainText('ahead 0, behind 1', { timeout: 30_000 })

  // A non-fast-forward push is rejected with no force and no automatic retry.
  const remoteBeforeReject = await fixture.git(bare, ['rev-parse', 'refs/heads/main'])
  const localBeforeReject = await fixture.git(fixture.one, ['rev-parse', 'main'])
  await popup.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Push rejected', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('git-branch-notice')).toContainText('does not force-push')
  expect(await fixture.git(bare, ['rev-parse', 'refs/heads/main'])).toBe(remoteBeforeReject)
  expect(await fixture.git(fixture.one, ['rev-parse', 'main'])).toBe(localBeforeReject)
  expect(remoteOid).toBe(remoteBeforeReject)

  await page.screenshot({ path: '.cache/stage6-popup-remotes.png' })
  await page.keyboard.press('Escape')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

test('merge and rebase report unfinished operations truthfully and finish only when Git does', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await fixture.git(fixture.one, ['checkout', '-qb', 'conflicting', 'main'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'conflicting side\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'conflicting side'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'main side\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'main side'])
  await fixture.git(fixture.one, ['checkout', '-qb', 'rebase-base', 'main'])
  await writeFile(path.join(fixture.one, 'rebase-base.txt'), 'base\n')
  await fixture.git(fixture.one, ['add', '.'])
  await fixture.git(fixture.one, ['commit', '-qm', 'rebase base'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  const beforeMerge = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])

  await openProject(page, fixture)
  let popup = await openPopup(page)
  await selectContext(popup, 'one')
  await inspectRef(popup, 'conflicting', 'refs/heads/conflicting')
  await popup.getByRole('button', { name: 'Merge into current', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('not complete', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('git-unfinished-operation')).toContainText('Merge in progress')
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(beforeMerge)
  expect(operationMarkerExists(fixture, fixture.one, 'MERGE_HEAD')).toBe(true)

  await popup.getByRole('button', { name: 'Abort', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('aborted', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(beforeMerge)
  await expect(popup.getByTestId('git-unfinished-operation')).toHaveCount(0)

  // Rebase completes only after Git reports it finished.
  await selectContext(popup, 'one')
  await inspectRef(popup, 'rebase-base', 'refs/heads/rebase-base')
  await popup.getByRole('button', { name: 'Rebase current onto this', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(popup.getByTestId('git-branch-notice')).toContainText('Rebased onto rebase-base', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.one, ['show', 'HEAD:rebase-base.txt'])).toBe('base')
  expect(
    operationMarkerExists(fixture, fixture.one, 'rebase-merge') ||
      operationMarkerExists(fixture, fixture.one, 'rebase-apply')
  ).toBe(false)

  // A second conflict is resolved outside the stage-8 resolver; Continue then
  // performs the real Git completion instead of claiming success early.
  await fixture.git(fixture.one, ['checkout', '-qb', 'conflicting-2', 'main'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'conflicting two\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'conflicting two'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'main two\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'main two'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  popup = await openPopup(page)
  await selectContext(popup, 'one')
  await inspectRef(popup, 'conflicting-2', 'refs/heads/conflicting-2')
  await popup.getByRole('button', { name: 'Merge into current', exact: true }).click()
  await expect(popup.getByTestId('git-unfinished-operation')).toContainText('Merge in progress', {
    timeout: 30_000
  })
  await writeFile(path.join(fixture.one, 'file.txt'), 'resolved in e2e\n')
  await fixture.git(fixture.one, ['add', 'file.txt'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(popup.getByTestId('git-unfinished-operation')).toContainText(
    'No unresolved conflict entries remain',
    { timeout: 15_000 }
  )
  await popup.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('continued', {
    timeout: 30_000
  })
  await expect(popup.getByTestId('git-unfinished-operation')).toHaveCount(0)
  const parents = await fixture.git(fixture.one, ['rev-list', '--parents', '-n', '1', 'HEAD'])
  expect(parents.split(' ')).toHaveLength(3)
  expect(await fixture.git(fixture.one, ['show', 'HEAD:file.txt'])).toBe('resolved in e2e')
  await page.screenshot({ path: '.cache/stage6-popup-integration.png' })
  await page.keyboard.press('Escape')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

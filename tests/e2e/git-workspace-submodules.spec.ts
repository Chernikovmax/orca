import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

test('reviewing and initializing a nested submodule preserves parent index and unrelated files', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await fixture.git(fixture.one, ['submodule', 'deinit', 'same'])
  await writeFile(path.join(fixture.root, 'e2e-root-note.txt'), 'root local work\n')
  await writeFile(path.join(fixture.two, 'local-note.txt'), 'sibling local work\n')
  const parentIndex = await fixture.git(fixture.one, ['ls-files', '--stage'])
  const rootIndex = await fixture.git(fixture.root, ['ls-files', '--stage'])
  const rootHead = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
  const childHead = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
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
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  const nested = catalog.getByTestId('git-submodule-row').filter({ hasText: 'one/same' })
  await expect(nested).toContainText('uninitialized', { timeout: 30_000 })
  const actions = nested.getByTestId('git-submodule-actions')
  await actions.getByRole('checkbox', { name: 'Initialize descendants recursively' }).check()
  await actions.getByRole('button', { name: 'Review Initialize', exact: true }).click()
  await expect(actions.getByRole('group', { name: 'Operation review' })).toContainText(
    'Path in parent checkout: same'
  )
  await expect(nested).toContainText('uninitialized')
  expect(await fixture.git(fixture.one, ['ls-files', '--stage'])).toBe(parentIndex)
  await actions.getByRole('button', { name: 'Initialize', exact: true }).click()
  await expect(nested).toContainText('initialized', { timeout: 30_000 })
  await expect(nested).not.toContainText('uninitialized')
  await expect(nested.getByRole('button', { name: 'one/same', exact: true })).toBeEnabled()
  expect(await fixture.git(fixture.nested, ['rev-parse', 'HEAD'])).toBe(
    await fixture.git(fixture.one, ['rev-parse', ':same'])
  )
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(rootHead)
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(childHead)
  expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(rootIndex)
  expect(await fixture.git(fixture.one, ['ls-files', '--stage'])).toBe(parentIndex)
  expect(await readFile(path.join(fixture.two, 'local-note.txt'), 'utf8')).toBe(
    'sibling local work\n'
  )
  expect(await readFile(path.join(fixture.root, 'e2e-root-note.txt'), 'utf8')).toBe(
    'root local work\n'
  )
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

test('submodule checkout reviews the exact detached target and keeps parent gitlinks unchanged', async ({
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  const recorded = await fixture.git(fixture.root, ['rev-parse', ':one'])
  await fixture.git(fixture.one, ['checkout', '-qb', 'remote-target'])
  await writeFile(path.join(fixture.one, 'remote-target.txt'), 'selected remote revision\n')
  await fixture.git(fixture.one, ['add', 'remote-target.txt'])
  await fixture.git(fixture.one, ['commit', '-qm', 'remote target'])
  const target = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
  await fixture.git(fixture.one, ['checkout', '-q', 'main'])
  await fixture.git(fixture.one, ['update-ref', 'refs/remotes/origin/remote-target', target])
  await writeFile(path.join(fixture.root, 'e2e-root-note.txt'), 'root local work\n')
  const rootIndex = await fixture.git(fixture.root, ['ls-files', '--stage'])
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
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  const one = catalog.getByTestId('git-submodule-row').filter({
    has: page.getByRole('button', { name: 'one', exact: true })
  })
  const actions = one.getByTestId('git-submodule-actions')
  await actions.getByRole('radio', { name: 'Selected remote OID', exact: true }).check()
  await actions
    .getByRole('combobox', { name: 'Available remote-tracking ref' })
    .selectOption('refs/remotes/origin/remote-target')
  await actions.getByRole('button', { name: 'Preview checkout', exact: true }).click()
  const review = actions.getByRole('group', { name: 'Operation review' })
  await expect(review).toContainText(target)
  await expect(review).toContainText('detached HEAD')
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(recorded)
  await review.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(one).toContainText(`detached ${target.slice(0, 8)}`, { timeout: 30_000 })
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(target)
  expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(rootIndex)
  await page.keyboard.press('Control+Alt+KeyG')
  const popup = page.getByTestId('git-workspace-popup')
  await expect(popup).toBeVisible()
  await popup
    .getByRole('group', { name: 'Repository results' })
    .locator('[data-context-key]')
    .filter({ hasText: /^sameone(?!\/)/ })
    .click()
  const branchName = popup.getByRole('textbox', { name: 'New branch name' })
  await expect(branchName).toBeEnabled({ timeout: 30_000 })
  await branchName.fill('stage7-development')
  await branchName.press('Enter')
  await expect(popup.getByTestId('git-branch-notice')).toContainText('stage7-development', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe(
    'refs/heads/stage7-development'
  )
  await page.keyboard.press('Escape')
  await actions.getByRole('radio', { name: /^Parent index OID/ }).check()
  await actions.getByRole('button', { name: 'Preview checkout', exact: true }).click()
  await expect(review).toContainText(recorded)
  await review.getByRole('button', { name: 'Checkout', exact: true }).click()
  await expect(one).toContainText(`detached ${recorded.slice(0, 8)}`, { timeout: 30_000 })
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(recorded)
  expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(rootIndex)
})

test('a leaf-to-root batch pauses for each exact child gitlink before committing its parent', async ({
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  for (const checkout of [fixture.root, fixture.one, fixture.nested]) {
    await fixture.git(checkout, ['config', 'user.name', 'Batch E2E'])
    await fixture.git(checkout, ['config', 'user.email', 'batch-e2e@example.invalid'])
    await fixture.git(checkout, ['config', 'commit.gpgsign', 'false'])
    await fixture.git(checkout, ['config', 'core.hooksPath', path.join(fixture.home, 'hooks')])
  }
  await writeFile(path.join(fixture.nested, 'file.txt'), 'leaf-to-root batch content\n')
  await fixture.git(fixture.nested, ['add', 'file.txt'])
  await writeFile(path.join(fixture.root, 'e2e-root-note.txt'), 'never stage this root note\n')
  const originalRoot = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
  const originalParent = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
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
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const batch = page.getByTestId('git-workspace-batch')
  await batch.getByRole('checkbox', { name: 'Root', exact: true }).check()
  await batch.getByRole('checkbox', { name: /\/root\/one$/ }).check()
  await batch.getByRole('checkbox', { name: /\/root\/one\/same$/ }).check()
  for (const suffix of [/\/root$/, /\/root\/one$/, /\/root\/one\/same$/]) {
    await batch
      .getByRole('group', { name: new RegExp(`Commit and publication · .*${suffix.source}`) })
      .getByRole('checkbox', { name: 'Commit staged changes', exact: true })
      .check()
  }
  await batch
    .getByRole('group', { name: /Commit and publication · .*\/root$/ })
    .getByRole('textbox', { name: 'Commit message', exact: true })
    .fill('record parent')
  await batch
    .getByRole('group', { name: /Commit and publication · .*\/root\/one$/ })
    .getByRole('textbox', { name: 'Commit message', exact: true })
    .fill('record leaf')
  await batch
    .getByRole('group', { name: /Commit and publication · .*\/root\/one\/same$/ })
    .getByRole('textbox', { name: 'Commit message', exact: true })
    .fill('change leaf')
  await batch.getByRole('button', { name: 'Review selected batch', exact: true }).click()
  await expect(batch.getByRole('group', { name: 'Batch review', exact: true })).toContainText(
    'ordered steps'
  )
  await batch.getByRole('button', { name: 'Run batch', exact: true }).click()
  await expect(
    batch.getByRole('group', { name: 'Confirm parent gitlink', exact: true })
  ).toBeVisible({ timeout: 60_000 })
  const leafOid = await fixture.git(fixture.nested, ['rev-parse', 'HEAD'])
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(originalParent)
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(originalRoot)
  await batch
    .getByRole('checkbox', { name: `Confirm gitlink same at ${leafOid}`, exact: true })
    .check()
  await batch.getByRole('button', { name: 'Continue batch', exact: true }).click()
  await expect(batch.getByRole('checkbox', { name: /^Confirm gitlink one at / })).toBeVisible({
    timeout: 60_000
  })
  const parentOid = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD:same'])).toBe(leafOid)
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(originalRoot)
  await batch
    .getByRole('checkbox', { name: `Confirm gitlink one at ${parentOid}`, exact: true })
    .check()
  await batch.getByRole('button', { name: 'Continue batch', exact: true }).click()
  await expect(batch).toContainText('Batch completed', { timeout: 60_000 })
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD:one'])).toBe(parentOid)
  expect(await fixture.git(fixture.nested, ['show', 'HEAD:file.txt'])).toBe(
    'leaf-to-root batch content'
  )
  expect(await fixture.git(fixture.root, ['status', '--porcelain'])).toBe('?? e2e-root-note.txt')
})

test('URL sync is reviewed offline and removal retains the checkout and its unpublished commit', async ({
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await writeFile(path.join(fixture.one, 'file.txt'), 'unpublished child data\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'unpublished data'])
  const unpublished = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
  const originalUrl = await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])
  const replacementUrl = path.join(fixture.directory, 'offline-child.git')
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
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  const one = catalog.getByTestId('git-submodule-row').filter({
    has: page.getByRole('button', { name: 'one', exact: true })
  })
  const actions = one.getByTestId('git-submodule-actions')
  await actions
    .getByRole('textbox', { name: 'Replacement URL (optional)', exact: true })
    .fill(replacementUrl)
  await actions.getByRole('button', { name: 'Preview URL sync', exact: true }).click()
  const review = actions.getByRole('group', { name: 'Operation review' })
  await expect(review).toContainText(originalUrl)
  await expect(review).toContainText(replacementUrl)
  expect(await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])).toBe(
    originalUrl
  )
  await review.getByRole('button', { name: 'Sync URL', exact: true }).click()
  await expect(one).toContainText(`Local: ${replacementUrl}`, { timeout: 30_000 })
  expect(await fixture.git(fixture.one, ['remote', 'get-url', 'origin'])).toBe(replacementUrl)
  await actions.getByRole('button', { name: 'Preview remove', exact: true }).click()
  await expect(review).toContainText('retained')
  await review.getByRole('button', { name: 'Confirm remove', exact: true }).click()
  await expect(actions).toContainText('remove completed', { timeout: 30_000 })
  expect(await fixture.git(fixture.root, ['ls-files', '--stage', '--', 'one'])).toBe('')
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(unpublished)
  expect(await readFile(path.join(fixture.one, 'file.txt'), 'utf8')).toBe(
    'unpublished child data\n'
  )
  expect(await fixture.git(fixture.root, ['config', '--get', 'submodule.same.url'])).toBe(
    replacementUrl
  )
})

test('adding inside the selected submodule leaves the root index untouched', async ({
  orcaPage: page,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await writeFile(path.join(fixture.root, 'e2e-root-note.txt'), 'root note\n')
  const rootIndex = await fixture.git(fixture.root, ['ls-files', '--stage'])
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
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  await catalog.getByRole('button', { name: 'one', exact: true }).click()
  const form = catalog.getByTestId('git-submodule-add')
  await form
    .getByRole('textbox', { name: 'URL', exact: true })
    .fill(path.join(fixture.directory, 'leaf'))
  await form
    .getByRole('textbox', { name: 'Path relative to selected parent', exact: true })
    .fill('new-leaf')
  await form.getByRole('button', { name: 'Preview add', exact: true }).click()
  await expect(form.getByRole('group', { name: 'Add review' })).toContainText('new-leaf')
  expect(await fixture.git(fixture.one, ['ls-files', '--stage', '--', 'new-leaf'])).toBe('')
  await form.getByRole('button', { name: 'Confirm add', exact: true }).click()
  await expect(
    catalog.getByTestId('git-submodule-row').filter({ hasText: 'one/new-leaf' })
  ).toContainText('initialized', { timeout: 30_000 })
  expect(await fixture.git(fixture.one, ['rev-parse', ':new-leaf'])).toBe(
    await fixture.git(path.join(fixture.one, 'new-leaf'), ['rev-parse', 'HEAD'])
  )
  expect(await fixture.git(fixture.root, ['ls-files', '--stage'])).toBe(rootIndex)
})

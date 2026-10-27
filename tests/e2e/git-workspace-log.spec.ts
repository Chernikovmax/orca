import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { activateGoldenWorktree, openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

async function openContextLog(page: Page, query: string, contextKey: RegExp): Promise<void> {
  await page.keyboard.press('Control+Alt+KeyG')
  const popup = page.getByTestId('git-workspace-popup')
  await expect(popup).toBeVisible()
  await popup.getByRole('textbox', { name: 'Search repositories' }).fill(query)
  await popup.locator('[data-context-key]').filter({ hasText: contextKey }).first().click()
  await popup.getByRole('button', { name: 'Open Log', exact: true }).click()
  await expect(popup).not.toBeVisible()
}

test('Git log graphs real history, pages by pinned OID, compares merge parents and keeps Git state', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))

  const commit = async (cwd: string, file: string, content: string, message: string) => {
    const target = path.join(cwd, file)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
    await fixture.git(cwd, ['add', file])
    await fixture.git(cwd, ['commit', '-qm', message])
  }

  await fixture.git(fixture.root, ['checkout', '-b', 'log-side'])
  await commit(fixture.root, 'side-only.txt', 'side\n', 'side change')
  await fixture.git(fixture.root, ['checkout', 'main'])
  await commit(fixture.root, 'main-only.txt', 'main\n', 'main change')
  await fixture.git(fixture.root, [
    '-c',
    'user.name=Workspace Test',
    '-c',
    'user.email=workspace@example.invalid',
    'merge',
    '--no-ff',
    '-m',
    'merge side',
    'log-side'
  ])
  for (let index = 0; index < 60; index += 1) {
    await commit(fixture.root, `paged/${index}.txt`, `${index}\n`, `paged ${index}`)
  }
  await commit(fixture.one, 'child-a.txt', 'child\n', 'child history marker')
  await commit(fixture.nested, 'nested-marker.txt', 'nested\n', 'nested history marker')
  await commit(fixture.second, 'second-marker.txt', 'second\n', 'second worktree marker')
  const rootCount = Number(await fixture.git(fixture.root, ['rev-list', '--count', 'HEAD']))
  expect(rootCount).toBeGreaterThan(50)

  const worktrees = [fixture.root, fixture.one, fixture.nested, fixture.two, fixture.second]
  const snapshot = async () =>
    Promise.all(
      worktrees.map(async (cwd) => ({
        cwd,
        head: await fixture.git(cwd, ['rev-parse', 'HEAD']),
        refs: await fixture.git(cwd, ['show-ref']),
        index: await fixture.git(cwd, ['ls-files', '--stage']),
        status: await fixture.git(cwd, ['status', '--porcelain'])
      }))
    )

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

  // 1. Open Log from the Source Control view switch.
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  const log = page.getByTestId('git-context-log')
  await expect(log).toContainText('Log · Root', { timeout: 30_000 })
  await expect(log).toContainText('50+', { timeout: 30_000 })
  await expect(log).toContainText('local history only, no fetch or clone')

  // 2. The merge row keeps its graph and explicit parents.
  await log.getByRole('textbox', { name: 'Commit message filter' }).fill('merge side')
  const mergeRow = log.getByTestId('git-history-row').first()
  await expect(mergeRow).toContainText('merge side', { timeout: 30_000 })
  expect(await mergeRow.locator('svg').count()).toBeGreaterThan(0)
  const details = log.getByTestId('git-log-details')
  await expect(details).toContainText('merge of 2 parents')
  await details.getByRole('button', { name: /Parent 2/ }).click()
  await expect(log.getByTestId('git-log-file').filter({ hasText: 'main-only.txt' })).toBeVisible({
    timeout: 30_000
  })
  await expect(log.getByTestId('git-log-file').filter({ hasText: 'side-only.txt' })).toHaveCount(0)
  await details.getByRole('button', { name: /Parent 1/ }).click()
  await expect(log.getByTestId('git-log-file').filter({ hasText: 'side-only.txt' })).toBeVisible({
    timeout: 30_000
  })
  await expect(log.getByTestId('git-log-file').filter({ hasText: 'main-only.txt' })).toHaveCount(0)

  // 3. A commit file opens the existing Monaco diff with the chosen base.
  await log.getByTestId('git-log-file').filter({ hasText: 'side-only.txt' }).click()
  const document = page.getByTestId('git-diff-document')
  await expect(document).toContainText('side-only.txt', { timeout: 30_000 })
  await expect(
    page.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'side' })
  ).toBeVisible({ timeout: 30_000 })

  // 4. Compare two revisions through the same commit-diff surface.
  await log.getByRole('textbox', { name: 'Commit message filter' }).fill('')
  await details.getByRole('button', { name: 'Use as compare base' }).click()
  await expect(log.getByTestId('git-log-compare-mode')).toContainText('Comparing')
  const pathFilter = log.getByRole('textbox', { name: 'History path filter' })
  await pathFilter.fill('side-only.txt')
  const sideRow = log.getByTestId('git-history-row').first()
  await expect(sideRow).toContainText('side change', { timeout: 30_000 })
  await sideRow.click()
  await expect(log.getByTestId('git-log-file').filter({ hasText: 'main-only.txt' })).toBeVisible({
    timeout: 30_000
  })
  await log.getByRole('button', { name: 'Exit compare' }).click()
  await pathFilter.fill('')

  // 5. Paging keeps the pinned OID and reaches the end of this history.
  log.getByRole('button', { name: 'Load more commits' }).click()
  await expect(log.getByRole('button', { name: 'Load more commits' })).toHaveCount(0, {
    timeout: 30_000
  })
  await expect(log).toContainText(String(rootCount))
  await expect(log.getByTestId('git-log-changed-files')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: '.cache/stage5-log-root.png' })

  // 6. An external commit invalidates the loaded generation instead of mixing pages.
  await commit(fixture.root, 'external-refresh.txt', 'external\n', 'external refs change')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(log).toContainText('external refs change', { timeout: 20_000 })
  const afterExternal = await snapshot()

  // 7. Open a child Log from the contexts popup; the parent history is not substituted.
  await openContextLog(page, 'one/same', /^sameone\/same/)
  await expect(log).toContainText('Log · one/same', { timeout: 30_000 })
  await expect(log).toContainText('nested history marker', { timeout: 30_000 })
  await log.getByRole('textbox', { name: 'Commit message filter' }).fill('merge side')
  await expect(log.getByTestId('git-history-row')).toHaveCount(0, { timeout: 20_000 })
  expect(await log.textContent()).not.toContain('merge side')
  await log.getByRole('textbox', { name: 'Commit message filter' }).fill('')
  await expect(log).toContainText('nested history marker', { timeout: 30_000 })
  await page.screenshot({ path: '.cache/stage5-log-child.png' })

  // 8. A gitlink diff opens that submodule's Log, and Changes has the same entry point.
  await page.keyboard.press('Control+Alt+KeyG')
  const contextPopup = page.getByTestId('git-workspace-popup')
  await expect(contextPopup).toBeVisible()
  await contextPopup
    .getByRole('textbox', { name: 'Search repositories' })
    .fill('')
  await contextPopup.locator('[data-context-key]').filter({ hasText: 'Root' }).first().click()
  await contextPopup.getByRole('button', { name: 'Open Changes', exact: true }).click()
  await expect(contextPopup).not.toBeVisible()
  const changes = page.getByTestId('git-context-changes')
  await expect(changes).toContainText('Changes · Root', { timeout: 30_000 })
  await changes.getByRole('textbox', { name: 'Filter changes' }).fill('one')
  await changes
    .getByTestId('source-control-entry')
    .filter({ hasText: 'one' })
    .first()
    .click()
  await expect(page.getByTestId('git-diff-special')).toContainText('Submodule commit changed', {
    timeout: 30_000
  })
  await document.getByRole('button', { name: 'Open child Log' }).click()
  await expect(log).toContainText('Log · one', { timeout: 30_000 })
  await expect(log).toContainText('child history marker', { timeout: 30_000 })
  await page.getByRole('button', { name: 'Changes', exact: true }).click()
  await expectationsForChangesOpenLog(page)

  // 9. Detached HEAD is explicit, then restored.
  await fixture.git(fixture.two, ['checkout', '--detach'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await openContextLog(page, 'two', /^twotwo/)
  await expect(log).toContainText(/HEAD · [0-9a-f]{8}/, { timeout: 30_000 })
  await fixture.git(fixture.two, ['checkout', 'main'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // 10. An unborn checkout shows an explicit empty history.
  const emptyRepo = path.join(fixture.directory, 'empty-log-repo')
  await mkdir(emptyRepo)
  await fixture.git(emptyRepo, ['init', '-q'])
  await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
  }, emptyRepo)
  await activateGoldenWorktree(page, emptyRepo, emptyRepo)
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await page.getByRole('button', { name: 'Log', exact: true }).click()
  await expect(log).toContainText('Log · Root', { timeout: 30_000 })
  await expect(log).toContainText('No commits in this checkout yet.', { timeout: 30_000 })
  await expect(log).toContainText(/HEAD · unborn/)
  await page.screenshot({ path: '.cache/stage5-log-empty.png' })

  // 11. A locally missing object is reported explicitly and never fetched.
  const nestedGitDir = await fixture.git(fixture.nested, ['rev-parse', '--absolute-git-dir'])
  const missingOid = await fixture.git(fixture.nested, ['rev-parse', 'HEAD^'])
  const objectPath = path.join(nestedGitDir, 'objects', missingOid.slice(0, 2), missingOid.slice(2))
  const objectBytes = await readFile(objectPath)
  await unlink(objectPath)
  await activateGoldenWorktree(page, fixture.root, fixture.root)
  await page.getByRole('button', { name: /Source Control/ }).click()
  await openContextLog(page, 'one/same', /^sameone\/same/)
  await expect(log.getByRole('alert')).toContainText('no fetch was attempted', {
    timeout: 30_000
  })
  await mkdir(path.dirname(objectPath), { recursive: true })
  await writeFile(objectPath, objectBytes)
  await log.getByRole('button', { name: 'Refresh' }).click()
  await expect(log).toContainText('nested history marker', { timeout: 30_000 })

  // 12. Browsing changed no HEAD, refs, index or status.
  const after = await snapshot()
  expect(after).toEqual(afterExternal)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

async function expectationsForChangesOpenLog(page: Page): Promise<void> {
  const changes = page.getByTestId('git-context-changes')
  await expect(changes).toContainText('Changes · one', { timeout: 30_000 })
  await changes.getByRole('button', { name: 'Open Log', exact: true }).click()
  const log = page.getByTestId('git-context-log')
  await expect(log).toContainText('Log · one', { timeout: 30_000 })
  await expect(log).toContainText('child history marker', { timeout: 30_000 })
}

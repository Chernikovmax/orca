import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

test('Git popup supports keyboard browsing, context-isolated refs and actual child Changes without mutations', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  for (const cwd of [fixture.root, fixture.one, fixture.nested, fixture.two]) {
    await fixture.git(cwd, ['branch', 'shared-name'])
    await fixture.git(cwd, ['tag', 'release-popup'])
    await fixture.git(cwd, ['update-ref', 'refs/remotes/offline/shared-name', 'HEAD'])
  }
  await fixture.git(fixture.root, ['branch', 'root-only'])
  await fixture.git(fixture.nested, ['branch', 'nested-only'])
  await writeFile(path.join(fixture.nested, 'only-nested.txt'), 'actual nested change\n')
  await writeFile(path.join(fixture.root, 'only-root.txt'), 'actual root change\n')
  const before = await Promise.all(
    [fixture.root, fixture.one, fixture.nested, fixture.two].map(async (cwd) => ({
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
  const branch = page.getByTestId('source-control-head-identity')
  await page.evaluate(() => {
    let shellScheduled = false
    let refsScheduled = false
    const observer = new MutationObserver(() => {
      if (!performance.getEntriesByName('stage2-popup-start').length) {
        return
      }
      const popup = document.querySelector('[data-testid="git-workspace-popup"]')
      if (popup && !shellScheduled) {
        shellScheduled = true
        performance.measure('stage2-popup-shell', 'stage2-popup-start')
      }
      if (
        popup?.querySelector('[aria-label="Local"]')?.textContent?.includes('root-only') &&
        !refsScheduled
      ) {
        refsScheduled = true
        performance.measure('stage2-popup-refs', 'stage2-popup-start')
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    const markOpen = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="source-control-head-identity"]')
      ) {
        performance.mark('stage2-popup-start')
        document.removeEventListener('click', markOpen, true)
      }
    }
    document.addEventListener('click', markOpen, true)
  })
  await branch.click()
  const popup = page.getByTestId('git-workspace-popup')
  const repositories = popup.getByRole('group', { name: 'Repository results' })
  await expect(repositories.locator('[data-context-key]')).toHaveCount(4, { timeout: 30_000 })
  const root = repositories.locator('[data-context-key]').filter({ hasText: 'Root' })
  const nested = repositories.locator('[data-context-key]').filter({ hasText: 'one/same' })
  const one = repositories.locator('[data-context-key]').filter({ hasText: /^sameone(?!\/)/ })
  await expect(repositories.locator('[data-context-key]').filter({ hasText: 'two' })).toContainText(
    'clean'
  )
  await expect(popup.getByRole('region', { name: 'Local', exact: true })).toContainText(
    'root-only',
    { timeout: 30_000 }
  )
  const timings = await page.evaluate(() => ({
    shellMs: performance.getEntriesByName('stage2-popup-shell')[0].duration,
    rootRefsMs: performance.getEntriesByName('stage2-popup-refs')[0].duration
  }))
  console.log('STAGE2_POPUP_BASELINE', JSON.stringify(timings))
  await test.info().attach('popup-opening-baseline', {
    body: JSON.stringify(timings),
    contentType: 'application/json'
  })
  await page.keyboard.press('Escape')
  await expect(popup).not.toBeVisible()
  await expect(branch).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(popup).toBeVisible()
  const searchRepositories = popup.getByRole('textbox', { name: 'Search repositories' })
  await expect(searchRepositories).toBeFocused()
  await searchRepositories.fill('one/same')
  await searchRepositories.press('ArrowDown')
  await expect(nested).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(popup.getByRole('heading', { name: 'same · one/same' })).toBeVisible()
  await expect(popup).not.toContainText('root-only')
  const refSearch = popup.getByRole('textbox', { name: 'Search refs' })
  await expect(refSearch).toBeFocused()
  await expect(popup.getByRole('region', { name: 'Local', exact: true })).toContainText(
    'nested-only',
    { timeout: 30_000 }
  )
  await expect(popup).not.toContainText('root-only')
  await refSearch.fill('shared-name')
  await refSearch.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(popup.getByRole('region', { name: 'Ref details' })).toContainText(
    'refs/heads/shared-name'
  )
  await expect(popup.getByRole('region', { name: 'Recent', exact: true })).toContainText(
    'shared-name'
  )
  await popup
    .getByRole('region', { name: 'Local', exact: true })
    .getByRole('button', { name: 'Favorite refs/heads/shared-name', exact: true })
    .click()
  await expect(
    popup
      .getByRole('region', { name: 'Local', exact: true })
      .getByRole('button', { name: 'Favorite refs/heads/shared-name', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await popup
    .getByRole('region', { name: 'Local', exact: true })
    .getByRole('button', { name: 'shared-name', exact: true })
    .press('ArrowLeft')
  await expect(searchRepositories).toBeFocused()
  await searchRepositories.fill('')
  await root.click()
  await expect(refSearch).toHaveValue('')
  await expect(popup.getByRole('region', { name: 'Local', exact: true })).toContainText(
    'root-only',
    { timeout: 30_000 }
  )
  await expect(popup.getByRole('region', { name: 'Recent', exact: true })).toContainText(
    'No recent refs'
  )
  await expect(
    popup
      .getByRole('region', { name: 'Local', exact: true })
      .getByRole('button', { name: 'Favorite refs/heads/shared-name', exact: true })
  ).toHaveAttribute('aria-pressed', 'false')
  await nested.click()
  await expect(refSearch).toHaveValue('shared-name')
  await expect(popup.getByRole('region', { name: 'Recent', exact: true })).toContainText(
    'shared-name',
    { timeout: 30_000 }
  )
  await refSearch.fill('release-popup')
  await expect(popup.getByRole('region', { name: 'Tags', exact: true })).toContainText(
    'release-popup'
  )
  await refSearch.fill('offline/shared-name')
  await expect(popup.getByRole('region', { name: 'Remote', exact: true })).toContainText(
    'offline/shared-name'
  )
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(popup).not.toBeVisible()
  const changes = page.getByRole('region', { name: 'Context changes' })
  await expect(changes).toContainText('Changes · one/same')
  await expect(changes).toContainText('only-nested.txt')
  await expect(changes).not.toContainText('only-root.txt')
  const after = await Promise.all(
    [fixture.root, fixture.one, fixture.nested, fixture.two].map(async (cwd) => ({
      head: await fixture.git(cwd, ['rev-parse', 'HEAD']),
      refs: await fixture.git(cwd, ['show-ref']),
      index: await fixture.git(cwd, ['ls-files', '--stage']),
      status: await fixture.git(cwd, ['status', '--porcelain'])
    }))
  )
  expect(after).toEqual(before)

  await page.keyboard.press('Control+Alt+KeyG')
  await expect(
    popup
      .getByRole('region', { name: 'Context refs' })
      .getByRole('heading', { name: 'same · one/same' })
  ).toBeVisible()
  await expect(popup.getByRole('textbox', { name: 'Search refs' })).toHaveValue(
    'offline/shared-name'
  )
  await popup.getByRole('textbox', { name: 'Search refs' }).fill('shared-name')
  await expect(
    popup
      .getByRole('region', { name: 'Local', exact: true })
      .getByRole('button', { name: 'Favorite refs/heads/shared-name', exact: true })
  ).toHaveAttribute('aria-pressed', 'true')
  await popup.getByRole('textbox', { name: 'Search refs' }).fill('')
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Tree', exact: true }).click()
  await expect(popup.getByRole('button', { name: 'Flat', exact: true })).toBeVisible()
  await expect(repositories.locator('[data-context-key]')).toHaveCount(4)
  await popup.getByRole('button', { name: 'Flat', exact: true }).click()
  await popup.getByRole('button', { name: 'Collapse one', exact: true }).click()
  await expect(nested).toHaveCount(0)
  await popup.getByRole('button', { name: 'Expand one', exact: true }).click()
  await expect(nested).toHaveCount(1)
  await one.hover()
  await expect(popup.getByRole('heading', { name: 'same · one/same' })).toBeVisible()
  await fixture.git(fixture.one, ['checkout', '-b', 'external-popup-branch'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(one).toContainText('external-popup-branch', { timeout: 12_000 })
  await fixture.git(fixture.two, ['checkout', '--detach'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(repositories.locator('[data-context-key]').filter({ hasText: 'two' })).toContainText(
    'detached',
    { timeout: 12_000 }
  )
  await fixture.git(fixture.two, ['checkout', '-b', 'conflicting-side'])
  await writeFile(path.join(fixture.two, 'file.txt'), 'side\n')
  await fixture.git(fixture.two, ['commit', '-qam', 'side'])
  await fixture.git(fixture.two, ['checkout', 'main'])
  await writeFile(path.join(fixture.two, 'file.txt'), 'main\n')
  await fixture.git(fixture.two, ['commit', '-qam', 'main'])
  await fixture.git(fixture.two, ['merge', 'conflicting-side'], 1)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(repositories.locator('[data-context-key]').filter({ hasText: 'two' })).toContainText(
    'conflicts',
    { timeout: 12_000 }
  )
  await page.screenshot({ path: '.cache/stage2-popup-refs.png' })
  await fixture.git(fixture.one, ['submodule', 'deinit', '-f', 'same'])
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(nested).toContainText('uninitialized', { timeout: 12_000 })
  await nested.click()
  await expect(popup.getByRole('region', { name: 'Context refs' })).toContainText(
    'Descendants: unknown'
  )
  await expect(refSearch).toBeDisabled()
  await expect(popup.getByRole('button', { name: 'Open Changes', exact: true })).toHaveCount(0)
  await page.screenshot({ path: '.cache/stage2-popup.png' })
  await page.keyboard.press('Escape')
  await expect(popup).not.toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

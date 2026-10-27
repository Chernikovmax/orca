import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { goldenWorktreePathsMatch, openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

test('Git contexts show recursive states, external changes, context errors and worktree isolation in Electron', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await writeFile(path.join(fixture.one, 'file.txt'), 'committed in child\n')
  await fixture.git(fixture.one, ['commit', '-qam', 'child head'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'child dirty\n')
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
  await expect(catalog).toBeVisible()
  await expect(catalog.getByRole('status')).toContainText('Local snapshot', { timeout: 30_000 })
  await expect(catalog.getByTestId('git-submodule-row')).toHaveCount(3)
  const one = catalog
    .getByTestId('git-submodule-row')
    .filter({ has: page.getByRole('button', { name: 'one', exact: true }) })
  await expect(one).toContainText('new HEAD')
  await expect(one).toContainText('dirty files')
  await expect(
    catalog.getByTestId('git-submodule-row').filter({
      has: page.getByRole('button', { name: 'two', exact: true })
    })
  ).toContainText('clean')
  await catalog.getByRole('button', { name: 'one', exact: true }).click()
  await expect(catalog.getByRole('region', { name: 'Context changes' })).toContainText('file.txt')
  await writeFile(path.join(fixture.one, 'externally-created.txt'), 'watch this real file\n')
  await expect(catalog.getByRole('region', { name: 'Context changes' })).toContainText(
    'externally-created.txt',
    { timeout: 12_000 }
  )
  await fixture.git(fixture.two, ['checkout', '-b', 'side'])
  await writeFile(path.join(fixture.two, 'file.txt'), 'side\n')
  await fixture.git(fixture.two, ['commit', '-qam', 'side'])
  await fixture.git(fixture.two, ['checkout', 'main'])
  await writeFile(path.join(fixture.two, 'file.txt'), 'main\n')
  await fixture.git(fixture.two, ['commit', '-qam', 'main'])
  await fixture.git(fixture.two, ['merge', 'side'], 1)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const two = catalog.getByTestId('git-submodule-row').filter({
    has: page.getByRole('button', { name: 'two', exact: true })
  })
  await expect(two).toContainText('conflicts', { timeout: 12_000 })
  await catalog.getByRole('button', { name: 'two', exact: true }).click()
  await expect(catalog.getByRole('region', { name: 'Context changes' })).toContainText(
    'conflict · modified'
  )
  await fixture.git(fixture.root, [
    'config',
    '--file',
    '.gitmodules',
    'submodule.same.path',
    'renamed-one'
  ])
  await catalog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(one).toContainText('different paths across metadata sources')
  await expect(catalog.getByRole('status')).toContainText('Incomplete discovery')
  await fixture.git(fixture.one, ['submodule', 'deinit', '-f', 'same'])
  await catalog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(catalog.getByRole('status')).toContainText('Loading Git contexts')
  const nested = catalog.getByTestId('git-submodule-row').filter({ hasText: 'one/same' })
  await expect(nested).toContainText('uninitialized', { timeout: 30_000 })
  await expect(nested).toContainText('Descendants: unknown')
  await rename(path.join(fixture.two, '.git'), path.join(fixture.two, 'saved-git-marker'))
  await writeFile(path.join(fixture.two, '.git'), 'gitdir: /outside-authorized-fixture\n')
  await catalog.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(two).toContainText('access-denied', { timeout: 30_000 })
  await expect(one).toContainText('dirty files')
  await page.screenshot({ path: '.cache/stage1-git-contexts.png' })
  const visible = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((window) => window.isVisible())
  )
  expect(visible).toBe(false)
  const detected = await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    for (const repo of store.getState().repos) {
      await store.getState().fetchWorktrees(repo.id)
    }
    return Object.values(store.getState().detectedWorktreesByRepo).flatMap(
      (result) => result.worktrees.map((entry) => ({ id: entry.id, path: entry.path }))
    )
  })
  const second = detected.find((entry) => goldenWorktreePathsMatch(entry.path, fixture.second))
  if (!second) {
    throw new Error('Real linked worktree was not detected')
  }
  await page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), second.id)
  await expect(catalog.getByTestId('git-submodule-row')).toHaveCount(2, { timeout: 30_000 })
  await expect(one).toContainText('uninitialized')
  expect(await fixture.git(fixture.root, ['diff', '--cached', '--name-only'])).toBe('')
  expect(await fixture.git(fixture.one, ['status', '--porcelain'])).toContain(
    'externally-created.txt'
  )
})

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  openConflictProject,
  openContextChanges,
  selectConflictContext
} from './helpers/git-conflict-workspace'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

test('failed watcher notifications preserve isolated commit drafts and focus reconciles healthy contexts beside a blocked child', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(180_000)
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await writeFile(path.join(fixture.root, 'file.txt'), 'root staged content\n')
  await fixture.git(fixture.root, ['add', 'file.txt'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'child staged content\n')
  await fixture.git(fixture.one, ['add', 'file.txt'])
  const originalMarker = await readFile(path.join(fixture.two, '.git'), 'utf8')
  await writeFile(
    path.join(fixture.two, '.git'),
    `gitdir: ${path.join(fixture.directory, 'outside-authority.git')}\n`
  )
  const fingerprint = async (cwd: string) => ({
    head: await fixture.git(cwd, ['rev-parse', 'HEAD']),
    refs: await fixture.git(cwd, ['show-ref']),
    index: await fixture.git(cwd, ['ls-files', '--stage']),
    status: await fixture.git(cwd, ['status', '--porcelain', '--ignore-submodules=all'])
  })
  const initialRoot = await fingerprint(fixture.root)
  const initialChild = await fingerprint(fixture.one)
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('fs:watchWorktree')
    ipcMain.handle('fs:watchWorktree', () => {
      throw new Error('Stage9 fixture: file watch subscription unavailable')
    })
    for (const window of BrowserWindow.getAllWindows()) {
      const send = window.webContents.send.bind(window.webContents)
      window.webContents.send = (channel, ...args) => {
        if (
          channel === 'fs:changed' ||
          channel === 'worktrees:gitStatusMetadataChanged' ||
          channel === 'worktrees:headIdentitiesChanged'
        ) {
          return
        }
        send(channel, ...args)
      }
    }
  })
  await openConflictProject(page, fixture)
  const watchDenied = await page.evaluate(async (worktreePath) => {
    try {
      await window.api.fs.watchWorktree({ worktreePath })
      return false
    } catch {
      return true
    }
  }, fixture.root)
  expect(watchDenied).toBe(true)
  const rootDraft = page.getByRole('textbox', { name: 'Commit message', exact: true })
  await rootDraft.fill('root draft stays at root')
  await openContextChanges(page, 'one')
  const childDraft = page.getByTestId('git-context-commit-message')
  await childDraft.fill('child draft stays in one')
  await openContextChanges(page, 'root')
  await expect(rootDraft).toHaveValue('root draft stays at root')
  await openContextChanges(page, 'one')
  await expect(childDraft).toHaveValue('child draft stays in one')
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  const blocked = catalog
    .getByTestId('git-submodule-row')
    .filter({ has: page.getByRole('button', { name: 'two', exact: true }) })
  await expect(blocked).toContainText(/unavailable|access-denied|uninitialized/, {
    timeout: 15_000
  })
  await openContextChanges(page, 'one')
  const changes = page.getByTestId('git-context-changes')
  const previewButton = changes.getByRole('button', { name: 'Preview staged set', exact: true })
  await expect(previewButton).toBeEnabled()
  await previewButton.click()
  await expect(changes.getByTestId('git-commit-preview')).toContainText('file.txt')
  await expect(childDraft).toHaveValue('child draft stays in one')

  // Remount the catalog so its 15-second visibility reconciliation cannot explain this immediate recovery.
  await page.getByRole('button', { name: /^Explorer\b/ }).click()
  await page.getByRole('button', { name: /Source Control/ }).click()
  await openContextChanges(page, 'one')
  await expect(childDraft).toHaveValue('child draft stays in one')
  await fixture.git(fixture.one, ['branch', 'stage9-external-ref'])
  await writeFile(path.join(fixture.one, 'focus-recovered.txt'), 'external child file\n')
  const recoveryStarted = Date.now()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(changes).toContainText('focus-recovered.txt', { timeout: 5000 })
  expect(Date.now() - recoveryStarted).toBeLessThan(15_000)
  await childDraft.focus()
  const popup = await selectConflictContext(page, 'one')
  const search = popup.getByRole('textbox', { name: 'Search refs' })
  await search.fill('stage9-external-ref')
  await expect(popup.getByRole('region', { name: 'Local', exact: true })).toContainText(
    'stage9-external-ref'
  )
  await search.focus()
  await search.press('Escape')
  await expect(popup).not.toBeVisible()
  await expect(childDraft).toHaveValue('child draft stays in one')
  const afterExternalChild = await fingerprint(fixture.one)
  expect(afterExternalChild.head).toBe(initialChild.head)
  expect(afterExternalChild.index).toBe(initialChild.index)
  expect(afterExternalChild.refs).toContain('refs/heads/stage9-external-ref')
  expect(afterExternalChild.status).toContain('focus-recovered.txt')
  await expect(childDraft).toBeFocused()
  expect(await fingerprint(fixture.root)).toEqual(initialRoot)
  expect(await readFile(path.join(fixture.root, 'file.txt'), 'utf8')).toBe('root staged content\n')
  expect(await readFile(path.join(fixture.one, 'file.txt'), 'utf8')).toBe('child staged content\n')
  expect(await readFile(path.join(fixture.one, 'focus-recovered.txt'), 'utf8')).toBe(
    'external child file\n'
  )
  await openContextChanges(page, 'root')
  await expect(rootDraft).toHaveValue('root draft stays at root')
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeEnabled()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
  await writeFile(path.join(fixture.two, '.git'), originalMarker)
})

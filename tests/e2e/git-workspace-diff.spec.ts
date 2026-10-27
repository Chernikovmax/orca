import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import { createGitWorkspaceFixture } from '../../src/main/git/source-control/git-workspace-test-fixture'

test('root and child Changes open real Monaco sides, refresh external edits and preserve Git state', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  await writeFile(path.join(fixture.root, 'file.txt'), 'root staged content\n')
  await fixture.git(fixture.root, ['add', 'file.txt'])
  await writeFile(path.join(fixture.root, 'file.txt'), 'root working content\n')
  await writeFile(path.join(fixture.one, 'file.txt'), 'child pointer baseline\n')
  await fixture.git(fixture.one, ['add', 'file.txt'])
  await fixture.git(fixture.one, ['commit', '-qm', 'move child gitlink'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'child staged content\n')
  await fixture.git(fixture.one, ['add', 'file.txt'])
  await writeFile(path.join(fixture.one, 'file.txt'), 'child working content\r\nno final newline')
  await writeFile(path.join(fixture.one, 'binary.bin'), Buffer.from([0, 4, 5]))
  await writeFile(path.join(fixture.one, 'huge.txt'), Buffer.alloc(9 * 1024 * 1024, 65))
  const before = await Promise.all(
    [fixture.root, fixture.one, fixture.two].map(async (cwd) => ({
      head: await fixture.git(cwd, ['rev-parse', 'HEAD']),
      index: await fixture.git(cwd, ['ls-files', '--stage']),
      status: await fixture.git(cwd, ['status', '--porcelain=v2'])
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
  const changes = page.getByTestId('git-context-changes')
  await expect(changes).toContainText('Changes · Root', { timeout: 30_000 })
  const unstaged = changes.getByRole('region', { name: 'Unstaged', exact: true })
  const staged = changes.getByRole('region', { name: 'Staged', exact: true })
  await unstaged.getByTestId('source-control-entry').filter({ hasText: 'file.txt' }).click()
  const document = page.getByTestId('git-diff-document')
  await expect(document).toContainText('INDEX · file.txt', { timeout: 30_000 })
  await document.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expect(
    page
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'root staged content' })
  ).toBeVisible()
  await expect(
    page
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'root working content' })
  ).toBeVisible()
  await staged.getByTestId('source-control-entry').filter({ hasText: 'file.txt' }).click()
  await expect(document).toContainText('HEAD · file.txt')
  await expect(
    page.locator('.original-in-monaco-diff-editor .view-line').filter({ hasText: 'root initial' })
  ).toBeVisible()
  await expect(
    page
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'root staged content' })
  ).toBeVisible()
  await unstaged.getByTestId('source-control-entry').filter({ hasText: 'one' }).click()
  await expect(page.getByTestId('git-diff-special')).toContainText('Submodule commit changed')
  await document.getByRole('button', { name: 'Open child Changes' }).click()
  await expect(changes).toContainText('Changes · one')
  await page.getByRole('button', { name: 'Changes', exact: true }).click()
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  const catalog = page.getByTestId('git-workspace-catalog')
  await catalog.getByRole('button', { name: 'one', exact: true }).click()
  await expect(changes).toContainText('Changes · one')
  await unstaged.getByTestId('source-control-entry').filter({ hasText: 'file.txt' }).click()
  await expect(document).toContainText('No final newline', { timeout: 30_000 })
  await expect(
    page
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'child staged content' })
  ).toBeVisible()
  await expect(
    page
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'child working content' })
  ).toBeVisible()
  await document.getByRole('button', { name: 'Unified', exact: true }).click()
  await expect(page.locator('.monaco-diff-editor')).not.toHaveClass(/side-by-side/)
  await staged.getByTestId('source-control-entry').filter({ hasText: 'file.txt' }).click()
  await expect(document).toContainText('HEAD · file.txt')
  await document.getByRole('button', { name: 'Side by side', exact: true }).click()
  await expect(
    page
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'child pointer baseline' })
  ).toBeVisible()
  await expect(
    page
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'child staged content' })
  ).toBeVisible()
  const untracked = changes.getByRole('region', { name: 'Untracked', exact: true })
  await untracked.getByTestId('source-control-entry').filter({ hasText: 'binary.bin' }).click()
  await expect(page.getByText('Binary file changed', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await untracked.getByTestId('source-control-entry').filter({ hasText: 'huge.txt' }).click()
  await expect(page.getByTestId('git-diff-special')).toContainText('File too large for text diff', {
    timeout: 30_000
  })
  const after = await Promise.all(
    [fixture.root, fixture.one, fixture.two].map(async (cwd) => ({
      head: await fixture.git(cwd, ['rev-parse', 'HEAD']),
      index: await fixture.git(cwd, ['ls-files', '--stage']),
      status: await fixture.git(cwd, ['status', '--porcelain=v2'])
    }))
  )
  expect(after).toEqual(before)
  await unstaged.getByTestId('source-control-entry').filter({ hasText: 'file.txt' }).click()
  await writeFile(path.join(fixture.one, 'file.txt'), 'externally refreshed child content\n')
  await expect(
    page
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: 'externally refreshed child content' })
  ).toBeVisible({ timeout: 12_000 })
  expect(await fixture.git(fixture.one, ['show', ':file.txt'])).toBe('child staged content')
  await changes.getByRole('textbox', { name: 'Filter changes' }).fill('binary')
  await expect(changes.getByTestId('source-control-entry')).toHaveCount(1)
  await changes.getByRole('textbox', { name: 'Filter changes' }).fill('')
  await changes.getByRole('button', { name: 'Next file', exact: true }).click()
  await expect(document).toBeVisible()
  await page.screenshot({ path: '.cache/stage3-child-diff.png' })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

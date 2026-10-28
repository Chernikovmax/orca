import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  createConflictWorkspace,
  openConflictProject,
  openConflictResolver,
  openContextChanges,
  prepareGitlinkConflict
} from './helpers/git-conflict-workspace'

test('gitlink resolution creates a child branch and selected commit through the app without staging dirty child files', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(240_000)
  const fixture = await createConflictWorkspace()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  const { left, right } = await prepareGitlinkConflict(fixture)
  const parentHead = await fixture.git(fixture.root, ['rev-parse', 'HEAD'])
  const parentUnmerged = await fixture.git(fixture.root, ['ls-files', '--unmerged'])
  const dirtyIndexOid = await fixture.git(fixture.one, ['rev-parse', ':file.txt'])
  const siblingHead = await fixture.git(fixture.two, ['rev-parse', 'HEAD'])
  await openConflictProject(page, fixture)
  const resolver = await openConflictResolver(page, 'one')
  const gitlink = resolver.getByTestId('git-conflict-gitlink')
  await expect(gitlink).toContainText(left)
  await expect(gitlink).toContainText(right)
  await expect(gitlink).toContainText('detached HEAD')
  await expect(resolver.getByRole('button', { name: 'Save result', exact: true })).toHaveCount(0)
  await gitlink.getByRole('button', { name: 'Open child branch menu', exact: true }).click()
  const popup = page.getByTestId('git-workspace-popup')
  await expect(popup).toBeVisible()
  await popup
    .getByRole('textbox', { name: 'New branch name', exact: true })
    .fill('stage8-child-result')
  await popup.getByRole('button', { name: 'Create and checkout', exact: true }).click()
  await expect(popup.getByTestId('git-branch-notice')).toContainText('stage8-child-result', {
    timeout: 30_000
  })
  expect(await fixture.git(fixture.one, ['symbolic-ref', 'HEAD'])).toBe(
    'refs/heads/stage8-child-result'
  )
  expect(await fixture.git(fixture.root, ['ls-files', '--unmerged'])).toBe(parentUnmerged)
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).click()
  const changes = page.getByTestId('git-context-changes')
  await expect(changes).toContainText('Changes · one')
  await changes.locator('[data-testid="stage-entry"][data-path="result.txt"]').click()
  const staged = changes.getByRole('region', { name: 'Staged', exact: true })
  await expect(staged.getByTestId('source-control-entry')).toHaveCount(1, { timeout: 30_000 })
  await expect(staged).toContainText('result.txt')
  const commit = changes.getByTestId('git-context-commit')
  await commit.getByTestId('git-context-commit-message').fill('child result created in Orca')
  await commit.getByRole('button', { name: 'Preview staged set', exact: true }).click()
  const preview = changes.getByTestId('git-commit-preview')
  await expect(preview).toContainText('result.txt')
  await expect(preview).not.toContainText('file.txt')
  await commit.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(staged.getByTestId('source-control-entry')).toHaveCount(0, { timeout: 30_000 })
  const resultingOid = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
  expect(resultingOid).not.toBe(right)
  expect(await fixture.git(fixture.one, ['show', '--format=', '--name-only', 'HEAD'])).toBe(
    'result.txt'
  )
  expect(await fixture.git(fixture.one, ['show', 'HEAD:result.txt'])).toBe(
    'result committed through the app'
  )
  expect(await readFile(path.join(fixture.one, 'file.txt'), 'utf8')).toBe(
    'keep this uncommitted child work\n'
  )
  expect(await fixture.git(fixture.one, ['rev-parse', ':file.txt'])).toBe(dirtyIndexOid)
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD'])).toBe(parentHead)
  expect(await fixture.git(fixture.root, ['ls-files', '--unmerged'])).toBe(parentUnmerged)
  await gitlink.getByRole('button', { name: 'Refresh child state', exact: true }).click()
  await expect(gitlink).toContainText(resultingOid)
  await gitlink.getByRole('button', { name: 'Use inspected child HEAD', exact: true }).click()
  await expect(
    gitlink.getByRole('textbox', { name: 'Resulting child commit OID', exact: true })
  ).toHaveValue(resultingOid)
  await gitlink
    .getByRole('button', { name: 'Record child commit and mark resolved', exact: true })
    .click()
  await expect(resolver.getByTestId('git-conflict-notice')).toContainText('real Git index')
  expect(await fixture.git(fixture.root, ['ls-files', '--stage', '--', 'one'])).toBe(
    `160000 ${resultingOid} 0\tone`
  )
  expect(await fixture.git(fixture.root, ['ls-files', '--unmerged'])).toBe('')
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(resultingOid)
  expect(await fixture.git(fixture.one, ['rev-parse', ':file.txt'])).toBe(dirtyIndexOid)
  expect(await readFile(path.join(fixture.one, 'file.txt'), 'utf8')).toBe(
    'keep this uncommitted child work\n'
  )
  await openContextChanges(page, 'root')
  await page
    .getByTestId('git-conflict-operation')
    .getByRole('button', { name: 'Continue merge', exact: true })
    .click()
  await expect
    .poll(() => fixture.git(fixture.root, ['rev-parse', 'HEAD:one']), { timeout: 30_000 })
    .toBe(resultingOid)
  await expect(page.getByTestId('git-conflict-operation')).toHaveCount(0, { timeout: 30_000 })
  expect(await fixture.git(fixture.two, ['rev-parse', 'HEAD'])).toBe(siblingHead)
  expect(await readFile(path.join(fixture.one, 'file.txt'), 'utf8')).toBe(
    'keep this uncommitted child work\n'
  )
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

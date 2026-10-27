import { execFileSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openGoldenSourceControl } from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'
import {
  createGitWorkspaceFixture,
  type GitWorkspaceFixture
} from '../../src/main/git/source-control/git-workspace-test-fixture'

/** Unmodified stdout: porcelain status distinguishes the index and worktree columns. */
function rawGit(fixture: GitWorkspaceFixture, cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: fixture.env, encoding: 'utf8' })
}

test('root and child stage, commit, discard and gitlink writes hit the real repositories', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = await createGitWorkspaceFixture()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))

  // Root fixture: a two-block modification, a plain stage/unstage file and an untouched dirty file.
  await writeFile(path.join(fixture.root, 'partial.txt'), 'alpha\nbeta\ngamma\n')
  await fixture.git(fixture.root, ['add', 'partial.txt'])
  await fixture.git(fixture.root, ['commit', '-qm', 'partial base'])
  await writeFile(path.join(fixture.root, 'stage-only.txt'), 'stage only base\n')
  await writeFile(path.join(fixture.root, 'unstage-me.txt'), 'unstage base\n')
  await fixture.git(fixture.root, ['add', 'stage-only.txt', 'unstage-me.txt'])
  await fixture.git(fixture.root, ['commit', '-qm', 'stage base'])
  await writeFile(path.join(fixture.root, 'partial.txt'), 'ALPHA\nbeta\nGAMMA\n')
  await writeFile(path.join(fixture.root, 'stage-only.txt'), 'stage only changed\n')
  await writeFile(path.join(fixture.root, 'unstage-me.txt'), 'unstage changed\n')

  // Child fixture: a new child commit (so the parent gitlink is stale) plus its own changes.
  await writeFile(path.join(fixture.one, 'file.txt'), 'child baseline two\n')
  await fixture.git(fixture.one, ['add', 'file.txt'])
  await fixture.git(fixture.one, ['commit', '-qm', 'child moves'])
  await writeFile(path.join(fixture.one, 'child-partial.txt'), 'a\nb\nc\n')
  await fixture.git(fixture.one, ['add', 'child-partial.txt'])
  await fixture.git(fixture.one, ['commit', '-qm', 'child partial base'])
  await writeFile(path.join(fixture.one, 'child-only.txt'), 'child only base\n')
  await fixture.git(fixture.one, ['add', 'child-only.txt'])
  await fixture.git(fixture.one, ['commit', '-qm', 'child only base'])
  const childHead = await fixture.git(fixture.one, ['rev-parse', 'HEAD'])
  const childGitlinkInParent = await fixture.git(fixture.root, ['rev-parse', 'HEAD:one'])
  await writeFile(path.join(fixture.one, 'child-partial.txt'), 'A\nb\nc\n')
  await writeFile(path.join(fixture.one, 'child-only.txt'), 'child only changed\n')
  const childStatusBefore = rawGit(fixture, fixture.one, ['status', '--porcelain=v1'])
  const secondHeadBefore = await fixture.git(fixture.second, ['rev-parse', 'HEAD'])
  const childIndexBeforeGitlinkStage = await fixture.git(fixture.one, ['ls-files', '--stage'])

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

  // 1. Root: stage one added line of a two-block modification from the issued diff.
  await unstaged.getByTestId('source-control-entry').filter({ hasText: 'partial.txt' }).click()
  const document = page.getByTestId('git-diff-document')
  await expect(document).toContainText('INDEX · partial.txt', { timeout: 30_000 })
  await page.getByTestId('git-partial-staging').locator('summary').click()
  await page.getByTestId('git-partial-staging').getByRole('checkbox', { name: 'add ALPHA' }).check()
  await page.getByRole('button', { name: 'Stage 1 line(s)', exact: true }).click()
  await expect(staged.getByTestId('source-control-entry').filter({ hasText: 'partial.txt' })).toBeVisible()
  expect(await fixture.git(fixture.root, ['show', ':partial.txt'])).toBe('ALPHA\nbeta\ngamma')
  expect(await fixture.git(fixture.root, ['show', 'HEAD:partial.txt'])).toBe('alpha\nbeta\ngamma')
  await expect(changes).toContainText('partial.txt')

  // 2. Root: whole-file stage, then unstage the same file again through the host contract.
  await page.locator('[data-testid="stage-entry"][data-path="stage-only.txt"]').click()
  await expect
    .poll(async () => fixture.git(fixture.root, ['show', ':stage-only.txt']))
    .toBe('stage only changed')
  await expect(
    staged.getByTestId('source-control-entry').filter({ hasText: 'stage-only.txt' })
  ).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-testid="stage-entry"][data-path="unstage-me.txt"]').click()
  await expect(
    staged.getByTestId('source-control-entry').filter({ hasText: 'unstage-me.txt' })
  ).toBeVisible()
  await page.locator('[data-testid="unstage-entry"][data-path="unstage-me.txt"]').click()
  await expect(
    unstaged.getByTestId('source-control-entry').filter({ hasText: 'unstage-me.txt' })
  ).toBeVisible()
  expect(await fixture.git(fixture.root, ['show', ':unstage-me.txt'])).toBe('unstage base')

  // 3. Root: commit exactly the real index.
  await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('root selected changes')
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(staged.getByTestId('source-control-entry')).toHaveCount(0, { timeout: 30_000 })
  const rootCommit = await fixture.git(fixture.root, ['show', '--format=', '--name-only', 'HEAD'])
  expect(rootCommit.split('\n').sort()).toEqual(['partial.txt', 'stage-only.txt'])
  expect(await fixture.git(fixture.root, ['show', 'HEAD:partial.txt'])).toBe('ALPHA\nbeta\ngamma')
  expect(await fixture.git(fixture.root, ['show', 'HEAD:stage-only.txt'])).toBe('stage only changed')
  expect(await fixture.git(fixture.root, ['show', ':partial.txt'])).toBe('ALPHA\nbeta\ngamma')
  const rootAfterCommit = rawGit(fixture, fixture.root, ['status', '--porcelain=v1'])
  expect(rootAfterCommit).toContain(' M partial.txt')
  expect(rootAfterCommit).toContain(' M unstage-me.txt')

  // 4. Root: explicit gitlink stage records the child commit without touching the child.
  await page.locator('[data-testid="stage-gitlink"][data-path="one"]').click()
  await expect(
    changes
      .getByRole('region', { name: 'Staged', exact: true })
      .getByTestId('source-control-entry')
      .filter({ hasText: 'one' })
  ).toBeVisible()
  const parentIndexGitlink = (await fixture.git(fixture.root, ['ls-files', '--stage', '--', 'one'])).split(' ')[1]
  expect(parentIndexGitlink).toBe(childHead)
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD:one'])).toBe(childGitlinkInParent)
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(childHead)
  expect(await fixture.git(fixture.one, ['ls-files', '--stage'])).toBe(childIndexBeforeGitlinkStage)
  expect(rawGit(fixture, fixture.one, ['status', '--porcelain=v1'])).toBe(childStatusBefore)

  await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('record child commit')
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(staged.getByTestId('source-control-entry')).toHaveCount(0, { timeout: 30_000 })
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD:one'])).toBe(childHead)
  expect(await fixture.git(fixture.one, ['rev-parse', 'HEAD'])).toBe(childHead)

  // 5. Child: partial stage, whole-file stage and commit through the context panel.
  await page.getByRole('button', { name: 'Submodules', exact: true }).click()
  await page.getByTestId('git-workspace-catalog').getByRole('button', { name: 'one', exact: true }).click()
  await expect(changes).toContainText('Changes · one', { timeout: 30_000 })
  const childUnstaged = changes.getByRole('region', { name: 'Unstaged', exact: true })
  const childCommit = page.getByTestId('git-context-commit')
  await expect(childCommit).toBeVisible()
  await childUnstaged.getByTestId('source-control-entry').filter({ hasText: 'child-partial.txt' }).click()
  await expect(document).toContainText('INDEX · child-partial.txt', { timeout: 30_000 })
  await page.getByTestId('git-partial-staging').locator('summary').click()
  await page.getByTestId('git-partial-staging').getByRole('checkbox', { name: 'add A' }).check()
  await page.getByRole('button', { name: 'Stage 1 line(s)', exact: true }).click()
  await expect(
    changes
      .getByRole('region', { name: 'Staged', exact: true })
      .getByTestId('source-control-entry')
      .filter({ hasText: 'child-partial.txt' })
  ).toBeVisible()
  expect(await fixture.git(fixture.one, ['show', ':child-partial.txt'])).toBe('A\nb\nc')
  await page.locator('[data-testid="stage-entry"][data-path="child-only.txt"]').click()
  await expect(
    changes
      .getByRole('region', { name: 'Staged', exact: true })
      .getByTestId('source-control-entry')
      .filter({ hasText: 'child-only.txt' })
  ).toBeVisible()

  await page.getByTestId('git-context-commit-message').fill('child workspace commit')
  await childCommit.getByRole('button', { name: 'Preview staged set', exact: true }).click()
  await expect(page.getByTestId('git-commit-preview')).toContainText('Branch main')
  await expect(page.getByTestId('git-commit-preview')).toContainText('child-only.txt')
  await childCommit.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(
    changes.getByRole('region', { name: 'Staged', exact: true }).getByTestId('source-control-entry')
  ).toHaveCount(0, { timeout: 30_000 })
  const childAfterCommit = await fixture.git(fixture.one, ['show', '--format=', '--name-only', 'HEAD'])
  expect(childAfterCommit.split('\n').sort()).toEqual(['child-only.txt', 'child-partial.txt'])
  expect(await fixture.git(fixture.one, ['show', 'HEAD:child-partial.txt'])).toBe('A\nb\nc')
  // The child commit must not move the parent index or HEAD.
  expect((await fixture.git(fixture.root, ['ls-files', '--stage', '--', 'one'])).split(' ')[1]).toBe(
    childHead
  )
  expect(await fixture.git(fixture.root, ['rev-parse', 'HEAD:one'])).toBe(childHead)

  // 6. Child: discard preview, confirmation and the recovery copy.
  await writeFile(path.join(fixture.one, 'file.txt'), 'discard me\n')
  await expect(
    changes.getByRole('region', { name: 'Unstaged', exact: true }).getByTestId('source-control-entry').filter({ hasText: 'file.txt' })
  ).toBeVisible({ timeout: 12_000 })
  await page.locator('[data-testid="discard-entry"][data-path="file.txt"]').click()
  const preview = page.getByTestId('git-discard-preview')
  await expect(preview).toContainText('Discard file.txt?')
  await expect(preview).toContainText('Recovery copy: available')
  await preview.getByRole('button', { name: 'Confirm discard', exact: true }).click()
  await expect(page.getByTestId('git-discard-recovery')).toBeVisible({ timeout: 30_000 })
  expect(await fixture.git(fixture.one, ['show', 'HEAD:file.txt'])).toBe('child baseline two')
  expect(rawGit(fixture, fixture.one, ['status', '--porcelain=v1', '--', 'file.txt'])).toBe('')
  await page.getByRole('button', { name: 'Restore copy', exact: true }).click()
  await expect(page.getByTestId('git-discard-recovery')).toHaveCount(0, { timeout: 30_000 })
  expect(rawGit(fixture, fixture.one, ['status', '--porcelain=v1', '--', 'file.txt'])).toBe(
    ' M file.txt\n'
  )

  expect(await fixture.git(fixture.second, ['rev-parse', 'HEAD'])).toBe(secondHeadBefore)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

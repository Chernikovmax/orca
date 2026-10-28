import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { activateGoldenWorktree } from './golden-source-control'
import { waitForSessionReady } from './store'
import {
  createGitWorkspaceFixture,
  type GitWorkspaceFixture
} from '../../../src/main/git/source-control/git-workspace-test-fixture'

export type ConflictContext = 'root' | 'one' | 'nested'
export const CONFLICT_FILE = 'conflict.txt'
const middle = Array.from({ length: 12 }, (_, index) => `unchanged ${index}\n`).join('')
export const conflictText = (top: string, bottom = top) =>
  `start\n${top}\n${middle}${bottom}\nend\n`

export async function createConflictWorkspace() {
  const fixture = await createGitWorkspaceFixture()
  for (const cwd of [fixture.root, fixture.one, fixture.nested]) {
    await fixture.git(cwd, ['config', 'user.name', 'Stage Eight E2E'])
    await fixture.git(cwd, ['config', 'user.email', 'stage8@example.invalid'])
    await fixture.git(cwd, ['config', 'commit.gpgsign', 'false'])
    await fixture.git(cwd, ['config', 'core.autocrlf', 'false'])
    await fixture.git(cwd, ['config', 'core.hooksPath', path.join(fixture.home, 'hooks')])
  }
  return fixture
}

export async function prepareTextConflict(
  fixture: GitWorkspaceFixture,
  cwd: string,
  label: string
) {
  const original = await fixture.git(cwd, ['rev-parse', 'HEAD'])
  await fixture.git(cwd, ['checkout', '-B', `stage8-${label}-current`, original])
  await writeFile(path.join(cwd, CONFLICT_FILE), conflictText(`${label} base`))
  await fixture.git(cwd, ['add', CONFLICT_FILE])
  await fixture.git(cwd, ['commit', '-qm', `${label} common ancestor`])
  const incoming = `stage8-${label}-incoming`
  await fixture.git(cwd, ['checkout', '-b', incoming])
  await writeFile(path.join(cwd, CONFLICT_FILE), conflictText(`${label} incoming`))
  await fixture.git(cwd, ['commit', '-qam', `${label} incoming`])
  await fixture.git(cwd, ['checkout', `stage8-${label}-current`])
  await writeFile(path.join(cwd, CONFLICT_FILE), conflictText(`${label} current`))
  await fixture.git(cwd, ['commit', '-qam', `${label} current`])
  return incoming
}

export async function openConflictProject(page: Page, fixture: GitWorkspaceFixture) {
  await waitForSessionReady(page)
  await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
  }, fixture.root)
  await activateGoldenWorktree(page, fixture.root, fixture.root)
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await expect(page.getByTestId('git-context-changes')).toBeVisible({ timeout: 30_000 })
}

export async function selectConflictContext(page: Page, which: ConflictContext) {
  await page.keyboard.press('Control+Alt+KeyG')
  const popup = page.getByTestId('git-workspace-popup')
  await expect(popup).toBeVisible()
  const selectedPath = which === 'root' ? '.' : which === 'one' ? 'one' : 'one/same'
  await popup
    .getByRole('textbox', { name: 'Search repositories' })
    .fill(which === 'root' ? 'Root' : selectedPath)
  const rows = popup
    .getByRole('group', { name: 'Repository results' })
    .locator('[data-context-key]')
  await rows.filter({ has: page.getByText(selectedPath, { exact: true }) }).click()
  await expect(popup.getByRole('textbox', { name: 'Search refs' })).toBeEnabled({ timeout: 30_000 })
  return popup
}

export async function openContextChanges(page: Page, which: ConflictContext) {
  const popup = await selectConflictContext(page, which)
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).click()
  const changes = page.getByTestId('git-context-changes')
  await expect(changes).toContainText(
    `Changes · ${which === 'root' ? 'Root' : which === 'one' ? 'one' : 'one/same'}`
  )
  return changes
}

export async function beginConflictIntegration(
  page: Page,
  which: ConflictContext,
  incoming: string,
  operation: 'merge' | 'rebase'
) {
  const popup = await selectConflictContext(page, which)
  const search = popup.getByRole('textbox', { name: 'Search refs' })
  await search.fill(incoming)
  await expect(popup.getByRole('region', { name: 'Local', exact: true })).toContainText(incoming)
  await search.press('Enter')
  await expect(popup.getByRole('region', { name: 'Ref details' })).toContainText(
    `refs/heads/${incoming}`
  )
  await popup
    .getByRole('button', {
      name: operation === 'merge' ? 'Merge into current' : 'Rebase current onto this',
      exact: true
    })
    .click()
  await expect(popup.getByTestId('git-unfinished-operation')).toBeVisible({ timeout: 30_000 })
  await popup.getByRole('button', { name: 'Open Changes', exact: true }).click()
}

export async function openConflictResolver(page: Page, filePath = CONFLICT_FILE) {
  const changes = page.getByTestId('git-context-changes')
  await changes
    .getByRole('region', { name: 'Conflicts', exact: true })
    .getByTestId('source-control-entry')
    .filter({ hasText: filePath })
    .click()
  const resolver = page.getByTestId('git-conflict-resolver')
  await expect(resolver.getByTestId('git-conflict-ours')).toBeVisible({ timeout: 30_000 })
  await expect(resolver).toHaveAttribute('aria-busy', 'false')
  return resolver
}

export async function typeConflictResult(page: Page, content: string) {
  const result = page.getByTestId('git-conflict-result')
  const editor = result.locator('.monaco-editor')
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.keyboard.insertText(content)
  await expect(
    page
      .getByTestId('git-conflict-resolver')
      .getByRole('button', { name: 'Save result', exact: true })
  ).toBeEnabled()
}

export async function prepareGitlinkConflict(fixture: GitWorkspaceFixture) {
  const { root, one: child } = fixture
  const base = await fixture.git(child, ['rev-parse', 'HEAD'])
  await fixture.git(child, ['checkout', '-b', 'stage8-left', base])
  await writeFile(path.join(child, 'left.txt'), 'left child\n')
  await fixture.git(child, ['add', 'left.txt'])
  await fixture.git(child, ['commit', '-qm', 'left child'])
  const left = await fixture.git(child, ['rev-parse', 'HEAD'])
  await fixture.git(child, ['checkout', '-b', 'stage8-right', base])
  await writeFile(path.join(child, 'right.txt'), 'right child\n')
  await fixture.git(child, ['add', 'right.txt'])
  await fixture.git(child, ['commit', '-qm', 'right child'])
  const right = await fixture.git(child, ['rev-parse', 'HEAD'])
  await fixture.git(child, ['checkout', '--detach', right])
  await fixture.git(root, ['checkout', '-b', 'stage8-gitlink-incoming'])
  await fixture.git(root, ['update-index', '--cacheinfo', `160000,${right},one`])
  await fixture.git(root, ['commit', '-qm', 'right parent link'])
  await fixture.git(root, ['checkout', 'main'])
  await fixture.git(root, ['update-index', '--cacheinfo', `160000,${left},one`])
  await fixture.git(root, ['commit', '-qm', 'left parent link'])
  await fixture.git(root, ['merge', 'stage8-gitlink-incoming'], 1)
  await writeFile(path.join(child, 'file.txt'), 'keep this uncommitted child work\n')
  await writeFile(path.join(child, 'result.txt'), 'result committed through the app\n')
  return { left, right }
}

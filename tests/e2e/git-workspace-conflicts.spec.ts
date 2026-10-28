import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  beginConflictIntegration,
  conflictText,
  CONFLICT_FILE,
  createConflictWorkspace,
  openConflictProject,
  openConflictResolver,
  openContextChanges,
  prepareTextConflict,
  typeConflictResult
} from './helpers/git-conflict-workspace'

test.describe.configure({ mode: 'serial' })

for (const scenario of [
  { which: 'root', operation: 'merge', label: 'root' },
  { which: 'nested', operation: 'rebase', label: 'nested' }
] as const) {
  test(`${scenario.which} ${scenario.operation} resolves blocks, saves without staging and continues through the UI`, async ({
    orcaPage: page,
    electronApp,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(180_000)
    const fixture = await createConflictWorkspace()
    registerPostElectronShutdownCleanup(() =>
      rm(fixture.directory, { recursive: true, force: true })
    )
    const cwd = scenario.which === 'root' ? fixture.root : fixture.nested
    const incoming = await prepareTextConflict(fixture, cwd, scenario.label)
    const siblingBefore = await fixture.git(fixture.two, ['rev-parse', 'HEAD'])
    const parentIndexBefore = await fixture.git(fixture.one, ['ls-files', '--stage'])
    await openConflictProject(page, fixture)
    await beginConflictIntegration(page, scenario.which, incoming, scenario.operation)
    const unmergedBefore = await fixture.git(cwd, ['ls-files', '--unmerged'])
    expect(unmergedBefore).toContain(`\t${CONFLICT_FILE}`)
    const resolver = await openConflictResolver(page)
    await expect(resolver.getByTestId('git-conflict-base')).toContainText('common ancestor')
    await expect(resolver).toContainText('Conflict 1 of 2')
    if (scenario.operation === 'rebase') {
      await expect(resolver.getByTestId('git-conflict-ours')).toContainText(
        'upstream plus already replayed'
      )
      await expect(resolver.getByTestId('git-conflict-theirs')).toContainText(
        'your commit currently being replayed'
      )
    }
    await resolver.getByRole('button', { name: 'Next conflict', exact: true }).click()
    await expect(resolver).toContainText('Conflict 2 of 2')
    await resolver.getByRole('button', { name: 'Previous conflict', exact: true }).click()
    await expect(resolver).toContainText('Conflict 1 of 2')
    await resolver
      .getByRole('button', {
        name: scenario.operation === 'merge' ? 'Use both for block' : 'Use ours for block',
        exact: true
      })
      .click()
    await resolver
      .getByRole('button', {
        name: scenario.operation === 'merge' ? 'Use theirs for block' : 'Use both for block',
        exact: true
      })
      .click()
    await expect(resolver).toContainText('No conflict marker blocks')
    await expect(
      resolver.getByRole('button', { name: 'Mark Resolved', exact: true })
    ).toBeDisabled()
    const expected =
      scenario.operation === 'merge'
        ? conflictText('root current\nroot incoming', 'root incoming')
        : conflictText('nested incoming', 'nested incoming\nnested current')
    await resolver.getByRole('button', { name: 'Save result', exact: true }).click()
    await expect(resolver.getByTestId('git-conflict-notice')).toContainText('worktree only')
    expect(await readFile(path.join(cwd, CONFLICT_FILE), 'utf8')).toBe(expected)
    expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe(unmergedBefore)
    await resolver.getByRole('button', { name: 'Mark Resolved', exact: true }).click()
    await expect(resolver.getByTestId('git-conflict-notice')).toContainText('real Git index')
    expect(await fixture.git(cwd, ['ls-files', '--unmerged'])).toBe('')
    expect(await fixture.git(cwd, ['show', `:${CONFLICT_FILE}`])).toBe(expected.trimEnd())
    const operation = page.getByTestId('git-conflict-operation')
    await expect(
      operation.getByRole('button', { name: `Continue ${scenario.operation}`, exact: true })
    ).toBeEnabled()
    await operation
      .getByRole('button', { name: `Continue ${scenario.operation}`, exact: true })
      .click()
    await expect
      .poll(() => fixture.git(cwd, ['show', `HEAD:${CONFLICT_FILE}`]), { timeout: 30_000 })
      .toBe(expected.trimEnd())
    await expect(page.getByTestId('git-conflict-operation')).toHaveCount(0, { timeout: 30_000 })
    expect(await fixture.git(fixture.two, ['rev-parse', 'HEAD'])).toBe(siblingBefore)
    if (scenario.which === 'nested') {
      expect(await fixture.git(fixture.one, ['ls-files', '--stage'])).toBe(parentIndexBefore)
    }
    if (scenario.which === 'root') {
      await resolver.getByRole('button', { name: 'Close resolver', exact: true }).click()
      const secondIncoming = await prepareTextConflict(fixture, cwd, 'root-second')
      const secondOurs = await fixture.git(cwd, ['rev-parse', `HEAD:${CONFLICT_FILE}`])
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await beginConflictIntegration(page, 'root', secondIncoming, 'merge')
      const reopened = await openConflictResolver(page)
      await expect(reopened.getByTestId('git-conflict-ours')).toContainText(secondOurs)
      await reopened.getByRole('button', { name: 'Mark resolved using ours', exact: true }).click()
      await expect(reopened.getByTestId('git-conflict-notice')).toContainText('real Git index')
      await operation.getByRole('button', { name: 'Continue merge', exact: true }).click()
      await expect
        .poll(() => fixture.git(cwd, ['show', `HEAD:${CONFLICT_FILE}`]), { timeout: 30_000 })
        .toBe(conflictText('root-second current').trimEnd())
    }
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible())
      )
    ).toBe(false)
  })
}

test('external edits reject stale saves while same-path root and nested drafts survive navigation and explicit reload', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  test.setTimeout(180_000)
  const fixture = await createConflictWorkspace()
  registerPostElectronShutdownCleanup(() => rm(fixture.directory, { recursive: true, force: true }))
  const rootIncoming = await prepareTextConflict(fixture, fixture.root, 'root')
  await fixture.git(fixture.root, ['merge', rootIncoming], 1)
  const nestedIncoming = await prepareTextConflict(fixture, fixture.nested, 'nested')
  await fixture.git(fixture.nested, ['merge', nestedIncoming], 1)
  const rootIndex = await fixture.git(fixture.root, ['ls-files', '--unmerged'])
  const nestedIndex = await fixture.git(fixture.nested, ['ls-files', '--unmerged'])
  await openConflictProject(page, fixture)
  let resolver = await openConflictResolver(page)
  await typeConflictResult(page, 'root draft retained across contexts\n')
  await openContextChanges(page, 'nested')
  resolver = await openConflictResolver(page)
  await expect(resolver.getByTestId('git-conflict-result')).not.toContainText('root draft retained')
  await typeConflictResult(page, 'nested draft stays nested\n')
  await openContextChanges(page, 'root')
  resolver = await openConflictResolver(page)
  await expect(resolver.getByTestId('git-conflict-result')).toContainText(
    'root draft retained across contexts'
  )
  await expect(resolver.getByTestId('git-conflict-result')).not.toContainText(
    'nested draft stays nested'
  )
  await writeFile(path.join(fixture.root, CONFLICT_FILE), 'external root edit must survive\n')
  await resolver.getByRole('button', { name: 'Save result', exact: true }).click()
  await expect(resolver.getByTestId('git-conflict-notice')).toContainText('draft is retained')
  await expect(resolver.getByRole('button', { name: 'Save result', exact: true })).toBeDisabled()
  await expect(resolver.getByTestId('git-conflict-result')).toContainText(
    'root draft retained across contexts'
  )
  expect(await readFile(path.join(fixture.root, CONFLICT_FILE), 'utf8')).toBe(
    'external root edit must survive\n'
  )
  expect(await fixture.git(fixture.root, ['ls-files', '--unmerged'])).toBe(rootIndex)
  expect(await fixture.git(fixture.nested, ['ls-files', '--unmerged'])).toBe(nestedIndex)
  await resolver.getByRole('button', { name: 'Reload conflict', exact: true }).click()
  await expect(resolver.getByTestId('git-conflict-result')).toContainText(
    'external root edit must survive'
  )
  const retained = resolver.getByTestId('git-conflict-retained-draft')
  await retained.locator('summary').click()
  await expect(retained).toContainText('root draft retained across contexts')
  await retained
    .getByRole('button', { name: 'Restore retained draft into result', exact: true })
    .click()
  await resolver.getByRole('button', { name: 'Save result', exact: true }).click()
  await expect(resolver.getByTestId('git-conflict-notice')).toContainText('worktree only')
  await resolver.getByRole('button', { name: 'Mark Resolved', exact: true }).click()
  await expect(resolver.getByTestId('git-conflict-notice')).toContainText('real Git index')
  expect(await fixture.git(fixture.root, ['show', `:${CONFLICT_FILE}`])).toBe(
    'root draft retained across contexts'
  )
  await openContextChanges(page, 'nested')
  resolver = await openConflictResolver(page)
  await expect(resolver.getByTestId('git-conflict-result')).toContainText(
    'nested draft stays nested'
  )
  expect(await readFile(path.join(fixture.nested, CONFLICT_FILE), 'utf8')).toContain('<<<<<<<')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})

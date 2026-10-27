import { createHash } from 'node:crypto'
import * as path from 'node:path'
import type { GitStatusResult } from '../../../shared/git-status-types'
import type {
  GitContextRef,
  GitWorkspaceSnapshot,
  SubmoduleEntry,
  RepositoryState
} from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import {
  authorizeWorkspaceChild,
  readWorkspaceContext,
  verifyWorkspaceContext
} from './git-workspace-context'
import {
  readWorkspaceMetadata,
  workspaceGitRead,
  WORKSPACE_CONCURRENCY,
  WORKSPACE_CONTEXT_LIMIT,
  WORKSPACE_DEPTH_LIMIT
} from './git-workspace-discovery'
import { GitWorkspaceReadError, workspaceReadError } from './git-workspace-error'

import { rememberGitWorkspaceWatchPaths } from './git-workspace-watch-paths'
import { attachWorkspaceRefs } from './git-workspace-refs'
import { propagateWorkspaceStatus } from './git-workspace-status-rollup'
import { attachGitlinkChanges } from './git-workspace-gitlink-changes'
type StatusReader = (cwd: string, options: GetStatusOptions) => Promise<GitStatusResult>
type PendingContext = {
  context: GitContextRef
  depth: number
  relativePath: string
  entry?: SubmoduleEntry
}

export async function getWorkspaceStatus(
  worktreePath: string,
  options: GetStatusOptions,
  readStatus: StatusReader
): Promise<GitStatusResult> {
  const workspace: GitWorkspaceSnapshot = {
    repositories: [],
    submodules: [],
    errors: [],
    incomplete: false,
    limits: {
      maxDepth: WORKSPACE_DEPTH_LIMIT,
      maxContexts: WORKSPACE_CONTEXT_LIMIT,
      concurrency: WORKSPACE_CONCURRENCY
    }
  }
  let rootStatus: GitStatusResult = { entries: [], conflictOperation: 'unknown' }
  let root: GitContextRef
  try {
    root = await readWorkspaceContext(worktreePath, options)
    workspace.rootContextId = root.id
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    workspace.errors.push({ path: '.', error: workspaceReadError(error) })
    workspace.incomplete = true
    return { ...rootStatus, workspace }
  }
  const queue: PendingContext[] = [{ context: root, depth: 0, relativePath: '' }]
  const seen = new Set<string>([root.checkoutPath])
  let scheduled = 1
  while (queue.length) {
    options.signal?.throwIfAborted()
    const batch = queue.splice(0, WORKSPACE_CONCURRENCY)
    await Promise.all(
      batch.map(async ({ context, depth, relativePath, entry }) => {
        try {
          const status = await readStatus(context.checkoutPath, {
            ...options,
            includeWorkspace: false,
            includeLineStats: false,
            branchLineTotalMergeBase: undefined,
            sharedLinkPaths: depth === 0 ? options.sharedLinkPaths : undefined
          })
          if (depth === 0) {
            rootStatus = status
          }
          const head =
            status.head && /^[0-9a-f]{40,64}$/.test(status.head) ? status.head : undefined
          const repository: RepositoryState = {
            context,
            head,
            branch: status.branch,
            unborn: !head,
            detached: !status.branch && !!head,
            entries: status.entries,
            conflictOperation: status.conflictOperation,
            operationInProgress: status.operationInProgress === true,
            dirty: status.entries.length > 0,
            conflicted: status.entries.some((change) => change.conflictStatus === 'unresolved'),
            incomplete: status.didHitLimit === true,
            ...(status.didHitLimit === true ? { statusTruncated: true } : {}),
            expectedState: createHash('sha256')
              .update(JSON.stringify([context.id, head, status.entries, status.conflictOperation]))
              .digest('hex')
          }
          workspace.repositories.push(repository)
          await attachWorkspaceRefs(repository, options)
          if (entry) {
            entry.currentOid = head
            entry.dirty = repository.dirty
            entry.conflicted ||= repository.conflicted
            entry.commitChanged = !!head && !!entry.indexOid && head !== entry.indexOid
          }
          const metadata = await readWorkspaceMetadata(context.checkoutPath, head, options)
          repository.expectedState = createHash('sha256')
            .update(
              JSON.stringify([
                context.id,
                head,
                metadata.indexRecords,
                status.entries,
                status.conflictOperation,
                status.operationInProgress === true
              ])
            )
            .digest('hex')
          const indexAfter = await workspaceGitRead(
            context.checkoutPath,
            ['ls-files', '--stage', '-z'],
            options
          )
          const headAfter = head
            ? (
                await workspaceGitRead(
                  context.checkoutPath,
                  ['rev-parse', '--verify', 'HEAD'],
                  options
                )
              ).trim()
            : undefined
          await verifyWorkspaceContext(context, options)
          if (indexAfter !== metadata.indexRecords || headAfter !== head) {
            metadata.issues.push(
              'HEAD/index changed during discovery; refresh this incomplete snapshot'
            )
          }
          if (metadata.issues.length) {
            repository.incomplete = true
            if (entry) {
              entry.descendants = 'unknown'
            }
            for (const message of metadata.issues) {
              workspace.errors.push({
                path: relativePath || '.',
                error: { category: 'invalid-metadata', message }
              })
            }
          }
          for (const module of metadata.modules) {
            if (workspace.submodules.length >= WORKSPACE_CONTEXT_LIMIT) {
              repository.incomplete = true
              workspace.errors.push({
                path: relativePath || '.',
                error: {
                  category: 'limit',
                  message: 'Submodule row limit reached; remaining metadata was not traversed.'
                }
              })
              break
            }
            const modulePath = relativePath ? `${relativePath}/${module.path}` : module.path
            const submodule: SubmoduleEntry = {
              path: modulePath,
              name: module.names[0] ?? module.path,
              parentContextId: context.id,
              declaredUrls: module.urls,
              effectiveUrl: module.effectiveUrl,
              headOid: module.headOid,
              indexOid: module.indexOid,
              indexConflictOids: module.conflicts,
              commitChanged: false,
              stagedGitlinkChanged: module.headOid !== module.indexOid,
              dirty: false,
              conflicted: module.conflicts.length > 0,
              availability: 'uninitialized',
              descendants: 'unknown',
              metadataIssues: module.issues
            }
            workspace.submodules.push(submodule)
            if (
              workspace.submodules.length >= WORKSPACE_CONTEXT_LIMIT ||
              scheduled >= WORKSPACE_CONTEXT_LIMIT ||
              depth >= WORKSPACE_DEPTH_LIMIT
            ) {
              submodule.descendants = 'limited'
              submodule.error = {
                category: 'limit',
                message:
                  'Discovery depth or context limit reached; refresh cannot discover beyond this safety bound.'
              }
              workspace.incomplete = true
              continue
            }
            scheduled += 1
            try {
              // Declarations describe metadata; only a parent gitlink authorizes checkout reads.
              if (!module.headOid && !module.indexOid && module.conflicts.length === 0) {
                throw new GitWorkspaceReadError(
                  'access-denied',
                  'No HEAD/index gitlink authorizes this checkout.'
                )
              }
              const checkout = await authorizeWorkspaceChild(context, module.path, root, options)
              if (seen.has(checkout)) {
                throw new GitWorkspaceReadError(
                  'access-denied',
                  'Duplicate or cyclic checkout identity was not traversed.'
                )
              }
              seen.add(checkout)
              const child = await readWorkspaceContext(checkout, options, root.checkoutPath)
              submodule.contextId = child.id
              submodule.availability = 'initialized'
              submodule.descendants = 'complete'
              for (const oid of new Set([module.headOid, module.indexOid, ...module.conflicts])) {
                if (!oid) {
                  continue
                }
                try {
                  await workspaceGitRead(checkout, ['cat-file', '-e', `${oid}^{commit}`], options)
                } catch (error) {
                  if (options.signal?.aborted) {
                    throw error
                  }
                  submodule.metadataIssues.push(
                    `Parent gitlink object ${oid} is not available locally; no fetch was attempted`
                  )
                }
              }
              queue.push({
                context: child,
                depth: depth + 1,
                relativePath: modulePath,
                entry: submodule
              })
            } catch (error) {
              if (options.signal?.aborted) {
                throw error
              }
              const detail = workspaceReadError(error)
              submodule.error = detail
              submodule.availability =
                detail.category === 'access-denied'
                  ? 'blocked'
                  : detail.category === 'unavailable'
                    ? 'uninitialized'
                    : 'unavailable'
              workspace.incomplete = true
            }
          }
          if (repository.incomplete) {
            workspace.incomplete = true
          }
        } catch (error) {
          if (options.signal?.aborted) {
            throw error
          }
          const detail = workspaceReadError(error)
          if (detail.category === 'unavailable' || detail.category === 'access-denied') {
            workspace.repositories = workspace.repositories.filter(
              (item) => item.context.id !== context.id
            )
          }
          workspace.errors.push({ path: relativePath || '.', error: detail })
          workspace.incomplete = true
          if (entry) {
            entry.error = detail
            entry.availability = detail.category === 'unavailable' ? 'uninitialized' : 'unavailable'
            entry.descendants = 'unknown'
          }
          const repository = workspace.repositories.find((item) => item.context.id === context.id)
          if (repository) {
            repository.incomplete = true
          }
        }
      })
    )
  }
  workspace.submodules.sort((a, b) => a.path.localeCompare(b.path))
  propagateWorkspaceStatus(workspace)
  attachGitlinkChanges(workspace)
  workspace.repositories.sort((a, b) =>
    path
      .relative(root.checkoutPath, a.context.checkoutPath)
      .localeCompare(path.relative(root.checkoutPath, b.context.checkoutPath))
  )
  rememberGitWorkspaceWatchPaths(workspace)
  return { ...rootStatus, workspace }
}

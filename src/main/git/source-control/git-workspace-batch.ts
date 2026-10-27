import { randomUUID } from 'node:crypto'
import type {
  GitWorkspaceBatchPreview,
  GitWorkspaceBatchRequest
} from '../../../shared/git-workspace-batch'
import type { GitContextRef } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { readAuthorizedWorkspace } from './git-workspace-mutation-shared'
import { resolveLocalCommit, validateWorkspaceRefName } from './git-workspace-branch-refs'
import { readRemoteNames } from './git-workspace-branch-guards'
import { workspaceGitRead } from './git-workspace-discovery'
import {
  BATCH_LIFETIME_MS,
  type BatchState,
  repositoryFor,
  sameStrings,
  stagedPathSet,
  states,
  trimStates
} from './git-workspace-batch-state'
import { buildWorkflow, computeSelection, validateRequest } from './git-workspace-batch-plan'
import {
  destinationCanBeVerified,
  freshSnapshot,
  remoteEndpoints,
  remoteFingerprint
} from './git-workspace-batch-runtime'

export async function previewGitWorkspaceBatch(
  root: string,
  request: GitWorkspaceBatchRequest,
  options: GetStatusOptions = {}
): Promise<GitWorkspaceBatchPreview> {
  validateRequest(request)
  const workspace = await freshSnapshot(root, options)
  const errors: string[] = []
  const selectedIds = computeSelection(workspace, request, errors)
  const selected = new Set(selectedIds)
  const initialStates = new Map<string, string>()
  const identities = new Map<string, GitContextRef>()
  const indexRecords = new Map<string, string>()
  const initialHeads = new Map<string, string>()
  const stagedSelections = new Map<string, string[]>()
  const currentRefs = new Map<string, string>()
  const publication = new Map((request.publication ?? []).map((item) => [item.contextId, item]))
  for (const id of selected) {
    const repo = repositoryFor(workspace, id)
    const selection = request.commits.find((item) => item.contextId === id)
    if (!repo) {
      continue
    }
    initialStates.set(id, repo.expectedState)
    identities.set(id, repo.context)
    indexRecords.set(
      id,
      await workspaceGitRead(repo.context.checkoutPath, ['ls-files', '--stage', '-z'], options)
    )
    initialHeads.set(id, repo.head ?? '')
    const paths = selection ? [...selection.stagedPaths].sort() : stagedPathSet(repo)
    stagedSelections.set(id, paths)
    if (!sameStrings(paths, stagedPathSet(repo))) {
      errors.push(`The staged paths for ${id} differ from the reviewed selection`)
    }
    if (repo.incomplete || repo.statusTruncated || repo.conflicted || repo.operationInProgress) {
      errors.push(
        `Context ${id} is incomplete, truncated, conflicted, or in an unfinished Git operation`
      )
    }
  }
  const fencedWorkspace = await freshSnapshot(root, options)
  if (fencedWorkspace.rootContextId !== request.rootContextId) {
    errors.push('Workspace identity changed while preparing the batch preview')
  }
  for (const id of selected) {
    const current = repositoryFor(fencedWorkspace, id)
    if (
      !current ||
      current.expectedState !== initialStates.get(id) ||
      current.context.checkoutPath !== identities.get(id)?.checkoutPath
    ) {
      errors.push(`Context ${id} changed while preparing the batch preview`)
    }
  }
  const remoteFingerprints = new Map<string, Map<string, string>>()
  for (const target of publication.values()) {
    const repo = repositoryFor(workspace, target.contextId)
    if (!repo) {
      continue
    }
    try {
      const resolved = await readAuthorizedWorkspace(
        root,
        { action: 'previewCommit', contextId: target.contextId },
        options
      )
      const remotes = await readRemoteNames(resolved, options)
      if (!remotes.includes(target.remote)) {
        errors.push(`Remote ${target.remote} is not configured in ${target.contextId}`)
        continue
      }
      const willBeVerified = workspace.submodules.some(
        (module) => module.contextId === target.contextId && publication.has(module.parentContextId)
      )
      if (willBeVerified) {
        const endpoints = await remoteEndpoints(
          resolved.context.checkoutPath,
          target.remote,
          options
        )
        if (!destinationCanBeVerified(endpoints)) {
          errors.push(
            `Publication destination for ${target.contextId} does not have one identical fetch/push endpoint`
          )
          continue
        }
      }
      const ref = validateWorkspaceRefName(target.refName)
      if (repo.branch !== ref) {
        errors.push(`Publication ref ${ref} is not the checked-out branch in ${target.contextId}`)
      }
      const oid = await resolveLocalCommit(resolved, ref, options)
      if (oid !== target.expectedRefOid) {
        errors.push(`Publication ref moved in ${target.contextId}; review its current OID`)
      }
      const fingerprint = await remoteFingerprint(
        resolved.context.checkoutPath,
        target.remote,
        options
      )
      const contextFingerprints =
        remoteFingerprints.get(target.contextId) ?? new Map<string, string>()
      contextFingerprints.set(target.remote, fingerprint)
      remoteFingerprints.set(target.contextId, contextFingerprints)
      currentRefs.set(target.contextId, oid)
    } catch {
      errors.push(`Cannot verify the configured publication destination for ${target.contextId}`)
    }
  }
  const { steps } = buildWorkflow(workspace, selectedIds, request, errors)
  if (errors.length > 0) {
    return { previewId: '', expiresAt: Date.now(), steps, workspace, incomplete: true, errors }
  }

  trimStates()
  const previewId = randomUUID()
  const expiresAt = Date.now() + BATCH_LIFETIME_MS
  const state: BatchState = {
    id: previewId,
    expiresAt,
    request: structuredClone(request),
    workspaceRoot: root,
    rootContextId: request.rootContextId,
    steps: steps.map((step) => ({ ...step, status: 'pending' })),
    selectedIds,
    identities,
    expectedStates: initialStates,
    indexRecords,
    initialHeads,
    currentRefs,
    stagedSelections,
    stagedLinks: new Map(selectedIds.map((id) => [id, new Set<string>()])),
    publication,
    remoteFingerprints,
    committedOids: new Map(),
    running: false
  }
  for (const id of selectedIds) {
    const repo = repositoryFor(workspace, id)
    if (repo?.head) {
      state.committedOids.set(id, repo.head)
    }
  }
  states.set(previewId, state)
  return {
    previewId,
    expiresAt,
    steps: state.steps.map((step) => ({ ...step })),
    workspace,
    incomplete: false,
    errors: []
  }
}

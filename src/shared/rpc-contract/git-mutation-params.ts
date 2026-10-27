import { z } from 'zod'
import { WorktreeSelector, FullGitObjectId } from './git-params'

const GitMutationAction = z.enum([
  'stage',
  'unstage',
  'discard',
  'commit',
  'stageGitlink',
  'previewCommit',
  'previewDiscard',
  'restoreDiscard',
  'listRecoveries',
  'checkout',
  'createBranch',
  'fetch',
  'push',
  'merge',
  'rebase',
  'continueOperation',
  'abortOperation',
  'previewSubmoduleInitialize',
  'submoduleInitialize',
  'previewSubmoduleCheckout',
  'submoduleCheckout',
  'previewSubmoduleSyncUrl',
  'submoduleSyncUrl',
  'previewSubmoduleAdd',
  'submoduleAdd',
  'previewSubmoduleRemove',
  'submoduleRemove',
  'previewBatch',
  'runBatch'
])
const GitWorkspaceBatchParam = z.object({
  rootContextId: z.string().min(1).max(256),
  contextIds: z.array(z.string().min(1).max(256)).max(128),
  recursive: z.boolean(),
  commits: z
    .array(
      z.object({
        contextId: z.string().min(1).max(256),
        message: z.string().max(100_000),
        stagedPaths: z.array(z.string().min(1).max(4096)).max(20_000)
      })
    )
    .max(128),
  publication: z
    .array(
      z.object({
        contextId: z.string().min(1).max(256),
        remote: z.string().min(1).max(200),
        refName: z.string().min(1).max(512),
        expectedRefOid: FullGitObjectId
      })
    )
    .max(128)
    .optional()
})

const GitWorkspaceBatchRunParam = z.object({
  previewId: z.string().min(1).max(64),
  retryFailed: z.boolean().optional(),
  inspectOnly: z.boolean().optional(),
  confirmations: z
    .array(
      z.object({
        parentContextId: z.string().min(1).max(256),
        filePath: z.string().min(1).max(4096),
        childContextId: z.string().min(1).max(256),
        childOid: FullGitObjectId,
        confirmed: z.literal(true)
      })
    )
    .max(128)
    .optional()
})
/**
 * One workspace mutation request. The host re-authorizes the context and checks
 * the issued state/content fences; ids are host-issued, never paths-as-authority.
 */
export const GitMutate = WorktreeSelector.extend({
  action: GitMutationAction,
  contextId: z.string().max(256).optional(),
  expectedState: z.string().max(256).optional(),
  filePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1).max(4096))
    .optional(),
  oldPath: z.string().min(1).max(4096).optional(),
  documentId: z.string().max(256).optional(),
  hunkIds: z.array(z.string().max(256)).max(20_000).optional(),
  lineIds: z.array(z.string().max(256)).max(20_000).optional(),
  childOid: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/)
    .optional(),
  message: z.string().max(100_000).optional(),
  previewId: z.string().max(64).optional(),
  recoveryId: z.string().max(64).optional(),
  refName: z.string().min(1).max(512).optional(),
  startRef: z.string().min(1).max(512).optional(),
  remote: z.string().min(1).max(200).optional(),
  branch: z.string().min(1).max(200).optional(),
  expectedRefOid: z
    .string()
    .regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/)
    .optional(),
  setUpstream: z.boolean().optional(),
  progressId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  expectedHead: z.string().max(128).optional(),
  url: z.string().min(1).max(4096).optional(),
  recursive: z.boolean().optional(),
  batch: GitWorkspaceBatchParam.optional(),
  batchRun: GitWorkspaceBatchRunParam.optional()
})

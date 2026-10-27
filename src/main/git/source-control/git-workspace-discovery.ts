import { lstat } from 'node:fs/promises'
import * as path from 'node:path'
import { GitWorkspaceReadError, workspaceReadError, redactUrl } from './git-workspace-error'
import { gitReadOptionsForWorktree, type GitRuntimeOptions } from '../git-runtime-options'
import { gitExecFileAsyncBuffer, gitOptionalLocksDisabledEnv } from '../runner'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'

export const WORKSPACE_OUTPUT_LIMIT = 8 * 1024 * 1024
export const WORKSPACE_CONTEXT_LIMIT = 128
export const WORKSPACE_DEPTH_LIMIT = 16
export const WORKSPACE_CONCURRENCY = 4

export async function workspaceGitRead(
  cwd: string,
  args: string[],
  options: GitRuntimeOptions,
  allowMissing = false
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsyncBuffer(args, {
      ...gitReadOptionsForWorktree(cwd, options),
      env: { ...gitOptionalLocksDisabledEnv(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
      maxBuffer: WORKSPACE_OUTPUT_LIMIT,
      timeout: 15_000
    })
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(stdout)
    } catch {
      throw new GitWorkspaceReadError(
        'invalid-metadata',
        'Non-UTF-8 Git metadata or paths are unsupported; identities were not decoded lossily.'
      )
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    if (allowMissing && error && typeof error === 'object' && 'code' in error && error.code === 1) {
      return ''
    }
    if (error instanceof Error && /maxBuffer|buffer.*exceed/i.test(error.message)) {
      throw new GitWorkspaceReadError(
        'limit',
        'Git metadata exceeds the bounded discovery output limit.'
      )
    }
    throw error
  }
}

type Declaration = { source: string; name: string; path: string; url?: string }
export type DiscoveredModule = {
  path: string
  names: string[]
  urls: string[]
  effectiveUrl?: string
  headOid?: string
  indexOid?: string
  conflicts: string[]
  issues: string[]
}
export type WorkspaceMetadata = {
  modules: DiscoveredModule[]
  issues: string[]
  indexRecords: string
}


function parseConfig(raw: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const row of raw.split('\0')) {
    if (!row) {
      continue
    }
    const separator = row.indexOf('\n')
    if (separator === -1) {
      throw new GitWorkspaceReadError(
        'invalid-metadata',
        'Malformed NUL-delimited submodule configuration.'
      )
    }
    const key = row.slice(0, separator)
    const values = result.get(key) ?? []
    values.push(row.slice(separator + 1))
    result.set(key, values)
  }
  return result
}

function declarations(raw: string, source: string): Declaration[] {
  const config = parseConfig(raw)
  const result: Declaration[] = []
  for (const [key, paths] of config) {
    if (!key.endsWith('.path')) {
      continue
    }
    const name = key.slice('submodule.'.length, -'.path'.length)
    const urls = config.get(`submodule.${name}.url`) ?? []
    for (const modulePath of paths) {
      for (const url of urls.length ? urls : [undefined]) {
        result.push({ source, name, path: modulePath, url })
      }
    }
  }
  return result
}

const CONFIG_PATTERN = '^submodule\\..*\\.(path|url|active)$'

export async function readWorkspaceMetadata(
  cwd: string,
  head: string | undefined,
  options: GitRuntimeOptions
): Promise<WorkspaceMetadata> {
  const issues: string[] = []
  const modules = new Map<string, DiscoveredModule>()
  const get = (modulePath: string): DiscoveredModule => {
    let module = modules.get(modulePath)
    if (!module) {
      if (modules.size >= WORKSPACE_CONTEXT_LIMIT) {
        throw new GitWorkspaceReadError(
          'limit',
          'Too many submodule metadata entries; discovery is incomplete.'
        )
      }
      module = { path: modulePath, names: [], urls: [], conflicts: [], issues: [] }
      modules.set(modulePath, module)
    }
    return module
  }
  const declarationsBySource: Declaration[] = []
  const indexRecords = await workspaceGitRead(cwd, ['ls-files', '--stage', '-z'], options)
  const tree = head ? await workspaceGitRead(cwd, ['ls-tree', '-r', '-z', head], options) : ''
  const blobs: { source: string; oid: string }[] = []
  for (const row of tree.split('\0')) {
    if (!row) {
      continue
    }
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(row)
    if (!match) {
      throw new GitWorkspaceReadError('invalid-metadata', 'Malformed Git tree metadata.')
    }
    const [, mode, , oid, modulePath] = match
    if (mode === '160000') {
      get(modulePath).headOid = oid
    }
    if (modulePath === '.gitmodules' && mode === '100644') {
      blobs.push({ source: 'HEAD', oid })
    } else if (modulePath === '.gitmodules') {
      issues.push('HEAD .gitmodules is not a regular metadata file')
    }
  }
  for (const row of indexRecords.split('\0')) {
    if (!row) {
      continue
    }
    const match = /^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]*)$/.exec(row)
    if (!match) {
      throw new GitWorkspaceReadError('invalid-metadata', 'Malformed Git index metadata.')
    }
    const [, mode, oid, stage, modulePath] = match
    if (mode === '160000') {
      const module = get(modulePath)
      if (stage === '0') {
        module.indexOid = oid
      } else {
        module.conflicts.push(oid)
      }
    }
    if (modulePath === '.gitmodules' && /^100(644|755)$/.test(mode)) {
      blobs.push({ source: `index:${stage}`, oid })
      if (stage !== '0') {
        issues.push('Unmerged .gitmodules in the index')
      }
    } else if (modulePath === '.gitmodules') {
      issues.push('Index .gitmodules is not a regular metadata file')
    }
  }
  for (const { source, oid } of blobs) {
    try {
      declarationsBySource.push(
        ...declarations(
          await workspaceGitRead(
            cwd,
            ['config', '--no-includes', '--null', '--blob', oid, '--get-regexp', CONFIG_PATTERN],
            options,
            true
          ),
          source
        )
      )
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
      issues.push(`${source} .gitmodules could not be read (${workspaceReadError(error).category})`)
    }
  }
  const worktreeModules = path.join(resolveWorktreeFilesystemPath(cwd, options), '.gitmodules')
  try {
    const metadataStat = await lstat(worktreeModules)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
      issues.push('Working .gitmodules is not a regular file; it was not followed')
    } else {
      declarationsBySource.push(
        ...declarations(
          await workspaceGitRead(
            cwd,
            [
              'config',
              '--no-includes',
              '--null',
              '--file',
              '.gitmodules',
              '--get-regexp',
              CONFIG_PATTERN
            ],
            options,
            true
          ),
          'worktree'
        )
      )
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      issues.push('Working .gitmodules could not be read')
    }
  }
  const localConfig = parseConfig(
    await workspaceGitRead(
      cwd,
      ['config', '--no-includes', '--local', '--null', '--get-regexp', CONFIG_PATTERN],
      options,
      true
    )
  )
  const names = new Map<string, Set<string>>()
  for (const declaration of declarationsBySource) {
    const module = get(declaration.path)
    if (!module.names.includes(declaration.name)) {
      module.names.push(declaration.name)
    }
    if (declaration.url && !module.urls.includes(redactUrl(declaration.url))) {
      module.urls.push(redactUrl(declaration.url))
    }
    const namePaths = names.get(declaration.name) ?? new Set<string>()
    namePaths.add(declaration.path)
    names.set(declaration.name, namePaths)
    const effective = localConfig.get(`submodule.${declaration.name}.url`)?.at(-1)
    if (effective !== undefined) {
      module.effectiveUrl = redactUrl(effective)
      if (declaration.url && effective !== declaration.url) {
        module.issues.push('Declared and local URL differ (relative URLs may resolve differently)')
      }
    }
  }
  // A config-only name has no trusted path; preserve it as an unavailable metadata row.
  for (const key of localConfig.keys()) {
    const name = key.slice('submodule.'.length, key.lastIndexOf('.'))
    if (![...modules.values()].some((module) => module.names.includes(name))) {
      const configPaths = localConfig.get(`submodule.${name}.path`)
      if (configPaths?.length) {
        for (const configPath of configPaths) {
          const module = get(configPath)
          module.names.push(name)
          module.issues.push('Local config path has no .gitmodules declaration')
        }
      } else {
        issues.push(`Local submodule configuration has no declared path: ${name}`)
      }
    }
  }
  for (const module of modules.values()) {
    const sourcePaths = declarationsBySource.filter((declaration) =>
      module.names.includes(declaration.name)
    )
    if (module.names.length > 1) {
      module.issues.push('Multiple submodule names declare this path')
    }
    if (module.names.some((name) => (names.get(name)?.size ?? 0) > 1)) {
      module.issues.push('Submodule name declares different paths across metadata sources')
    }
    if (!module.names.length) {
      module.issues.push('Gitlink has no .gitmodules declaration')
    }
    if (!module.headOid && !module.indexOid && !module.conflicts.length) {
      module.issues.push('Declaration has no HEAD/index gitlink')
    }
    if (
      module.names.length &&
      !sourcePaths.some(
        (declaration) => declaration.source === 'worktree' && declaration.path === module.path
      )
    ) {
      module.issues.push('No matching working .gitmodules declaration')
    }
    if (module.conflicts.length) {
      module.issues.push('Unmerged gitlink in parent index')
    }
    module.issues = [...new Set(module.issues)]
  }
  return { modules: [...modules.values()], issues: [...new Set(issues)], indexRecords }
}

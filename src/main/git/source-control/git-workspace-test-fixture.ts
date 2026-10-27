import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcess } from '@orca/process-host'
export type GitWorkspaceFixture = {
  directory: string
  home: string
  env: NodeJS.ProcessEnv & Record<'HOME' | 'USERPROFILE' | 'GIT_CONFIG_GLOBAL' | 'GIT_CONFIG_NOSYSTEM' | 'GIT_TERMINAL_PROMPT', string>
  git: (cwd: string, args: string[], expectedCode?: number) => Promise<string>
  root: string
  second: string
  one: string
  two: string
  nested: string
}

export async function createGitWorkspaceFixture(): Promise<GitWorkspaceFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'orca-git-workspace-'))
  const home = path.join(directory, 'home')
  await mkdir(home)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  const git = async (cwd: string, args: string[], expectedCode = 0) => {
    const result = await runProcess({
      program: 'git',
      args: [
        '-c',
        'user.name=Workspace Test',
        '-c',
        'user.email=workspace@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(home, 'hooks')}`,
        ...args
      ],
      cwd,
      env
    })
    if (result.code !== expectedCode) {
      throw new Error(`git ${args[0]} exited ${result.code}: ${result.stderr}`)
    }
    return result.stdout.trim()
  }
  const init = async (name: string) => {
    const repo = path.join(directory, name)
    await mkdir(repo)
    await git(repo, ['init', '-q'])
    await git(repo, ['checkout', '-b', 'main'])
    await writeFile(path.join(repo, 'file.txt'), `${name} initial\n`)
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-qm', 'initial'])
    return repo
  }
  const leaf = await init('leaf')
  const source = await init('source')
  await git(source, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--name',
    'same',
    leaf,
    'same'
  ])
  await git(source, ['commit', '-qam', 'nested'])
  const root = await init('root')
  await git(root, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--name',
    'same',
    source,
    'one'
  ])
  await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', leaf, 'two'])
  await git(root, ['commit', '-qam', 'modules'])
  await git(root, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--recursive'
  ])
  const second = path.join(directory, 'second')
  await git(root, ['worktree', 'add', '-b', 'second', second])
  return {
    directory,
    home,
    env,
    git,
    root,
    second,
    one: path.join(root, 'one'),
    two: path.join(root, 'two'),
    nested: path.join(root, 'one', 'same')
  }
}

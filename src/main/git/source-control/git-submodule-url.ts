import * as path from 'node:path'
import { GitMutationError } from './git-workspace-mutation-error'

export function resolveRelativeUrl(url: string, parentRemote?: string): string {
  if (!url.startsWith('../') && !url.startsWith('./')) {
    return url
  }
  if (!parentRemote) {
    throw new GitMutationError('invalid', 'Relative submodule URL has no configured parent remote')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(parentRemote)) {
    const base = new URL(parentRemote)
    const parts = base.pathname.split('/').filter(Boolean)
    for (const part of url.split('/')) {
      if (part === '..') {
        parts.pop()
      } else if (part !== '.') {
        parts.push(part)
      }
    }
    base.pathname = `/${parts.join('/')}`
    return base.toString()
  }
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(parentRemote)) {
    return path.win32.resolve(parentRemote, url)
  }
  if (parentRemote.includes(':') && !parentRemote.startsWith('/')) {
    const [host, ...parts] = parentRemote.split(':')
    const base = parts.join(':').split('/').filter(Boolean)
    for (const part of url.split('/')) {
      if (part === '..') {
        base.pop()
      } else if (part !== '.') {
        base.push(part)
      }
    }
    return `${host}:${base.join('/')}`
  }
  return path.posix.resolve(parentRemote, url)
}

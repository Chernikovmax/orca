import * as path from 'node:path'

/** Git paths use '/', even on Windows. Reject alternate platform spellings and escapes. */
export function validateDiffPath(filePath: string): string {
  if (
    !filePath ||
    filePath.includes('\0') ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    filePath
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new Error('Access denied: invalid Git diff path')
  }
  return filePath
}

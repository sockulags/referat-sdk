import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { ReferatLaunchError, ReferatNotInstalledError } from './errors.js'
import { findReferat, type FindReferatOptions } from './install.js'

export interface LaunchResult {
  executablePath: string
  /** True when Referat was already running, so no new instance was started. */
  alreadyRunning: boolean
  /** Process id of the started app; undefined when already running or not reported. */
  pid: number | undefined
}

/**
 * Whether a process with this executable's file name is running. Referat has
 * no single-instance lock, so a second start would open a second app working
 * on the same data. Any failure to check counts as "not running".
 */
function isRunning(executablePath: string): Promise<boolean> {
  const name = path.basename(executablePath)
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile(
        'tasklist',
        ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
        { timeout: 5000, windowsHide: true },
        (error, stdout) =>
          resolve(!error && stdout.toLowerCase().includes(`"${name.toLowerCase()}"`))
      )
    } else {
      execFile('pgrep', ['-x', name], { timeout: 5000 }, (error) => resolve(!error))
    }
  })
}

/**
 * Starts the installed Referat, detached from the calling process, and resolves
 * once it has spawned. Does nothing when Referat is already running.
 */
export async function launchReferat(options: FindReferatOptions = {}): Promise<LaunchResult> {
  const installation = await findReferat(options)
  const executablePath = installation.executablePath
  if (!executablePath) throw new ReferatNotInstalledError(installation.searchedPaths)
  if (await isRunning(executablePath)) {
    return { executablePath, alreadyRunning: true, pid: undefined }
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executablePath, [], { detached: true, stdio: 'ignore' })
    } catch (error) {
      reject(new ReferatLaunchError(executablePath, error))
      return
    }
    child.once('error', (error) => reject(new ReferatLaunchError(executablePath, error)))
    child.once('spawn', () => {
      child.unref()
      resolve({ executablePath, alreadyRunning: false, pid: child.pid })
    })
  })
}

// Locating an installed Referat and its data folder, read-only.
//
// Referat is an Electron app packaged by electron-builder with
// `productName: referat` and `executableName: referat`. Electron keeps its
// data in `app.getPath('userData')`, which is `<appData>/referat`, and Referat
// stores meetings in `<userData>/meetings/<id>/`. Referat also honours the
// REFERAT_USER_DATA environment variable as a userData override; so does this
// SDK.

import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { ReferatDataNotFoundError, ReferatNotInstalledError } from './errors.js'

/** Electron's app name for Referat, which is also its userData folder name. */
export const REFERAT_APP_NAME = 'referat'

/** Environment variable Referat itself reads to relocate its userData folder. */
export const REFERAT_USER_DATA_ENV = 'REFERAT_USER_DATA'

export interface FindReferatOptions {
  /**
   * Referat's data folder (Electron userData, the folder that holds `meetings/`).
   * When given, it is used as-is and Referat does not need to be installed for reading.
   */
  dataDir?: string
  /** Path to the Referat executable, overriding the platform's install locations. */
  executablePath?: string
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Defaults to `process.env`. Read for APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and REFERAT_USER_DATA. */
  env?: NodeJS.ProcessEnv
  /** Defaults to `os.homedir()`. */
  homeDir?: string
}

export interface ReferatInstallation {
  /** True when a Referat executable exists. */
  installed: boolean
  /** The Referat executable, or null when none was found. */
  executablePath: string | null
  /** Every executable location that was checked, in order. */
  searchedPaths: string[]
  /** Installed app version from its bundled package.json, or null when it cannot be read. */
  version: string | null
  /** Referat's data folder (Electron userData). */
  dataDir: string
  /** Where `dataDir` came from: the `dataDir` option, REFERAT_USER_DATA, or the platform default. */
  dataDirSource: 'option' | 'env' | 'default'
  /** True when `dataDir` exists. */
  dataDirExists: boolean
  /** `<dataDir>/meetings`, where each meeting has its own folder. */
  meetingsDir: string
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Electron's appData folder for the platform, before the app name is appended. */
function defaultAppDataDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string {
  const p = pathFor(platform)
  if (platform === 'win32') return env['APPDATA'] || p.join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support')
  return env['XDG_CONFIG_HOME'] || p.join(home, '.config')
}

/** Where electron-builder installs Referat on each platform, most likely first. */
function executableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string
): string[] {
  const p = pathFor(platform)
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] || p.join(home, 'AppData', 'Local')
    const candidates = [p.join(localAppData, 'Programs', REFERAT_APP_NAME, 'referat.exe')]
    // Per-machine NSIS installs go under Program Files.
    if (env['ProgramFiles'])
      candidates.push(p.join(env['ProgramFiles'], REFERAT_APP_NAME, 'referat.exe'))
    return candidates
  }
  if (platform === 'darwin') {
    const inBundle = (apps: string): string =>
      p.join(apps, `${REFERAT_APP_NAME}.app`, 'Contents', 'MacOS', 'referat')
    return [inBundle('/Applications'), inBundle(p.join(home, 'Applications'))]
  }
  // deb/rpm packages install under /opt/<productName> and link /usr/bin/<executableName>.
  // An AppImage can live anywhere; pass `executablePath` for that case.
  return [p.join('/opt', REFERAT_APP_NAME, 'referat'), '/usr/bin/referat']
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Reads `size` bytes at `position` from a file opened read-only. */
async function readBytes(file: string, position: number, size: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Reads package.json out of an Electron app.asar without extracting it.
 * Layout: uint32 4, uint32 header-pickle size, then the pickle: uint32 payload
 * size, uint32 JSON length, the JSON header. File data starts after the pickle.
 */
async function readAsarPackageVersion(asarPath: string): Promise<string | null> {
  const prefix = await readBytes(asarPath, 0, 16)
  if (prefix.length < 16) return null
  const headerPickleSize = prefix.readUInt32LE(4)
  const jsonLength = prefix.readUInt32LE(12)
  if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return null
  const header = JSON.parse((await readBytes(asarPath, 16, jsonLength)).toString('utf-8')) as {
    files?: Record<string, { offset?: string; size?: number; unpacked?: boolean }>
  }
  const entry = header.files?.['package.json']
  if (!entry || entry.unpacked || typeof entry.size !== 'number' || entry.offset === undefined) {
    return null
  }
  const data = await readBytes(asarPath, 8 + headerPickleSize + Number(entry.offset), entry.size)
  const pkg = JSON.parse(data.toString('utf-8')) as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : null
}

async function readInstalledVersion(
  executablePath: string,
  platform: NodeJS.Platform
): Promise<string | null> {
  const p = pathFor(platform)
  let exe = executablePath
  try {
    exe = await realpath(executablePath)
  } catch {
    // Keep the path as given.
  }
  const dir = p.dirname(exe)
  const asarCandidates = [
    p.join(dir, 'resources', 'app.asar'),
    p.join(dir, '..', 'Resources', 'app.asar')
  ]
  for (const asar of asarCandidates) {
    if (!(await isFile(asar))) continue
    try {
      return await readAsarPackageVersion(asar)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Finds the installed Referat and its data folder. Never throws for a missing
 * installation; check `installed` and `dataDirExists`.
 */
export async function findReferat(options: FindReferatOptions = {}): Promise<ReferatInstallation> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const p = pathFor(platform)

  const searchedPaths = options.executablePath
    ? [options.executablePath]
    : executableCandidates(platform, env, home)
  let executablePath: string | null = null
  for (const candidate of searchedPaths) {
    if (await isFile(candidate)) {
      executablePath = candidate
      break
    }
  }

  let dataDir: string
  let dataDirSource: ReferatInstallation['dataDirSource']
  if (options.dataDir) {
    dataDir = options.dataDir
    dataDirSource = 'option'
  } else if (env[REFERAT_USER_DATA_ENV]) {
    dataDir = env[REFERAT_USER_DATA_ENV]
    dataDirSource = 'env'
  } else {
    dataDir = p.join(defaultAppDataDir(platform, env, home), REFERAT_APP_NAME)
    dataDirSource = 'default'
  }

  return {
    installed: executablePath !== null,
    executablePath,
    searchedPaths,
    version: executablePath ? await readInstalledVersion(executablePath, platform) : null,
    dataDir,
    dataDirSource,
    dataDirExists: await isDirectory(dataDir),
    meetingsDir: p.join(dataDir, 'meetings')
  }
}

/**
 * The installation to read meetings from, or a typed error. Referat must be
 * installed unless the caller named the data folder explicitly (the `dataDir`
 * option or REFERAT_USER_DATA), and the data folder must exist.
 */
export async function requireReadableData(
  options: FindReferatOptions = {}
): Promise<ReferatInstallation> {
  const installation = await findReferat(options)
  if (installation.dataDirSource === 'default' && !installation.installed) {
    throw new ReferatNotInstalledError(installation.searchedPaths)
  }
  if (!installation.dataDirExists) throw new ReferatDataNotFoundError(installation.dataDir)
  return installation
}

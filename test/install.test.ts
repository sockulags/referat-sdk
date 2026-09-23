import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findReferat,
  getMeeting,
  launchReferat,
  listMeetings,
  ReferatDataNotFoundError,
  ReferatLaunchError,
  ReferatNotInstalledError
} from '../src/index.js'
import { makeTempDir, writeAsar } from './fixtures.js'

/** A fake install: an executable file with resources/app.asar next to it. */
function fakeInstall(root: string, version = '0.9.1'): string {
  const exe = path.join(root, 'app', process.platform === 'win32' ? 'referat.exe' : 'referat')
  mkdirSync(path.dirname(exe), { recursive: true })
  writeFileSync(exe, '')
  writeAsar(path.join(root, 'app', 'resources', 'app.asar'), { name: 'referat', version })
  return exe
}

describe('default locations', () => {
  it('uses Electron userData and the NSIS per-user install on Windows', async () => {
    const info = await findReferat({
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
      },
      homeDir: 'C:\\Users\\u'
    })
    expect(info.dataDir).toBe('C:\\Users\\u\\AppData\\Roaming\\referat')
    expect(info.meetingsDir).toBe('C:\\Users\\u\\AppData\\Roaming\\referat\\meetings')
    expect(info.dataDirSource).toBe('default')
    expect(info.searchedPaths[0]).toBe(
      'C:\\Users\\u\\AppData\\Local\\Programs\\referat\\referat.exe'
    )
  })

  it('uses Application Support and /Applications on macOS', async () => {
    const info = await findReferat({ platform: 'darwin', env: {}, homeDir: '/Users/u' })
    expect(info.dataDir).toBe('/Users/u/Library/Application Support/referat')
    expect(info.searchedPaths).toEqual([
      '/Applications/referat.app/Contents/MacOS/referat',
      '/Users/u/Applications/referat.app/Contents/MacOS/referat'
    ])
  })

  it('uses XDG_CONFIG_HOME or ~/.config on Linux', async () => {
    expect((await findReferat({ platform: 'linux', env: {}, homeDir: '/home/u' })).dataDir).toBe(
      '/home/u/.config/referat'
    )
    const xdg = await findReferat({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/u/cfg' },
      homeDir: '/home/u'
    })
    expect(xdg.dataDir).toBe('/home/u/cfg/referat')
    expect(xdg.searchedPaths).toContain('/opt/referat/referat')
  })

  it.runIf(process.platform === 'win32')(
    'finds a per-user Windows install under LOCALAPPDATA',
    async () => {
      const root = makeTempDir()
      const exe = path.join(root, 'Local', 'Programs', 'referat', 'referat.exe')
      mkdirSync(path.dirname(exe), { recursive: true })
      writeFileSync(exe, '')
      writeAsar(path.join(path.dirname(exe), 'resources', 'app.asar'), { version: '1.2.3' })
      const info = await findReferat({
        env: { LOCALAPPDATA: path.join(root, 'Local'), APPDATA: path.join(root, 'Roaming') }
      })
      expect(info.installed).toBe(true)
      expect(info.executablePath).toBe(exe)
      expect(info.version).toBe('1.2.3')
      expect(info.dataDirExists).toBe(false)
    }
  )
})

describe('installation and data folder detection', () => {
  it('reports not installed, and reading meetings throws ReferatNotInstalledError', async () => {
    const root = makeTempDir()
    const options = { executablePath: path.join(root, 'missing', 'referat.exe'), env: {} }
    const info = await findReferat(options)
    expect(info.installed).toBe(false)
    expect(info.executablePath).toBeNull()
    expect(info.version).toBeNull()
    await expect(listMeetings(options)).rejects.toBeInstanceOf(ReferatNotInstalledError)
    await expect(getMeeting('20260101120000-abc123', options)).rejects.toMatchObject({
      code: 'REFERAT_NOT_INSTALLED'
    })
  })

  it('reports an installed app without a data folder as ReferatDataNotFoundError', async () => {
    const root = makeTempDir()
    const exe = fakeInstall(root, '0.9.1')
    const env = { APPDATA: path.join(root, 'Roaming'), XDG_CONFIG_HOME: path.join(root, 'cfg') }
    const info = await findReferat({ executablePath: exe, env, homeDir: root })
    expect(info.installed).toBe(true)
    expect(info.version).toBe('0.9.1')
    expect(info.dataDirExists).toBe(false)
    const error = await listMeetings({ executablePath: exe, env, homeDir: root }).catch((e) => e)
    expect(error).toBeInstanceOf(ReferatDataNotFoundError)
    expect(error.dataDir).toBe(info.dataDir)
  })

  it('reads an explicit data folder without requiring an installation', async () => {
    const dataDir = makeTempDir()
    const options = { dataDir, executablePath: path.join(dataDir, 'nope'), env: {} }
    const info = await findReferat(options)
    expect(info.dataDirSource).toBe('option')
    expect(info.installed).toBe(false)
    expect(await listMeetings(options)).toEqual({ meetings: [], skipped: [] })
  })

  it('honours REFERAT_USER_DATA like Referat does', async () => {
    const dataDir = makeTempDir()
    const info = await findReferat({ env: { REFERAT_USER_DATA: dataDir } })
    expect(info.dataDir).toBe(dataDir)
    expect(info.dataDirSource).toBe('env')
    expect(info.dataDirExists).toBe(true)
  })

  it('reports an explicit data folder that does not exist', async () => {
    const dataDir = path.join(makeTempDir(), 'missing')
    await expect(listMeetings({ dataDir })).rejects.toBeInstanceOf(ReferatDataNotFoundError)
  })

  it('returns a null version when app.asar is missing', async () => {
    const root = makeTempDir()
    const exe = path.join(root, 'referat')
    writeFileSync(exe, '')
    expect((await findReferat({ executablePath: exe })).version).toBeNull()
  })
})

describe('launchReferat', () => {
  it('throws ReferatNotInstalledError when there is nothing to start', async () => {
    const root = makeTempDir()
    await expect(
      launchReferat({ executablePath: path.join(root, 'referat.exe') })
    ).rejects.toBeInstanceOf(ReferatNotInstalledError)
  })

  it('throws ReferatLaunchError when the executable cannot be started', async () => {
    const root = makeTempDir()
    const notExecutable = path.join(root, 'referat.txt')
    writeFileSync(notExecutable, 'not a program')
    await expect(launchReferat({ executablePath: notExecutable })).rejects.toBeInstanceOf(
      ReferatLaunchError
    )
  })

  /** A copy of Node under a unique name stands in for the app. */
  function standIn(tag: string): string {
    const exe = path.join(
      makeTempDir(),
      `rsdk${tag}${process.pid}${process.platform === 'win32' ? '.exe' : ''}`
    )
    copyFileSync(process.execPath, exe)
    return exe
  }

  it('starts the executable detached when it is not running', async () => {
    // With no arguments and no stdin, Node exits at once.
    const exe = standIn('a')
    const result = await launchReferat({ executablePath: exe })
    expect(result).toMatchObject({ executablePath: exe, alreadyRunning: false })
    expect(typeof result.pid).toBe('number')
  })

  it('does not start a second instance when it is already running', async () => {
    const exe = standIn('b')
    const running = spawn(exe, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    await new Promise((resolve) => running.once('spawn', resolve))
    try {
      expect(await launchReferat({ executablePath: exe })).toEqual({
        executablePath: exe,
        alreadyRunning: true,
        pid: undefined
      })
    } finally {
      running.kill()
    }
  })
})

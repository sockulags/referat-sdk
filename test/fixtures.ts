// Synthetic Referat data folders for tests. Nothing here comes from real meetings.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'referat-sdk-'))
}

export interface FixtureSummary {
  entry: Record<string, unknown>
  markdown?: string
}

export interface FixtureMeeting {
  /** Written as meta.json; a string is written verbatim (for corrupt files). */
  meta?: Record<string, unknown> | string
  transcript?: Record<string, unknown> | string
  summaries?: FixtureSummary[] | string
  legacyProtocol?: string
  audioFiles?: number
  levels?: boolean
}

function writeJsonOrText(file: string, value: Record<string, unknown> | unknown[] | string): void {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf-8')
}

/** Writes one meeting folder the way Referat lays it out. Returns the folder. */
export function writeMeeting(dataDir: string, id: string, meeting: FixtureMeeting): string {
  const folder = path.join(dataDir, 'meetings', id)
  mkdirSync(folder, { recursive: true })
  if (meeting.meta !== undefined) writeJsonOrText(path.join(folder, 'meta.json'), meeting.meta)
  if (meeting.transcript !== undefined) {
    writeJsonOrText(path.join(folder, 'transcript.json'), meeting.transcript)
  }
  if (typeof meeting.summaries === 'string') {
    writeFileSync(path.join(folder, 'summaries.json'), meeting.summaries, 'utf-8')
  } else if (meeting.summaries) {
    writeJsonOrText(
      path.join(folder, 'summaries.json'),
      meeting.summaries.map((s) => s.entry)
    )
    for (const s of meeting.summaries) {
      if (s.markdown !== undefined) {
        writeFileSync(path.join(folder, String(s.entry['fileName'])), s.markdown, 'utf-8')
      }
    }
  }
  if (meeting.legacyProtocol !== undefined) {
    writeFileSync(path.join(folder, 'protocol.md'), meeting.legacyProtocol, 'utf-8')
  }
  for (let i = 0; i < (meeting.audioFiles ?? 0); i++) {
    writeFileSync(path.join(folder, i === 0 ? 'audio.webm' : `audio-${i}.webm`), Buffer.from([i]))
  }
  if (meeting.levels) {
    writeFileSync(
      path.join(folder, 'levels.json'),
      JSON.stringify({ rate: 10, mic: [1], system: [] })
    )
  }
  return folder
}

export function meta(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Synthetic meeting ${id}`,
    createdAt: `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(8, 10)}:${id.slice(10, 12)}:${id.slice(12, 14)}.000Z`,
    durationSec: 1800,
    status: 'done',
    ...overrides
  }
}

export interface FileState {
  sha256: string
  size: number
  mtimeMs: number
}

/** Every file and folder under `root` with content hash, size and modification time. */
export function snapshotTree(root: string): Map<string, FileState | 'dir'> {
  const result = new Map<string, FileState | 'dir'>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (entry.isDirectory()) {
        result.set(rel, 'dir')
        walk(full)
      } else {
        const stats = statSync(full)
        result.set(rel, {
          sha256: createHash('sha256').update(readFileSync(full)).digest('hex'),
          size: stats.size,
          mtimeMs: stats.mtimeMs
        })
      }
    }
  }
  walk(root)
  return result
}

/** A minimal Electron app.asar holding only package.json, in the real asar layout. */
export function writeAsar(file: string, packageJson: Record<string, unknown>): void {
  const content = Buffer.from(JSON.stringify(packageJson), 'utf-8')
  const header = Buffer.from(
    JSON.stringify({ files: { 'package.json': { size: content.length, offset: '0' } } }),
    'utf-8'
  )
  // Pickle: uint32 payload size, uint32 string length, string padded to 4 bytes.
  const padded = Buffer.alloc(Math.ceil(header.length / 4) * 4)
  header.copy(padded)
  const pickle = Buffer.alloc(8 + padded.length)
  pickle.writeUInt32LE(4 + padded.length, 0)
  pickle.writeUInt32LE(header.length, 4)
  padded.copy(pickle, 8)
  const sizePickle = Buffer.alloc(8)
  sizePickle.writeUInt32LE(4, 0)
  sizePickle.writeUInt32LE(pickle.length, 4)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.concat([sizePickle, pickle, content]))
}

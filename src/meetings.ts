// Reading meetings from Referat's data folder. Every function here only reads:
// no file is written, renamed, locked or deleted.
//
// Layout, per Referat's src/main/storage.ts:
//   <dataDir>/meetings/<id>/meta.json        metadata and pipeline status (always present)
//   <dataDir>/meetings/<id>/transcript.json  transcript, once transcription has finished
//   <dataDir>/meetings/<id>/summaries.json   index of generated summaries
//   <dataDir>/meetings/<id>/protocol-*.md    one Markdown file per generated summary
//   <dataDir>/meetings/<id>/protocol.md      the single summary of meetings from Referat 0.5 and earlier
//   <dataDir>/meetings/<id>/audio.webm       recorded audio; long recordings add audio-1.webm, audio-2.webm, ...
//   <dataDir>/meetings/<id>/levels.json      per-source audio level envelope

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'
import {
  InvalidMeetingFileError,
  InvalidMeetingIdError,
  MeetingNotFoundError,
  ReferatError
} from './errors.js'
import { requireReadableData, type FindReferatOptions } from './install.js'
import {
  meetingMetaSchema,
  summaryIndexSchema,
  transcriptSchema,
  type MeetingMeta,
  type MeetingStatus,
  type RawTranscript,
  type SummaryEntry
} from './schemas.js'

/** The shape Referat gives meeting ids and folder names: a UTC timestamp and a short random suffix. */
export const MEETING_ID_PATTERN = /^[0-9]{14}-[a-z0-9]{1,12}$/

/** Statuses during which Referat is still recording or processing the meeting. */
const IN_PROGRESS: ReadonlySet<MeetingStatus> = new Set([
  'recording',
  'recorded',
  'transcribing',
  'diarizing',
  'summarizing'
])

/** Summary file written by Referat 0.5 and earlier, before summaries.json existed. */
const LEGACY_SUMMARY_FILE = 'protocol.md'

export type ReadMeetingsOptions = FindReferatOptions

export interface GetMeetingOptions extends FindReferatOptions {
  /**
   * Include the transcript's voice embeddings (biometric data Referat stores only
   * when voice recognition is on). Off by default.
   */
  includeSpeakerEmbeddings?: boolean
}

/** Which of a meeting's files exist. */
export interface MeetingArtifacts {
  transcript: boolean
  /** Number of generated summaries whose Markdown file exists. */
  summaries: number
  /** Number of audio segment files. */
  audioFiles: number
  levels: boolean
}

export interface MeetingListItem extends MeetingMeta {
  /** Absolute path of the meeting folder. */
  folder: string
  /**
   * True while Referat is recording or processing the meeting. A status left by
   * a crash stays until Referat's next start, when Referat resumes or fails it.
   */
  inProgress: boolean
  artifacts: MeetingArtifacts
}

/** A meeting folder that could not be read and was left out of a listing. */
export interface SkippedMeeting {
  /** The folder name, which is the meeting id. */
  id: string
  folder: string
  error: ReferatError
}

export interface MeetingList {
  /** Readable meetings, newest first. */
  meetings: MeetingListItem[]
  /** Meeting folders that could not be read, with the reason. */
  skipped: SkippedMeeting[]
}

export type Transcript = RawTranscript

/** One generated summary (Referat calls the default one "Protokoll"). */
export interface MeetingSummary extends SummaryEntry {
  /** The summary as Referat stores it: Markdown. */
  markdown: string
  /** True for a Referat 0.5-era protocol.md without an index entry. */
  legacy: boolean
}

export interface Meeting extends MeetingListItem {
  /** Null until transcription has finished. */
  transcript: Transcript | null
  /** Every summary, oldest first, as Referat lists them. */
  summaries: MeetingSummary[]
  /** Absolute paths of the audio segment files, in play order. */
  audioFiles: string[]
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/** Reads a text file, or returns undefined when it does not exist. Other read errors become typed errors. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf-8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    const message = error instanceof Error ? error.message : String(error)
    throw new InvalidMeetingFileError(
      file,
      [{ path: '', message: `could not be read: ${message}` }],
      {
        cause: error
      }
    )
  }
}

/** Reads and validates a JSON file, or returns undefined when it does not exist. */
async function readJson<S extends z.ZodType>(
  file: string,
  schema: S
): Promise<z.infer<S> | undefined> {
  const text = await readText(file)
  if (text === undefined) return undefined
  let data: unknown
  try {
    // Tolerate a UTF-8 byte order mark from a hand-edited file.
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new InvalidMeetingFileError(
      file,
      [{ path: '', message: `is not valid JSON: ${message}` }],
      {
        cause: error
      }
    )
  }
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new InvalidMeetingFileError(
      file,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message
      }))
    )
  }
  return result.data
}

async function readMeta(folder: string, id: string): Promise<MeetingMeta> {
  const file = path.join(folder, 'meta.json')
  const meta = await readJson(file, meetingMetaSchema)
  if (!meta) throw new MeetingNotFoundError(id)
  if (meta.id !== id) {
    throw new InvalidMeetingFileError(file, [
      {
        path: 'id',
        message: `${JSON.stringify(meta.id)} does not match its folder name ${JSON.stringify(id)}`
      }
    ])
  }
  return meta
}

/** Audio files in play order, the way Referat finds them: audio.webm, then audio-1.webm up to the first gap. */
async function findAudioFiles(folder: string): Promise<string[]> {
  const files: string[] = []
  const base = path.join(folder, 'audio.webm')
  if (await exists(base)) files.push(base)
  for (let i = 1; ; i++) {
    const segment = path.join(folder, `audio-${i}.webm`)
    if (!(await exists(segment))) break
    files.push(segment)
  }
  return files
}

/**
 * Summaries the way Referat lists them: a legacy protocol.md first when the
 * index does not cover it, then every index entry whose Markdown file exists.
 * Entries whose file is gone are skipped, as Referat's own UI does. Without
 * `withMarkdown` the files are only checked for existence and `markdown` is ''.
 */
async function readSummaries(
  folder: string,
  meta: MeetingMeta,
  withMarkdown: boolean
): Promise<MeetingSummary[]> {
  const entries = (await readJson(path.join(folder, 'summaries.json'), summaryIndexSchema)) ?? []
  const load = async (fileName: string): Promise<string | undefined> => {
    const file = path.join(folder, fileName)
    if (withMarkdown) return readText(file)
    return (await exists(file)) ? '' : undefined
  }
  const summaries: MeetingSummary[] = []

  if (!entries.some((entry) => entry.fileName === LEGACY_SUMMARY_FILE)) {
    const markdown = await load(LEGACY_SUMMARY_FILE)
    if (markdown !== undefined) {
      summaries.push({
        id: 'legacy',
        fileName: LEGACY_SUMMARY_FILE,
        templateId: 'protokoll',
        templateName: 'Protokoll',
        focus: '',
        createdAt: meta.createdAt,
        markdown,
        legacy: true
      })
    }
  }

  for (const entry of entries) {
    const markdown = await load(entry.fileName)
    if (markdown === undefined) continue
    summaries.push({ ...entry, markdown, legacy: false })
  }
  return summaries
}

interface MeetingParts {
  item: MeetingListItem
  summaries: MeetingSummary[]
  audioFiles: string[]
}

async function readMeetingParts(
  meetingsDir: string,
  id: string,
  withMarkdown: boolean
): Promise<MeetingParts> {
  const folder = path.join(meetingsDir, id)
  const meta = await readMeta(folder, id)
  const [summaries, audioFiles, transcript, levels] = await Promise.all([
    readSummaries(folder, meta, withMarkdown),
    findAudioFiles(folder),
    exists(path.join(folder, 'transcript.json')),
    exists(path.join(folder, 'levels.json'))
  ])
  return {
    item: {
      ...meta,
      folder,
      inProgress: IN_PROGRESS.has(meta.status),
      artifacts: {
        transcript,
        summaries: summaries.length,
        audioFiles: audioFiles.length,
        levels
      }
    },
    summaries,
    audioFiles
  }
}

function newestFirst(a: MeetingListItem, b: MeetingListItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * Lists every meeting, newest first. Validates meta.json and summaries.json of
 * each meeting; transcripts are only checked for existence. A meeting folder
 * that cannot be read is reported in `skipped` instead of failing the list.
 * Folders whose name is not a Referat meeting id are ignored, as Referat does.
 */
export async function listMeetings(options: ReadMeetingsOptions = {}): Promise<MeetingList> {
  const { meetingsDir } = await requireReadableData(options)
  let ids: string[]
  try {
    ids = (await readdir(meetingsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && MEETING_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    // Referat creates meetings/ on first use; before that there is nothing to list.
    if (isNotFound(error)) return { meetings: [], skipped: [] }
    throw error
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return { ok: true as const, item: (await readMeetingParts(meetingsDir, id, false)).item }
      } catch (error) {
        if (!(error instanceof ReferatError)) throw error
        return { ok: false as const, skipped: { id, folder: path.join(meetingsDir, id), error } }
      }
    })
  )

  const meetings: MeetingListItem[] = []
  const skipped: SkippedMeeting[] = []
  for (const result of results) {
    if (result.ok) meetings.push(result.item)
    else skipped.push(result.skipped)
  }
  meetings.sort(newestFirst)
  skipped.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  return { meetings, skipped }
}

/**
 * Reads one meeting in full: metadata, transcript and every generated summary.
 * Throws InvalidMeetingIdError, MeetingNotFoundError or InvalidMeetingFileError.
 */
export async function getMeeting(id: string, options: GetMeetingOptions = {}): Promise<Meeting> {
  if (!MEETING_ID_PATTERN.test(id)) throw new InvalidMeetingIdError(id)
  const { meetingsDir } = await requireReadableData(options)
  const { item, summaries, audioFiles } = await readMeetingParts(meetingsDir, id, true)
  const transcript =
    (await readJson(path.join(item.folder, 'transcript.json'), transcriptSchema)) ?? null
  if (transcript && !options.includeSpeakerEmbeddings) delete transcript.speakerEmbeddings
  return { ...item, transcript, summaries, audioFiles }
}

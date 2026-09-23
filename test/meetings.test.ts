import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  getMeeting,
  InvalidMeetingFileError,
  InvalidMeetingIdError,
  listMeetings,
  MeetingNotFoundError
} from '../src/index.js'
import { makeTempDir, meta, snapshotTree, writeMeeting } from './fixtures.js'

const COMPLETE = '20260310090000-full01'
const PROCESSING = '20260312140000-proc01'
const LEGACY = '20250101080000-old001'
const CORRUPT = '20260311100000-bad001'
const WRONG_TYPE = '20260309100000-type01'
const BAD_TRANSCRIPT = '20260308100000-trn001'
const TRAVERSAL = '20260307100000-trav01'
const NO_META = '20260306100000-nometa'
const ID_MISMATCH = '20260305100000-mism01'

let dataDir: string
const options = (): { dataDir: string } => ({ dataDir })

function transcript(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    language: 'sv',
    text: 'Hej allihop. Vi börjar.',
    segments: [
      { startSec: 0, endSec: 2.5, text: 'Hej allihop.', speaker: 'S1' },
      { startSec: 2.5, endSec: 4, text: 'Vi börjar.', speaker: 'S2', originalText: 'Vi borjar.' }
    ],
    speakers: { S1: 'Talare 1', S2: 'Anna' },
    ...extra
  }
}

beforeAll(() => {
  dataDir = makeTempDir()

  writeMeeting(dataDir, COMPLETE, {
    meta: meta(COMPLETE, {
      templateId: 'protokoll',
      warning: { message: 'Speaker identification failed' },
      futureField: { anything: true }
    }),
    transcript: transcript({
      speakerEmbeddings: { S1: [0.1, 0.2], S2: [0.3, 0.4] },
      speakerSuggestions: { S1: 'Bo?' },
      glossaryHits: 1,
      futureTranscriptField: 42
    }),
    summaries: [
      {
        entry: {
          id: 'a1',
          fileName: 'protocol-protokoll.md',
          templateId: 'protokoll',
          templateName: 'Protokoll',
          focus: '',
          createdAt: '2026-03-10T10:00:00.000Z',
          futureEntryField: 'x'
        },
        markdown: '## Sammanfattning\nSynthetic.\n\n## Beslut\n- A\n\n## Actionpunkter\n- B'
      },
      {
        entry: {
          id: 'a2',
          fileName: 'protocol-actionpunkter.md',
          templateId: 'actionpunkter',
          templateName: 'Actionpunkter',
          focus: 'budget',
          createdAt: '2026-03-10T10:05:00.000Z'
        },
        markdown: '## Actionpunkter\n- C'
      },
      {
        // Index entry whose file is gone: Referat skips it, so does the SDK.
        entry: {
          id: 'a3',
          fileName: 'protocol-gone.md',
          templateId: 'sammandrag',
          templateName: 'Snabbt sammandrag',
          focus: '',
          createdAt: '2026-03-10T10:06:00.000Z'
        }
      }
    ],
    audioFiles: 3,
    levels: true
  })

  writeMeeting(dataDir, PROCESSING, {
    meta: meta(PROCESSING, { status: 'transcribing', durationSec: 600 }),
    audioFiles: 1,
    levels: true
  })

  writeMeeting(dataDir, LEGACY, {
    meta: meta(LEGACY),
    transcript: transcript(),
    legacyProtocol: '## Sammanfattning\nLegacy synthetic.',
    audioFiles: 1
  })

  writeMeeting(dataDir, CORRUPT, { meta: '{"id": "20260311100000-bad001", "title": ' })
  writeMeeting(dataDir, WRONG_TYPE, { meta: meta(WRONG_TYPE, { durationSec: '1800' }) })
  writeMeeting(dataDir, BAD_TRANSCRIPT, {
    meta: meta(BAD_TRANSCRIPT),
    transcript: transcript({
      segments: [
        { startSec: 0, endSec: 1, text: 'ok' },
        { startSec: 'one', endSec: 2, text: 'bad' }
      ]
    })
  })
  writeMeeting(dataDir, TRAVERSAL, {
    meta: meta(TRAVERSAL),
    summaries: JSON.stringify([
      {
        id: 'x',
        fileName: '../../settings.json',
        templateId: 'protokoll',
        templateName: 'Protokoll',
        focus: '',
        createdAt: '2026-03-07T10:00:00.000Z'
      }
    ])
  })
  writeMeeting(dataDir, NO_META, { audioFiles: 1 })
  writeMeeting(dataDir, ID_MISMATCH, { meta: meta('20260101000000-other1') })
  // Not a meeting id: ignored, as Referat ignores it.
  mkdirSync(path.join(dataDir, 'meetings', 'scratch'), { recursive: true })
})

describe('listMeetings', () => {
  it('lists readable meetings newest first and reports the unreadable ones', async () => {
    const { meetings, skipped } = await listMeetings(options())
    expect(meetings.map((m) => m.id)).toEqual([PROCESSING, COMPLETE, BAD_TRANSCRIPT, LEGACY])
    expect(skipped.map((s) => [s.id, s.error.code])).toEqual([
      [CORRUPT, 'INVALID_MEETING_FILE'],
      [WRONG_TYPE, 'INVALID_MEETING_FILE'],
      [TRAVERSAL, 'INVALID_MEETING_FILE'],
      [NO_META, 'MEETING_NOT_FOUND'],
      [ID_MISMATCH, 'INVALID_MEETING_FILE']
    ])
  })

  it('reports which artifacts exist and the processing state', async () => {
    const { meetings } = await listMeetings(options())
    const complete = meetings.find((m) => m.id === COMPLETE)
    expect(complete).toMatchObject({
      status: 'done',
      inProgress: false,
      durationSec: 1800,
      templateId: 'protokoll',
      artifacts: { transcript: true, summaries: 2, audioFiles: 3, levels: true }
    })
    const processing = meetings.find((m) => m.id === PROCESSING)
    expect(processing).toMatchObject({
      status: 'transcribing',
      inProgress: true,
      artifacts: { transcript: false, summaries: 0, audioFiles: 1, levels: true }
    })
  })

  it('drops unknown extra fields instead of failing', async () => {
    const { meetings } = await listMeetings(options())
    const complete = meetings.find((m) => m.id === COMPLETE)
    expect(complete).toBeDefined()
    expect(complete).not.toHaveProperty('futureField')
  })

  it('returns an empty list before Referat has created meetings/', async () => {
    expect(await listMeetings({ dataDir: makeTempDir() })).toEqual({ meetings: [], skipped: [] })
  })
})

describe('getMeeting', () => {
  it('reads a meeting with every artifact', async () => {
    const meeting = await getMeeting(COMPLETE, options())
    expect(meeting.title).toBe(`Synthetic meeting ${COMPLETE}`)
    expect(meeting.warning).toEqual({ message: 'Speaker identification failed' })
    expect(meeting.transcript?.segments).toHaveLength(2)
    expect(meeting.transcript?.segments[1]).toEqual({
      startSec: 2.5,
      endSec: 4,
      text: 'Vi börjar.',
      speaker: 'S2',
      originalText: 'Vi borjar.'
    })
    expect(meeting.transcript?.speakers).toEqual({ S1: 'Talare 1', S2: 'Anna' })
    expect(meeting.transcript?.speakerSuggestions).toEqual({ S1: 'Bo?' })
    expect(meeting.transcript).not.toHaveProperty('futureTranscriptField')
    expect(meeting.summaries.map((s) => [s.id, s.templateId, s.focus, s.legacy])).toEqual([
      ['a1', 'protokoll', '', false],
      ['a2', 'actionpunkter', 'budget', false]
    ])
    expect(meeting.summaries[0]?.markdown).toContain('## Beslut')
    expect(meeting.summaries[0]).not.toHaveProperty('futureEntryField')
    expect(meeting.audioFiles.map((f) => path.basename(f))).toEqual([
      'audio.webm',
      'audio-1.webm',
      'audio-2.webm'
    ])
  })

  it('leaves out voice embeddings unless asked for', async () => {
    expect((await getMeeting(COMPLETE, options())).transcript).not.toHaveProperty(
      'speakerEmbeddings'
    )
    const withEmbeddings = await getMeeting(COMPLETE, {
      ...options(),
      includeSpeakerEmbeddings: true
    })
    expect(withEmbeddings.transcript?.speakerEmbeddings).toEqual({ S1: [0.1, 0.2], S2: [0.3, 0.4] })
  })

  it('reads a meeting mid-processing without transcript or minutes', async () => {
    const meeting = await getMeeting(PROCESSING, options())
    expect(meeting.status).toBe('transcribing')
    expect(meeting.inProgress).toBe(true)
    expect(meeting.transcript).toBeNull()
    expect(meeting.summaries).toEqual([])
  })

  it('reads a legacy protocol.md as a Protokoll summary', async () => {
    const meeting = await getMeeting(LEGACY, options())
    expect(meeting.summaries).toEqual([
      {
        id: 'legacy',
        fileName: 'protocol.md',
        templateId: 'protokoll',
        templateName: 'Protokoll',
        focus: '',
        createdAt: meeting.createdAt,
        markdown: '## Sammanfattning\nLegacy synthetic.',
        legacy: true
      }
    ])
  })

  it('rejects a wrong-typed field with the file and field named', async () => {
    const error = await getMeeting(WRONG_TYPE, options()).catch((e) => e)
    expect(error).toBeInstanceOf(InvalidMeetingFileError)
    expect(error.file).toBe(path.join(dataDir, 'meetings', WRONG_TYPE, 'meta.json'))
    expect(error.issues).toEqual([{ path: 'durationSec', message: expect.any(String) }])
    expect(error.message).toContain('meta.json')
    expect(error.message).toContain('field "durationSec"')
  })

  it('rejects a wrong-typed transcript segment with its index', async () => {
    const error = await getMeeting(BAD_TRANSCRIPT, options()).catch((e) => e)
    expect(error).toBeInstanceOf(InvalidMeetingFileError)
    expect(error.file).toMatch(/transcript\.json$/)
    expect(error.issues.map((i: { path: string }) => i.path)).toEqual(['segments.1.startSec'])
  })

  it('rejects invalid JSON', async () => {
    const error = await getMeeting(CORRUPT, options()).catch((e) => e)
    expect(error).toBeInstanceOf(InvalidMeetingFileError)
    expect(error.issues[0].message).toMatch(/not valid JSON/)
  })

  it('refuses summary file names that point outside the meeting folder', async () => {
    const error = await getMeeting(TRAVERSAL, options()).catch((e) => e)
    expect(error).toBeInstanceOf(InvalidMeetingFileError)
    expect(error.issues[0].path).toBe('0.fileName')
  })

  it('rejects a meta.json whose id does not match its folder', async () => {
    const error = await getMeeting(ID_MISMATCH, options()).catch((e) => e)
    expect(error).toBeInstanceOf(InvalidMeetingFileError)
    expect(error.issues[0].path).toBe('id')
  })

  it('rejects ids that are not Referat meeting ids', async () => {
    await expect(getMeeting('../settings', options())).rejects.toBeInstanceOf(InvalidMeetingIdError)
    await expect(getMeeting('scratch', options())).rejects.toBeInstanceOf(InvalidMeetingIdError)
  })

  it('reports a meeting that does not exist', async () => {
    await expect(getMeeting('20990101000000-none00', options())).rejects.toBeInstanceOf(
      MeetingNotFoundError
    )
    await expect(getMeeting(NO_META, options())).rejects.toBeInstanceOf(MeetingNotFoundError)
  })
})

describe('read-only guarantee', () => {
  it('leaves every file and folder in the data folder unchanged', async () => {
    const before = snapshotTree(dataDir)
    await listMeetings(options())
    for (const id of [
      COMPLETE,
      PROCESSING,
      LEGACY,
      CORRUPT,
      WRONG_TYPE,
      BAD_TRANSCRIPT,
      TRAVERSAL
    ]) {
      await getMeeting(id, { ...options(), includeSpeakerEmbeddings: true }).catch(() => undefined)
    }
    await getMeeting(NO_META, options()).catch(() => undefined)
    expect(snapshotTree(dataDir)).toEqual(before)
  })
})

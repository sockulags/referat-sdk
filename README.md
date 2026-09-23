# referat-sdk

A small TypeScript SDK that lets other programs read the meetings stored by a locally installed
[Referat](https://github.com/sockulags/referat), the local meeting recorder, transcriber and
minutes writer. It lists meetings, reads one meeting's metadata, transcript and generated summaries,
and can start the installed app.

## Guarantees

- **Referat must be installed.** The SDK looks for the installed app and reports clearly when it is
  missing (`ReferatNotInstalledError`) or when Referat has not created its data folder yet
  (`ReferatDataNotFoundError`). The one exception is an explicitly named data folder (see
  [Options](#options)), which is read as-is.
- **Referat is never modified.** The SDK does not depend on Referat's code and needs no changes to
  it. It reads the files Referat already writes and can start the installed app. Nothing else.
- **Read-only.** The SDK never writes, renames, locks or deletes anything in Referat's data folder.
  Files are opened for reading only; the test suite hashes a fixture data folder before and after
  every operation and requires it to be unchanged.
- **Validated.** Referat's files carry no schema version, so everything the SDK reads is checked at
  runtime. See [Validation](#validation).

## Install

The package is not published to npm. Install it from GitHub; a `prepare` script builds it on
install:

```sh
npm install github:sockulags/referat-sdk
```

npm 11 may warn that `referat-sdk` has a `prepare` script not covered by `allowScripts`; the build
still runs. Run `npm approve-scripts referat-sdk` to record the approval and silence the warning.

Requires Node.js 20 or later (Electron 43, which Referat runs on, bundles a newer Node). The package
is ESM-only and ships type declarations.

## Usage

```ts
import { findReferat, listMeetings, getMeeting, launchReferat, ReferatError } from 'referat-sdk'

const referat = await findReferat()
if (!referat.installed) console.log('Install Referat first')

try {
  const { meetings, skipped } = await listMeetings()
  for (const m of meetings) {
    console.log(m.id, m.createdAt, m.status, m.title, m.artifacts)
  }
  for (const s of skipped) console.warn(`Could not read ${s.id}: ${s.error.message}`)

  const meeting = await getMeeting(meetings[0].id)
  for (const segment of meeting.transcript?.segments ?? []) {
    const speaker = segment.speaker && meeting.transcript?.speakers?.[segment.speaker]
    console.log(segment.startSec, speaker ?? segment.speaker, segment.text)
  }
  for (const summary of meeting.summaries) {
    console.log(summary.templateName, summary.markdown)
  }
} catch (error) {
  if (error instanceof ReferatError) console.error(error.code, error.message)
  else throw error
}

await launchReferat()
```

## API

### `findReferat(options?): Promise<ReferatInstallation>`

Locates the installed app and its data folder. Never throws for a missing installation.

```ts
interface ReferatInstallation {
  installed: boolean
  executablePath: string | null
  searchedPaths: string[] // every executable location checked
  version: string | null // read from the installed app's bundled package.json
  dataDir: string // Electron userData
  dataDirSource: 'option' | 'env' | 'default'
  dataDirExists: boolean
  meetingsDir: string // <dataDir>/meetings
}
```

### `listMeetings(options?): Promise<MeetingList>`

Lightweight summaries of every meeting, newest first. For each meeting it validates `meta.json`
and `summaries.json` and checks which other files exist; transcripts and summary Markdown are not
read. A meeting folder that cannot be read does not fail the list: it is reported in `skipped` with
a typed error. Folders whose name is not a Referat meeting id are ignored, as Referat ignores them.

```ts
interface MeetingList {
  meetings: MeetingListItem[]
  skipped: { id: string; folder: string; error: ReferatError }[]
}

interface MeetingListItem {
  id: string // e.g. '20260310090000-k3j9x2', also the folder name
  title: string
  createdAt: string // ISO 8601
  durationSec: number
  status: 'recording' | 'recorded' | 'transcribing' | 'diarizing' | 'summarizing' | 'done' | 'error'
  templateId?: string // template chosen when recording started
  error?: { message: string; detail?: string; failedStep: 'transcribe' | 'summarize' }
  warning?: { message: string; detail?: string }
  folder: string // absolute path of the meeting folder
  inProgress: boolean // true while recording or processing
  artifacts: { transcript: boolean; summaries: number; audioFiles: number; levels: boolean }
}
```

`inProgress` follows the status Referat has written. If Referat crashed mid-recording or
mid-processing, the status stays as it was until Referat's next start, when Referat resumes the
work or marks the meeting as failed.

### `getMeeting(id, options?): Promise<Meeting>`

One meeting in full: everything in `MeetingListItem`, plus:

```ts
interface Meeting extends MeetingListItem {
  transcript: Transcript | null // null until transcription has finished
  summaries: MeetingSummary[] // oldest first
  audioFiles: string[] // absolute paths: audio.webm, audio-1.webm, ...
}

interface Transcript {
  language: string
  text: string
  segments: {
    startSec: number
    endSec: number
    text: string
    speaker?: string
    originalText?: string
  }[]
  speakers?: Record<string, string> // speaker id ('S1') -> display name
  speakerSuggestions?: Record<string, string>
  speakerEmbeddings?: Record<string, number[]> // only with includeSpeakerEmbeddings
  originalText?: string
  glossaryHits?: number
}

interface MeetingSummary {
  id: string
  fileName: string
  templateId: string // 'protokoll', 'sammandrag', 'actionpunkter', 'beslutslogg', ... or a user template
  templateName: string
  focus: string // '' means the whole meeting
  createdAt: string
  markdown: string
  legacy: boolean // a protocol.md from Referat 0.5 or earlier
}
```

**Minutes, decisions and action items are Markdown.** Referat does not store them as structured
data: each summary is a Markdown file produced from a prompt template. The default template,
`protokoll`, asks for the headings `## Sammanfattning`, `## Beslut`, `## Actionpunkter` and
`## Öppna frågor`; the `actionpunkter` and `beslutslogg` templates produce action items and a
decision log. The SDK returns the Markdown as stored and does not parse it.

A summary whose index entry points at a missing file is left out, as Referat's own UI does.

### `launchReferat(options?): Promise<LaunchResult>`

```ts
interface LaunchResult {
  executablePath: string
  alreadyRunning: boolean
  pid: number | undefined
}
```

Starts the installed app detached from the calling process and resolves once it has spawned.
Referat has no single-instance lock, so a second start would open a second app on the same data;
when a process with Referat's executable name is already running, `launchReferat` starts nothing
and returns `alreadyRunning: true`. The check uses `tasklist` on Windows and `pgrep` elsewhere.

### Options

Every function takes the same optional settings:

| Option                       | Purpose                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `dataDir`                    | Referat's data folder. Used as-is; Referat need not be installed to read it.     |
| `executablePath`             | The Referat executable, instead of the platform's install locations.             |
| `platform`, `env`, `homeDir` | Override `process.platform`, `process.env` and `os.homedir()`, mainly for tests. |
| `includeSpeakerEmbeddings`   | `getMeeting` only: include voice embeddings (biometric data). Off by default.    |

The `REFERAT_USER_DATA` environment variable, which Referat itself uses to relocate its data, is
honoured the same way as `dataDir`.

## Errors

Every intentional error extends `ReferatError` and has a stable `code`:

| Class                      | `code`                   | When                                                         |
| -------------------------- | ------------------------ | ------------------------------------------------------------ |
| `ReferatNotInstalledError` | `REFERAT_NOT_INSTALLED`  | No executable found; `searched` lists the locations checked. |
| `ReferatDataNotFoundError` | `REFERAT_DATA_NOT_FOUND` | The data folder does not exist yet; `dataDir` names it.      |
| `InvalidMeetingIdError`    | `INVALID_MEETING_ID`     | The id does not look like a Referat meeting id.              |
| `MeetingNotFoundError`     | `MEETING_NOT_FOUND`      | No meeting folder with a `meta.json` for the id.             |
| `InvalidMeetingFileError`  | `INVALID_MEETING_FILE`   | A file is unreadable, not JSON, or has the wrong shape.      |
| `ReferatLaunchError`       | `REFERAT_LAUNCH_FAILED`  | The executable exists but could not be started.              |

## Validation

Every JSON file is validated with [zod](https://zod.dev) against shapes derived from Referat's own
types:

- Unknown extra fields are tolerated and dropped, so a newer Referat can add fields without breaking
  readers. The returned objects contain exactly the fields documented above.
- A missing or wrong-typed required field, invalid JSON, or an unknown `status` value throws
  `InvalidMeetingFileError`. Its `file` is the absolute path, and `issues` lists each problem with a
  dotted field path such as `segments.1.startSec`. The message names both.
- `meta.json`'s `id` must match its folder name, and summary file names must be plain names inside
  the meeting folder.
- Referat writes `transcript.json` and `summaries.json` in place. Reading while Referat is writing
  can therefore see a half-written file, which surfaces as `InvalidMeetingFileError`; retrying later
  reads the complete file.

## Where Referat stores meetings

Referat keeps its data in Electron's `userData` folder for the app name `referat`:

| Platform | Data folder                                       | Installed app looked for at                                                         |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Windows  | `%APPDATA%\referat`                               | `%LOCALAPPDATA%\Programs\referat\referat.exe`, `%ProgramFiles%\referat\referat.exe` |
| macOS    | `~/Library/Application Support/referat`           | `/Applications/referat.app`, `~/Applications/referat.app`                           |
| Linux    | `$XDG_CONFIG_HOME/referat` or `~/.config/referat` | `/opt/referat/referat`, `/usr/bin/referat`                                          |

Windows is the platform Referat ships for and the one this SDK is tested against. macOS and Linux
paths follow Electron and electron-builder defaults and are best effort; an AppImage can live
anywhere, so pass `executablePath` for it.

Each meeting is a folder `meetings/<id>/` containing:

| File                              | Contents                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| `meta.json`                       | Title, start time, duration, pipeline status, error or warning. |
| `transcript.json`                 | Segments with timestamps and speaker ids, speaker names.        |
| `summaries.json`                  | Index of generated summaries: template, focus, file name, time. |
| `protocol-<template>.md`          | One Markdown file per generated summary.                        |
| `protocol.md`                     | The single summary of meetings from Referat 0.5 and earlier.    |
| `audio.webm`, `audio-1.webm`, ... | Recorded audio segments, in play order.                         |
| `levels.json`                     | Per-source audio level envelope used for speaker separation.    |

The SDK exposes audio only as file paths and does not read `levels.json`.

## Referat version

The file shapes were derived from Referat **0.9.1** (commit `c82e522`, `src/shared/types.ts` and
`src/main/storage.ts`). If a later Referat changes its files, the SDK reports the mismatch through
`InvalidMeetingFileError` instead of returning wrong data.

## CLI

A small CLI for tools that are not written in Node:

```sh
npx referat-sdk info             # installation and data folder
npx referat-sdk list [--json]    # meetings, newest first
npx referat-sdk show <id> --json # one meeting in full
npx referat-sdk launch           # start Referat
```

All commands accept `--data-dir <dir>`. Exit code 0 means success, 1 a Referat error (printed to
stderr), 2 a usage error.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

Tests build synthetic data folders in the system temp directory; no real meeting data is used.

## License

MIT

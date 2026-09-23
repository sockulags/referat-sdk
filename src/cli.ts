#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { ReferatError } from './errors.js'
import { findReferat } from './install.js'
import { launchReferat } from './launch.js'
import { getMeeting, listMeetings } from './meetings.js'

const USAGE = `Usage: referat-sdk <command> [options]

Commands:
  info              Show where Referat is installed and where its data lives
  list              List meetings, newest first
  show <id>         Show one meeting with transcript and summaries
  launch            Start the installed Referat

Options:
  --json            Print JSON instead of text
  --data-dir <dir>  Referat's data folder, overriding detection
  -h, --help        Show this help`

function print(value: unknown, json: boolean, text: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text()}\n`)
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`)
    return command || values.help ? 0 : 2
  }
  const json = values.json
  const options = values['data-dir'] ? { dataDir: values['data-dir'] } : {}

  switch (command) {
    case 'info': {
      const info = await findReferat(options)
      print(info, json, () =>
        [
          `Installed:   ${info.installed ? 'yes' : 'no'}`,
          `Executable:  ${info.executablePath ?? '(not found)'}`,
          `Version:     ${info.version ?? '(unknown)'}`,
          `Data folder: ${info.dataDir}${info.dataDirExists ? '' : ' (does not exist yet)'}`
        ].join('\n')
      )
      return 0
    }
    case 'list': {
      const { meetings, skipped } = await listMeetings(options)
      const output = {
        meetings,
        skipped: skipped.map((s) => ({ id: s.id, code: s.error.code, message: s.error.message }))
      }
      print(output, json, () => {
        const lines = meetings.map(
          (m) =>
            `${m.id}  ${m.status.padEnd(12)} ${formatDuration(m.durationSec).padStart(10)}  ${m.title}`
        )
        for (const s of skipped) lines.push(`skipped ${s.id}: ${s.error.message}`)
        return lines.join('\n') || 'No meetings.'
      })
      return 0
    }
    case 'show': {
      const id = rest[0]
      if (!id) {
        process.stderr.write(`Missing meeting id.\n\n${USAGE}\n`)
        return 2
      }
      const meeting = await getMeeting(id, options)
      print(meeting, json, () => {
        const parts = [
          `# ${meeting.title}`,
          `${meeting.createdAt}  ${meeting.status}  ${formatDuration(meeting.durationSec)}`
        ]
        for (const summary of meeting.summaries) {
          parts.push(`\n## ${summary.templateName}\n\n${summary.markdown.trim()}`)
        }
        if (meeting.transcript) {
          const names = meeting.transcript.speakers ?? {}
          const lines = meeting.transcript.segments.map((s) => {
            const who = s.speaker ? `${names[s.speaker] ?? s.speaker}: ` : ''
            return `[${Math.floor(s.startSec)}s] ${who}${s.text}`
          })
          parts.push(`\n## Transcript\n\n${lines.join('\n')}`)
        }
        return parts.join('\n')
      })
      return 0
    }
    case 'launch': {
      const result = await launchReferat(options)
      print(result, json, () =>
        result.alreadyRunning ? 'Referat is already running.' : `Started ${result.executablePath}`
      )
      return 0
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof ReferatError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
      return
    }
    if (error instanceof TypeError && 'code' in error) {
      // parseArgs rejects unknown options with a TypeError carrying an ERR_PARSE_ARGS_* code.
      process.stderr.write(`${error.message}\n\n${USAGE}\n`)
      process.exitCode = 2
      return
    }
    throw error
  }
)

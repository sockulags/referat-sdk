/** Every error the SDK throws on purpose extends this class and carries a stable `code`. */
export class ReferatError extends Error {
  readonly code: ReferatErrorCode

  constructor(code: ReferatErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export type ReferatErrorCode =
  | 'REFERAT_NOT_INSTALLED'
  | 'REFERAT_DATA_NOT_FOUND'
  | 'INVALID_MEETING_ID'
  | 'MEETING_NOT_FOUND'
  | 'INVALID_MEETING_FILE'
  | 'REFERAT_LAUNCH_FAILED'

/** No Referat executable was found in any known install location. */
export class ReferatNotInstalledError extends ReferatError {
  readonly searched: string[]

  constructor(searched: string[]) {
    super(
      'REFERAT_NOT_INSTALLED',
      `Referat is not installed. Looked for the executable in: ${searched.join(', ') || '(no known locations for this platform)'}`
    )
    this.searched = searched
  }
}

/** Referat is installed (or a data folder was given) but its data folder does not exist yet. */
export class ReferatDataNotFoundError extends ReferatError {
  readonly dataDir: string

  constructor(dataDir: string) {
    super(
      'REFERAT_DATA_NOT_FOUND',
      `Referat has no data folder yet at ${dataDir}. Start Referat once, or record a meeting, to create it.`
    )
    this.dataDir = dataDir
  }
}

/** The id does not have the shape Referat gives meeting folders. */
export class InvalidMeetingIdError extends ReferatError {
  readonly id: string

  constructor(id: string) {
    super('INVALID_MEETING_ID', `Invalid meeting id: ${JSON.stringify(id)}`)
    this.id = id
  }
}

/** No meeting folder with a meta.json exists for this id. */
export class MeetingNotFoundError extends ReferatError {
  readonly id: string

  constructor(id: string) {
    super('MEETING_NOT_FOUND', `Meeting not found: ${id}`)
    this.id = id
  }
}

/** One problem found while validating a file. `path` is the dotted field path, '' for the whole file. */
export interface FileIssue {
  path: string
  message: string
}

/** A file Referat wrote could not be read, is not valid JSON, or does not have the expected shape. */
export class InvalidMeetingFileError extends ReferatError {
  readonly file: string
  readonly issues: FileIssue[]

  constructor(file: string, issues: FileIssue[], options?: { cause?: unknown }) {
    const detail = issues
      .map((i) => (i.path ? `field "${i.path}": ${i.message}` : i.message))
      .join('; ')
    super('INVALID_MEETING_FILE', `Invalid Referat file ${file}: ${detail}`, options)
    this.file = file
    this.issues = issues
  }
}

/** The Referat executable was found but could not be started. */
export class ReferatLaunchError extends ReferatError {
  readonly executablePath: string

  constructor(executablePath: string, cause: unknown) {
    super(
      'REFERAT_LAUNCH_FAILED',
      `Could not start Referat at ${executablePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
    this.executablePath = executablePath
  }
}

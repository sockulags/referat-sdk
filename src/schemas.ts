// Runtime shapes of the files Referat writes into each meeting folder.
//
// Referat's files carry no schema version, so every shape here is derived by
// hand from Referat's own types (src/shared/types.ts and src/main/storage.ts)
// and checked on every read. Unknown extra fields are dropped, never an error:
// a newer Referat may add fields without breaking this SDK. A missing or
// wrong-typed required field is an error that names the file and the field.

import { z } from 'zod'

/** Every status Referat's pipeline sets on meta.json. */
export const MEETING_STATUSES = [
  'recording',
  'recorded',
  'transcribing',
  'diarizing',
  'summarizing',
  'done',
  'error'
] as const

export const meetingStatusSchema = z.enum(MEETING_STATUSES)

/** meta.json */
export const meetingMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** ISO 8601, as written by Referat. */
  createdAt: z.string(),
  durationSec: z.number(),
  status: meetingStatusSchema,
  templateId: z.string().optional(),
  error: z
    .object({
      message: z.string(),
      detail: z.string().optional(),
      failedStep: z.enum(['transcribe', 'summarize'])
    })
    .optional(),
  warning: z
    .object({
      message: z.string(),
      detail: z.string().optional()
    })
    .optional()
})

export const transcriptSegmentSchema = z.object({
  startSec: z.number(),
  endSec: z.number(),
  text: z.string(),
  /** Canonical speaker id ('S1', 'S2', ...) when speaker identification ran. */
  speaker: z.string().optional(),
  /** What the transcription provider returned, kept only on segments the glossary rewrote. */
  originalText: z.string().optional()
})

/** transcript.json */
export const transcriptSchema = z.object({
  language: z.string(),
  segments: z.array(transcriptSegmentSchema),
  text: z.string(),
  speakers: z.record(z.string(), z.string()).optional(),
  speakerEmbeddings: z.record(z.string(), z.array(z.number())).optional(),
  speakerSuggestions: z.record(z.string(), z.string()).optional(),
  originalText: z.string().optional(),
  glossaryHits: z.number().optional()
})

/** One entry of summaries.json: a summary's metadata; its Markdown lives in `fileName`. */
export const summaryEntrySchema = z.object({
  id: z.string(),
  // A plain file name inside the meeting folder; anything that could point
  // elsewhere is rejected rather than followed.
  fileName: z
    .string()
    .regex(/^[^/\\]+$/, 'must be a plain file name inside the meeting folder')
    .refine((name) => name !== '.' && name !== '..', 'must be a plain file name'),
  templateId: z.string(),
  templateName: z.string(),
  focus: z.string(),
  createdAt: z.string()
})

/** summaries.json */
export const summaryIndexSchema = z.array(summaryEntrySchema)

export type MeetingStatus = z.infer<typeof meetingStatusSchema>
export type MeetingMeta = z.infer<typeof meetingMetaSchema>
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>
export type RawTranscript = z.infer<typeof transcriptSchema>
export type SummaryEntry = z.infer<typeof summaryEntrySchema>

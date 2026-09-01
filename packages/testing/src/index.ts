export {
  collectSourceFiles,
  checkBoundaries,
  extractImports,
  CHORUS_BOUNDARY_RULES,
} from './boundaries.js'
export type { SourceFile, BoundaryViolation, BoundaryRule } from './boundaries.js'

export { createRecordingMailer } from './fakes/mailer.js'
export type { Mailer, RecordingMailer, SentMail } from './fakes/mailer.js'

import { z } from 'zod'
import { DOCUMENT_TYPES } from './documents.js'

/**
 * What a shaping turn decides to do with an artefact (CHAT-6).
 *
 * The model reads the person's instruction and the session and proposes one of
 * these; a single tool then carries it out as the person. The action is an
 * enum rather than one free-text field so the tool dispatches on a closed set,
 * and the reference is left as the words the person used — resolving it is the
 * tool's job (and reporting ambiguity rather than guessing is the point).
 */
export const ChatActionSchema = z
  .object({
    action: z
      .enum(['create_document', 'refine_task', 'answer'])
      .describe('What to do: create a document, refine a task, or just answer in chat.'),
    documentType: z
      .enum(DOCUMENT_TYPES)
      .optional()
      .describe('For create_document: the kind of document.'),
    title: z.string().trim().min(1).max(500).optional().describe('For create_document: its title.'),
    reference: z
      .string()
      .min(1)
      .optional()
      .describe('For refine_task: the task the person named, in their own words (e.g. "CH-12", "the parser task").'),
    acceptanceCriteria: z
      .array(z.string().min(1))
      .optional()
      .describe('For refine_task: acceptance criteria to add to the task.'),
  })
  .strict()
export type ChatAction = z.infer<typeof ChatActionSchema>

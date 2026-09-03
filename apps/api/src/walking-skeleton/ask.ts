import { ValidationError } from '@chorus/core'
import { withTenant, type DbConfig } from '@chorus/db'
import type { ModelProvider } from '@chorus/llm'
import { route, type AppContext, type RouteDefinition } from '../routes.js'
import { caller } from '../authorisation.js'

/**
 * THE WALKING SKELETON — DELETE IN PHASE 1. See ./README.md.
 *
 * One retrieval call over code chunks, one model call, one streamed reply. No
 * workflow engine, no checkpoints, no sessions, no artefacts. It exists to
 * prove that auth, workspaces, repositories, the index, retrieval, the model
 * layer and streaming are joined up — and for no other reason.
 *
 * plan.md §2.5: "the temptation to keep it is the failure mode."
 */

/** Enough context to answer from, and few enough to stay inside any window. */
const TOP_K = 6

export interface Citation {
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly symbolName: string | null
}

interface RetrievedChunk extends Citation {
  readonly text: string
  readonly commitSha: string | null
}

/**
 * Nearest code chunks by embedding distance.
 *
 * BRAIN-4 will replace this with hybrid lexical-plus-vector search, graph
 * expansion and a permission predicate. This is vector-only and scoped by
 * nothing but the tenancy boundary, which is the minimum that is *correct* —
 * being thin must not mean being unsafe.
 */
async function retrieve(
  config: DbConfig,
  workspaceId: string,
  queryEmbedding: readonly number[],
): Promise<RetrievedChunk[]> {
  return withTenant(
    workspaceId,
    async (tx) => {
      const rows = await tx.query<{
        text: string
        line_start: number
        line_end: number
        symbol_name: string | null
        path: string
        commit_sha: string | null
      }>(
        `SELECT c.text, c.line_start, c.line_end, c.symbol_name, f.path, f.commit_sha
           FROM code_chunks c
           JOIN code_files f ON f.id = c.file_id
          WHERE c.embedding IS NOT NULL
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2`,
        [`[${queryEmbedding.join(',')}]`, TOP_K],
      )

      return rows.map((row) => ({
        text: row.text,
        path: row.path,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        symbolName: row.symbol_name,
        commitSha: row.commit_sha,
      }))
    },
    { config },
  )
}

/**
 * The prompt.
 *
 * Deliberately written here as a string rather than in `workflows/prompts/**`,
 * because a versioned prompt file with a golden fixture (CLAUDE.md §6.5) is a
 * commitment, and this prompt is being deleted. Putting it in the registry
 * would make the skeleton look like something to maintain.
 */
function buildPrompt(question: string, chunks: readonly RetrievedChunk[]): string {
  const context = chunks
    .map(
      (chunk) =>
        `--- ${chunk.path}:${chunk.lineStart}-${chunk.lineEnd}\n${chunk.text}`,
    )
    .join('\n\n')

  return [
    'You are answering a question about a codebase.',
    'Use only the excerpts below. Cite the file paths you used.',
    'If the excerpts do not answer the question, say so.',
    '',
    '# Excerpts',
    context,
    '',
    '# Question',
    question,
  ].join('\n')
}

/** One SSE frame. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export interface SkeletonDeps {
  readonly dbConfig: DbConfig
  readonly models: ModelProvider
}

export function walkingSkeletonRoutes(deps: SkeletonDeps): RouteDefinition[] {
  return [
    route({
      method: 'POST',
      path: '/workspaces/:workspaceId/ask',
      summary: 'WALKING SKELETON (delete in Phase 1): ask one question about the indexed code.',
      auth: { kind: 'workspace', role: 'member', scopes: ['read:artefacts'] },
      handler: async (c: AppContext) => {
        const workspaceId = c.req.param('workspaceId')
        const { userId } = caller(c)
        const body = (await c.req.json().catch(() => ({}))) as { question?: unknown }
        if (typeof body.question !== 'string' || body.question.trim() === '') {
          throw new ValidationError('A question is required', { field: 'question' })
        }
        const question = body.question.trim()

        const [queryEmbedding] = await deps.models.embed([question], {
          provider: deps.models.name,
          model: 'embed',
        })
        const chunks = await retrieve(deps.dbConfig, workspaceId, queryEmbedding ?? [])

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            const send = (event: string, data: unknown): void => {
              controller.enqueue(encoder.encode(frame(event, data)))
            }

            try {
              // The context goes first, and it is exactly what will be sent to
              // the model. CHAT-3 makes that a requirement in Phase 1;
              // asserting it now stops the skeleton establishing the habit of
              // showing one thing and sending another.
              send('context', {
                commitSha: chunks[0]?.commitSha ?? null,
                citations: chunks.map(({ path, lineStart, lineEnd, symbolName }) => ({
                  path,
                  lineStart,
                  lineEnd,
                  symbolName,
                })),
              })

              if (chunks.length === 0) {
                // Nothing retrieved means nothing to answer from. Falling back
                // to the model's general knowledge is how a grounded product
                // quietly becomes a plausible one, so the model is not called
                // at all.
                send('token', {
                  text:
                    'I have no indexed code for this workspace yet, so I cannot answer from your codebase.',
                })
                send('done', {})
                controller.close()
                return
              }

              for await (const event of deps.models.stream({
                model: { provider: deps.models.name, model: 'chat' },
                messages: [{ role: 'user', content: buildPrompt(question, chunks) }],
                context: { workspaceId, teamId: '', purpose: 'chat' },
              })) {
                if (event.type === 'token') send('token', { text: event.text })
                if (event.type === 'error') {
                  // Ended explicitly. A stream that simply stops leaves a
                  // reader waiting forever with no way to tell.
                  send('error', { message: event.message })
                  controller.close()
                  return
                }
                if (event.type === 'done') send('usage', event.usage)
              }

              send('done', { userId })
              controller.close()
            } catch (error) {
              send('error', { message: error instanceof Error ? error.message : String(error) })
              controller.close()
            }
          },
        })

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        })
      },
    }),
  ]
}

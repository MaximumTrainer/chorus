import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { WorkflowDefinitionSchema } from '@chorus/core'
import { createIsolatedDatabase, withTenant, type IsolatedDatabase } from '@chorus/db'
import {
  createAnthropicProvider,
  createOpenAiCompatibleProvider,
  createProviderRegistry,
} from '@chorus/llm'
import { createApp } from '../../src/app.js'
import { createTurnRunner } from '../../src/chat-turn.js'
import {
  createRecordingMailer,
  createTestClient,
  type SignedInUser,
  type TestClient,
} from '@chorus/testing'

/**
 * NFR-2 — a second provider, reached through the same interface.
 *
 * `architecture.md` §9.2 lists Anthropic first among the providers Chorus
 * supports, and §9.1 promises that no caller ever names a model: a purpose
 * resolves to a tier, a tier to a concrete provider and model, and the call
 * goes out through one provider-agnostic interface.
 *
 * Until there were two providers behind that interface, the promise was
 * untestable — and `ref.provider` was decorative, recorded on the ledger but
 * never used to decide which client the call went to. This test is what makes
 * it load-bearing: the same workspace, the same route, the same executor, and a
 * tier that names Anthropic must reach the Anthropic client and bill it there.
 */
describe('NFR-2 Anthropic provider', () => {
  let db: IsolatedDatabase
  let client: TestClient
  let upstream: { requests: Array<{ url: string; body: unknown }> }

  const definition = WorkflowDefinitionSchema.parse({
    name: 'chat-turn',
    version: 1,
    steps: [{ id: 'answer', type: 'model', prompt: 'reply.md' }],
  })

  /**
   * An Anthropic streaming response, in the wire format the SDK parses.
   *
   * Named events, `content_block_delta` carrying the text, and usage split
   * across `message_start` and `message_delta` — the last of which is where a
   * hand-rolled client loses the output token count.
   */
  function anthropicStream(chunks: readonly string[]): string {
    const frames: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_contract_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test-1',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      })}`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}`,
    ]

    for (const text of chunks) {
      frames.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        })}`,
      )
    }

    frames.push(
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 7 },
      })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
    )

    return frames.join('\n\n') + '\n\n'
  }

  /** A scripted Anthropic endpoint that records what it was asked. */
  function scriptedUpstream(chunks: readonly string[]): {
    fetch: typeof fetch
    requests: Array<{ url: string; body: unknown }>
  } {
    const requests: Array<{ url: string; body: unknown }> = []
    const impl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      requests.push({
        url: String(input),
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
      })
      return new Response(anthropicStream(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return { fetch: impl as unknown as typeof fetch, requests }
  }

  async function session(): Promise<{
    ada: SignedInUser
    workspaceId: string
    sessionId: string
  }> {
    const ada = await client.signedInUser()
    const workspace = await ada.createWorkspace('Delivery')
    const teams = (await (await ada.get(`/workspaces/${workspace.id}/teams`)).json()) as Array<{
      id: string
    }>
    const started = (await (
      await ada.post(`/workspaces/${workspace.id}/teams/${teams[0]!.id}/sessions`, {
        entryPoint: 'idea',
        seed: 'Split the invoice parser',
      })
    ).json()) as { id: string }

    return { ada, workspaceId: workspace.id, sessionId: started.id }
  }

  function readTokens(body: string): string {
    return body
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? 'message'
        const data = JSON.parse(/^data:\s*([\s\S]+)$/m.exec(block)?.[1]?.trim() ?? '{}') as {
          text?: string
        }
        return event === 'token' ? (data.text ?? '') : ''
      })
      .join('')
  }

  beforeAll(async () => {
    db = await createIsolatedDatabase()
  }, 120_000)

  afterAll(async () => {
    await db?.drop()
  })

  beforeEach(() => {
    const mailer = createRecordingMailer()
    const scripted = scriptedUpstream(['The parser ', 'does three jobs.'])
    upstream = { requests: scripted.requests }

    // Both providers behind one registry, exactly as a deployment configures
    // them. The registry is itself a `ModelProvider`, so nothing downstream —
    // the turn runner, the executor — learns that there is more than one.
    const models = createProviderRegistry({
      anthropic: createAnthropicProvider({ apiKey: 'test-key', fetch: scripted.fetch }),
      'openai-compatible': createOpenAiCompatibleProvider({
        baseUrl: 'http://models.invalid/v1',
        fetch: (() => {
          throw new Error('a turn routed to Anthropic must not reach the OpenAI-compatible client')
        }) as unknown as typeof fetch,
      }),
    })

    client = createTestClient(
      createApp({
        dbConfig: db.config,
        mailer,
        turn: createTurnRunner(db.config, {
          models,
          modelFor: () => ({ provider: 'anthropic', model: 'claude-test-1' }),
          definition,
        }),
      }),
      mailer,
    )
  })

  it('NFR-2 AC4: a workspace whose tier names an Anthropic model streams a turn from the Anthropic client', async () => {
    // Given a session in a workspace whose resolved tier names Anthropic
    const { ada, workspaceId, sessionId } = await session()

    // When a message is posted
    const response = await ada.post(`/workspaces/${workspaceId}/sessions/${sessionId}/messages`, {
      text: 'What does the invoice parser do?',
    })

    // Then the reply streams back, assembled from the Anthropic wire format
    expect(response.status, await response.clone().text()).toBe(200)
    expect(readTokens(await response.text())).toContain('does three jobs.')

    // and it was the Anthropic endpoint that served it — not the other client
    // silently standing in, which is the failure this test exists to catch.
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]!.url).toContain('/v1/messages')
    expect(upstream.requests[0]!.body).toMatchObject({ model: 'claude-test-1', stream: true })
  })

  it('NFR-2 AC4: the spend ledger attributes the call to the provider that served it', async () => {
    // Given a turn served by Anthropic
    const { ada, workspaceId, sessionId } = await session()
    const response = await ada.post(
      `/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
      { text: 'What does the invoice parser do?' },
    )
    // Drained to completion rather than slept on: the ledger row is written as
    // the stream is consumed, so reading it before the body ends races the run.
    expect(readTokens(await response.text())).toContain('does three jobs.')

    // When the ledger is read
    const rows = await withTenant(
      workspaceId,
      async (t) =>
        t.query(
          `SELECT provider, model, tokens_in, tokens_out FROM spend_ledger
             WHERE workspace_id = $1`,
          [workspaceId],
        ),
      { config: db.config },
    )

    // Then the row names Anthropic and the model it actually called, and
    // carries the usage the stream reported — a run whose cost cannot be
    // attributed to a provider cannot be budgeted or capped (NFR-8).
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test-1',
      tokens_in: 11,
      tokens_out: 7,
    })
  })
})

/**
 * A live check of the CHAT-6 plan-action prompt against a real model.
 *
 * The suite must not call a real model (CLAUDE.md §4). This verifies what it
 * cannot: that the shipped `shape/plan-action` prompt, sent to an actual model
 * with the `chat_action` schema, picks the right action for each instruction.
 * Run by hand with a key; the key is read from the env or `.env`, never logged.
 *
 *   tsx scripts/smoke-chat-action.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChatActionSchema } from '@chorus/core'
import { createAnthropicProvider, loadPromptDirectory, fillPrompt } from '@chorus/llm'

function apiKey(): string {
  const fromEnv = process.env.CHORUS_ANTHROPIC_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const env = readFileSync(join(process.cwd(), '.env'), 'utf8')
  for (const line of env.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at !== -1 && line.slice(0, at).trim() === 'claude-key') return line.slice(at + 1).trim()
  }
  throw new Error('No key: set CHORUS_ANTHROPIC_API_KEY, or a `claude-key=` line in .env.')
}

const MODEL = process.env.CHORUS_SMOKE_ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5'

async function main(): Promise<void> {
  const provider = createAnthropicProvider({ apiKey: apiKey() })
  const template = loadPromptDirectory(join(process.cwd(), 'workflows', 'prompts')).get('shape/plan-action')
  const gather = '{ "fragments": [ { "kind": "task", "key": "CH-12", "title": "Split the invoice parser" } ] }'

  const cases = [
    { text: 'write a PRD for billing', expect: 'create_document' },
    { text: 'add acceptance criteria to CH-12: parsing is separated from validation', expect: 'refine_task' },
    { text: 'what does the invoice parser do?', expect: 'answer' },
  ] as const

  let ok = true
  for (const testCase of cases) {
    const body = fillPrompt({ id: 'shape/plan-action', body: template.body }, { text: testCase.text, gather }).text
    const result = await provider.generate({
      model: { provider: 'anthropic', model: MODEL },
      messages: [{ role: 'user', content: body }],
      context: { workspaceId: 'smoke', teamId: 'smoke', purpose: 'chat' },
      schema: ChatActionSchema,
      schemaName: 'chat_action',
    })
    const pass = result.value.action === testCase.expect
    ok = ok && pass
    console.log(
      `${pass ? 'PASS' : 'FAIL'} "${testCase.text}" -> ${result.value.action}` +
        (result.value.reference ? ` (ref: ${result.value.reference})` : '') +
        (result.value.documentType ? ` (${result.value.documentType})` : ''),
    )
  }
  if (!ok) process.exitCode = 1
}

await main()

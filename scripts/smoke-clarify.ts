/**
 * A live check of the CHAT-4 clarify prompt against a real model.
 *
 * The test suite must never call a real model (CLAUDE.md §4), so this verifies
 * the thing the suite cannot: that the shipped clarify prompt, sent to an actual
 * model with the clarification schema, draws questions for a vague idea and
 * none for a specific one. It is run by hand with a key, not in CI.
 *
 * The key is read from the environment, or from a `claude-key=` line in `.env`.
 * It is used to build the provider and is never printed — only the question
 * counts and subjects are.
 *
 *   CHORUS_ANTHROPIC_API_KEY=sk-ant-... tsx scripts/smoke-clarify.ts
 *   # or, with the key in .env as `claude-key=...`:
 *   tsx scripts/smoke-clarify.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClarificationSchema } from '@chorus/core'
import { createAnthropicProvider, loadPromptDirectory, fillPrompt } from '@chorus/llm'

/** The key, from the environment or the `.env` line, without ever logging it. */
function apiKey(): string {
  const fromEnv = process.env.CHORUS_ANTHROPIC_API_KEY?.trim()
  if (fromEnv) return fromEnv
  try {
    const env = readFileSync(join(process.cwd(), '.env'), 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const at = line.indexOf('=')
      if (at === -1) continue
      if (line.slice(0, at).trim() === 'claude-key') return line.slice(at + 1).trim()
    }
  } catch {
    // Fall through to the error below.
  }
  throw new Error('No key: set CHORUS_ANTHROPIC_API_KEY, or a `claude-key=` line in .env.')
}

const MODEL = process.env.CHORUS_SMOKE_ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5'

async function main(): Promise<void> {
  const provider = createAnthropicProvider({ apiKey: apiKey() })
  const prompts = loadPromptDirectory(join(process.cwd(), 'workflows', 'prompts'))
  const template = prompts.get('shape/clarify')

  const cases = [
    { label: 'vague', text: 'make our app better', expect: (n: number) => n >= 1 },
    {
      label: 'specific',
      text: 'Rename getUser to loadUser in src/users.ts and update its three callers.',
      expect: (n: number) => n === 0,
    },
  ]

  let ok = true
  for (const testCase of cases) {
    const body = fillPrompt(
      { id: 'shape/clarify', body: template.body },
      { text: testCase.text, answers: '(none yet)', gather: '(nothing indexed)' },
    ).text

    const result = await provider.generate({
      model: { provider: 'anthropic', model: MODEL },
      messages: [{ role: 'user', content: body }],
      context: { workspaceId: 'smoke', teamId: 'smoke', purpose: 'chat' },
      schema: ClarificationSchema,
      schemaName: 'clarification',
    })

    const subjects = result.value.questions.map((q) => q.about)
    const pass = testCase.expect(subjects.length)
    ok = ok && pass
    console.log(
      `${pass ? 'PASS' : 'FAIL'} [${testCase.label}] ${subjects.length} question(s): ${subjects.join(', ') || '—'}`,
    )
  }

  if (!ok) process.exitCode = 1
}

await main()

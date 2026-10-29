import { describe, it, expect } from 'vitest'
import { createClarifyTool } from './clarify.js'

const ctx = {
  workspaceId: 'w',
  teamId: 't',
  runId: 'r',
  actor: { userId: 'u', role: 'member' as const },
  now: () => new Date(0),
}

const q = (about: string) => ({ id: about, about, question: `What about ${about}?`, choices: [] })

describe('CHAT-4 clarify tool', () => {
  const tool = createClarifyTool()

  it('CHAT-4: asks the bounded questions, and says not to proceed', async () => {
    const out = await tool.execute(
      { clarification: { questions: [q('a'), q('b'), q('c'), q('d')] }, known: [], budget: 3 },
      ctx,
    )
    expect(out.asked).toBe(true)
    expect(out.ok).toBe(false)
    expect(out.questions.map((each) => each.about)).toEqual(['a', 'b', 'c'])
  })

  it('CHAT-4: with nothing to ask, it says to proceed', async () => {
    const out = await tool.execute({ clarification: { questions: [] }, known: [], budget: 3 }, ctx)
    expect(out).toMatchObject({ ok: true, asked: false, questions: [] })
  })

  it('CHAT-4: a question about a known subject is not asked', async () => {
    const out = await tool.execute(
      { clarification: { questions: [q('repository')] }, known: ['repository'], budget: 3 },
      ctx,
    )
    expect(out).toMatchObject({ ok: true, asked: false })
  })
})

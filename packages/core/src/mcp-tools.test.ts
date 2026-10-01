import { describe, it, expect } from 'vitest'
import {
  MCP_TOOLS,
  mcpToolInputSchema,
  parseMcpToolArguments,
  type McpToolName,
} from './mcp-tools.js'

/**
 * MCP-2 — the read tools' contract with the agents that call them.
 *
 * A tool's input schema is a published interface: an agent that learned it
 * yesterday calls it the same way today. It is snapshotted, as CLAUDE.md §5
 * allows for MCP tool schemas, so a change to one is a reviewed diff rather
 * than a surprise.
 */

const names = Object.keys(MCP_TOOLS) as McpToolName[]

describe('MCP-2 and MCP-3 tool definitions', () => {
  it('MCP-2: the input schemas are a stable, reviewed contract', () => {
    expect(Object.fromEntries(names.map((name) => [name, mcpToolInputSchema(name)]))).toMatchSnapshot()
  })

  it('MCP-2: every input schema is an object that refuses arguments it does not know', () => {
    for (const name of names) {
      const schema = mcpToolInputSchema(name)
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties, name).toBe(false)
    }
  })

  it('MCP-2: a malformed argument is named, with what was expected', () => {
    const result = parseMcpToolArguments('get_task', { taskId: 42 })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.problem).toMatch(/^taskId: .*string/)
  })

  it('MCP-2: an argument the tool does not take is refused rather than ignored', () => {
    const result = parseMcpToolArguments('get_task', { taskId: 't', teamId: 'x' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.problem).toContain('teamId')
  })

  it('MCP-2: a page limit above the maximum is refused', () => {
    expect(parseMcpToolArguments('list_tasks', { teamId: 't', limit: 101 }).ok).toBe(false)
    expect(parseMcpToolArguments('list_tasks', { teamId: 't', limit: 100 }).ok).toBe(true)
  })

  it('MCP-3: every create takes an idempotency key, and an update does not need one', () => {
    for (const name of names) {
      const properties = Object.keys(mcpToolInputSchema(name).properties as object)
      expect(properties.includes('idempotencyKey'), name).toBe(name.startsWith('create_'))
    }
  })

  it('MCP-3: create_task takes exactly the fields the API does, plus where to put it', () => {
    expect(parseMcpToolArguments('create_task', { teamId: 't', title: 'x', estimate: 3 })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('estimate'),
    })
    expect(parseMcpToolArguments('create_task', { teamId: 't', title: 'x', priority: 'high' }).ok).toBe(true)
  })
})

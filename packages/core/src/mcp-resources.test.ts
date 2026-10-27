import { describe, it, expect } from 'vitest'
import {
  MCP_PROMPTS,
  missingPromptArguments,
  parseResourceUri,
  resourceUri,
  taskToMarkdown,
  withFrontMatter,
} from './mcp-resources.js'
import type { TaskRecord } from './tasks.js'

const task: TaskRecord = {
  id: 't1',
  key: 'CH-4',
  teamId: 'team',
  parentId: null,
  title: 'Split the invoice parser',
  description: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Parsing and validation are tangled.' }] }],
  },
  acceptanceCriteria: [
    { id: 'a', text: 'Parsing is separated from validation', checked: true },
    { id: 'b', text: 'Errors name the field', checked: false },
  ],
  tags: ['billing'],
  status: 'todo',
  priority: 'normal',
  size: null,
  assigneeId: null,
  position: 1,
  createdBy: 'u',
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
}

describe('MCP-4 resource URIs and Markdown', () => {
  it('MCP-4: parses the two resource kinds this server serves, and nothing else', () => {
    expect(parseResourceUri('chorus://task/t1')).toEqual({ kind: 'task', id: 't1' })
    expect(parseResourceUri('chorus://doc/d%2F1')).toEqual({ kind: 'doc', id: 'd/1' })
    for (const uri of ['chorus://wiki/home', 'chorus://task/', 'chorus://task/a/b', 'https://x/task/1', 'chorus://task/%E0']) {
      expect(parseResourceUri(uri), uri).toBeUndefined()
    }
    expect(parseResourceUri(resourceUri('doc', 'd/1'))).toEqual({ kind: 'doc', id: 'd/1' })
  })

  it('MCP-4: free text in front-matter is quoted, so a colon cannot start a new key', () => {
    const text = withFrontMatter(
      [
        ['id', 't1', 'plain'],
        ['title', 'Fix: the parser\nkind: forged', 'text'],
      ],
      'body',
    )

    expect(text).toBe('---\nid: t1\ntitle: "Fix: the parser\\nkind: forged"\n---\n\nbody')
  })

  it('MCP-4: a task renders its description, tags and criteria as a checklist', () => {
    expect(taskToMarkdown(task)).toBe(
      '# CH-4 — Split the invoice parser\n\n' +
        'Parsing and validation are tangled.\n\n' +
        'Tags: billing\n\n' +
        '## Acceptance criteria\n\n' +
        '- [x] Parsing is separated from validation\n' +
        '- [ ] Errors name the field\n',
    )
  })

  it('MCP-4: a missing required prompt argument is named', () => {
    const implement = MCP_PROMPTS.find((prompt) => prompt.name === 'implement-task')!

    expect(missingPromptArguments(implement, {})).toEqual(['taskId'])
    expect(missingPromptArguments(implement, { taskId: '  ' })).toEqual(['taskId'])
    expect(missingPromptArguments(implement, { taskId: 't1' })).toEqual([])
  })
})

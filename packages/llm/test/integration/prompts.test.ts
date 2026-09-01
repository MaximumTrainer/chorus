import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPromptDirectory, parsePrompt, renderPrompt, PromptError } from '../../src/index.js'

const withPromptDir = (files: Record<string, string>, fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'chorus-prompts-'))
  try {
    for (const [name, body] of Object.entries(files)) {
      const full = join(dir, name)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body, 'utf8')
    }
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const valid = `---
id: decompose-tasks/propose
version: 3
description: Propose a task tree from a document and its retrieved context.
inputs: [document, context]
---
You are shaping work for {{team}}.

{{context}}
`

/**
 * NFR-2 AC4 — prompts are versioned files, not string literals in code.
 *
 * A prompt is the most behaviour-changing thing in the system and the least
 * visible in a diff. Making it a file with a recorded hash is what turns a
 * prompt change into a reviewable change (NFR-11 AC2).
 */
describe('NFR-2 AC4 prompt registry', () => {
  it('NFR-2 AC4: a prompt carries an id, a version and a body', () => {
    const prompt = parsePrompt('decompose-tasks/propose.md', valid)
    expect(prompt.id).toBe('decompose-tasks/propose')
    expect(prompt.version).toBe(3)
    expect(prompt.inputs).toEqual(['document', 'context'])
    expect(prompt.body).toContain('You are shaping work for')
  })

  it('NFR-2 AC4: the hash is stable across loads, so a run can pin the exact template', () => {
    const a = parsePrompt('x.md', valid)
    const b = parsePrompt('x.md', valid)
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('NFR-2 AC4: changing the body changes the hash, so a silent edit is impossible', () => {
    const original = parsePrompt('x.md', valid)
    const edited = parsePrompt('x.md', valid.replace('shaping work', 'shaping WORK'))
    expect(edited.hash).not.toBe(original.hash)
  })

  it('NFR-2 AC4: front-matter changes also change the hash', () => {
    const original = parsePrompt('x.md', valid)
    const bumped = parsePrompt('x.md', valid.replace('version: 3', 'version: 4'))
    expect(bumped.hash).not.toBe(original.hash)
  })

  it('NFR-2 AC4: a prompt without front-matter is rejected at load, not at run time', () => {
    expect(() => parsePrompt('x.md', 'just a body')).toThrow(PromptError)
  })

  it('NFR-2 AC4: a prompt missing id or version is rejected, naming what is missing', () => {
    expect(() => parsePrompt('x.md', `---\nversion: 1\n---\nbody`)).toThrow(/id/)
    expect(() => parsePrompt('x.md', `---\nid: a/b\n---\nbody`)).toThrow(/version/)
  })

  it('NFR-2 AC4: a non-integer version is rejected — versions are pinned, not approximate', () => {
    expect(() => parsePrompt('x.md', `---\nid: a/b\nversion: "1.2"\n---\nbody`)).toThrow(/version/)
  })

  it('NFR-2 AC4: an empty body is rejected, because an empty prompt fails silently at the model', () => {
    expect(() => parsePrompt('x.md', `---\nid: a/b\nversion: 1\n---\n\n   \n`)).toThrow(/body/)
  })

  it('NFR-2 AC4: a directory of prompts loads and is addressable by id', () => {
    withPromptDir(
      {
        'decompose-tasks/propose.md': valid,
        'shape-idea/reply.md': `---\nid: shape-idea/reply\nversion: 1\n---\nHello {{name}}\n`,
      },
      (dir) => {
        const registry = loadPromptDirectory(dir)
        expect(registry.ids().sort()).toEqual(['decompose-tasks/propose', 'shape-idea/reply'])
        expect(registry.get('shape-idea/reply').version).toBe(1)
      },
    )
  })

  it('NFR-2 AC4: an id that does not match its path is rejected, so ids cannot drift from files', () => {
    withPromptDir({ 'a/b.md': `---\nid: totally/different\nversion: 1\n---\nbody\n` }, (dir) => {
      expect(() => loadPromptDirectory(dir)).toThrow(/does not match/)
    })
  })

  it('NFR-2 AC4: requesting an unknown prompt fails loudly, listing what exists', () => {
    withPromptDir({ 'a/b.md': `---\nid: a/b\nversion: 1\n---\nbody\n` }, (dir) => {
      const registry = loadPromptDirectory(dir)
      expect(() => registry.get('a/missing')).toThrow(/a\/b/)
    })
  })
})

describe('NFR-2 AC4 prompt rendering', () => {
  it('NFR-2 AC4: placeholders are substituted', () => {
    const prompt = parsePrompt('x.md', `---\nid: a/b\nversion: 1\n---\nHello {{name}}, welcome.\n`)
    expect(renderPrompt(prompt, { name: 'Ada' })).toContain('Hello Ada, welcome.')
  })

  it('NFR-2 AC4: a missing placeholder value fails rather than rendering "undefined" into a prompt', () => {
    const prompt = parsePrompt('x.md', `---\nid: a/b\nversion: 1\n---\nHello {{name}}\n`)
    expect(() => renderPrompt(prompt, {})).toThrow(/name/)
  })

  it('NFR-2 AC4: an unused value is rejected, because it usually means a renamed placeholder', () => {
    const prompt = parsePrompt('x.md', `---\nid: a/b\nversion: 1\n---\nHello {{name}}\n`)
    expect(() => renderPrompt(prompt, { name: 'Ada', stale: 'x' })).toThrow(/stale/)
  })
})

describe('NFR-2 AC4 prompt directory conventions', () => {
  it('NFR-2 AC4: README.md and _-prefixed files are documentation, not prompts', () => {
    withPromptDir(
      {
        'README.md': '# How to write a prompt\n\nNo front-matter here.\n',
        '_shared/notes.md': 'Scratch notes, deliberately not a prompt.\n',
        'a/b.md': `---\nid: a/b\nversion: 1\n---\nbody\n`,
      },
      (dir) => {
        // Would throw on the two documentation files if they were treated as prompts.
        expect(loadPromptDirectory(dir).ids()).toEqual(['a/b'])
      },
    )
  })
})

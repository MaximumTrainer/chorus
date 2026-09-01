import { describe, it, expect } from 'vitest'
import {
  checkBoundaries,
  extractImports,
  CHORUS_BOUNDARY_RULES,
  type SourceFile,
  type BoundaryRule,
} from './boundaries.js'

const file = (path: string, text: string): SourceFile => ({ path, text })

/**
 * The rule engine is what makes test/nfr/boundaries.test.ts meaningful. If the
 * engine could not detect a violation, a green boundary suite would prove
 * nothing. These fixtures are deliberately known-bad.
 */
describe('NFR-2 boundary rule engine', () => {
  describe('import extraction', () => {
    it('NFR-2: finds static, dynamic, re-exported and required specifiers', () => {
      const source = `
        import OpenAI from 'openai'
        import { a } from "./local.js"
        import 'side-effect-only'
        export { b } from '@chorus/core'
        const c = await import('ollama')
        const d = require('pg')
      `
      expect(extractImports(source).sort()).toEqual(
        ['./local.js', '@chorus/core', 'ollama', 'openai', 'pg', 'side-effect-only'].sort(),
      )
    })

    it('NFR-2: does not mistake a similarly named local path for a package', () => {
      expect(extractImports(`import x from './openai-adapter.js'`)).toEqual(['./openai-adapter.js'])
    })
  })

  describe('provider SDK containment', () => {
    const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('no provider SDK'))!

    it('NFR-2 AC1: flags a provider SDK imported by a feature package', () => {
      const violations = checkBoundaries(
        [file('packages/agent/src/run.ts', `import Anthropic from '@anthropic-ai/sdk'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]!.file).toBe('packages/agent/src/run.ts')
      expect(violations[0]!.detail).toContain('@anthropic-ai/sdk')
    })

    it('NFR-2 AC1: flags a provider SDK imported by an app', () => {
      const violations = checkBoundaries(
        [file('apps/api/src/chat.ts', `import { openai } from '@ai-sdk/openai'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
    })

    it('NFR-2 AC1: permits provider SDKs inside packages/llm, which is the point', () => {
      const violations = checkBoundaries(
        [file('packages/llm/src/providers/anthropic.ts', `import Anthropic from '@anthropic-ai/sdk'`)],
        [rule],
      )
      expect(violations).toEqual([])
    })
  })

  describe('model name containment', () => {
    const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('no concrete model name'))!

    it('NFR-2: flags a hard-coded model identifier in feature code', () => {
      const violations = checkBoundaries(
        [file('packages/agent/src/classify.ts', `const model = "gpt-4o-mini"`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
      expect(violations[0]!.detail).toContain('gpt-4o-mini')
    })

    it('NFR-2: ignores model names in comments, which are documentation not configuration', () => {
      const violations = checkBoundaries(
        [
          file(
            'packages/agent/src/classify.ts',
            `// historically this used gpt-4o-mini\n/* and claude-3-5-sonnet */\nconst m = resolve('classify')`,
          ),
        ],
        [rule],
      )
      expect(violations).toEqual([])
    })

    it('NFR-2: does not flag ordinary prose that merely resembles a version', () => {
      const violations = checkBoundaries(
        [file('packages/agent/src/step.ts', `const label = 'step-3 of the pipeline'`)],
        [rule],
      )
      expect(violations).toEqual([])
    })
  })

  describe('database driver containment', () => {
    const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('no database driver'))!

    it('NFR-3 AC3: flags a raw driver import outside packages/db', () => {
      const violations = checkBoundaries(
        [file('apps/api/src/tasks.ts', `import { Pool } from 'pg'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
    })

    it('NFR-3 AC3: permits the driver inside packages/db', () => {
      const violations = checkBoundaries(
        [file('packages/db/src/pool.ts', `import { Pool } from 'pg'`)],
        [rule],
      )
      expect(violations).toEqual([])
    })
  })

  describe('layering', () => {
    it('architecture.md §7: flags packages/core importing a feature package', () => {
      const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('core depends on nothing'))!
      const violations = checkBoundaries(
        [file('packages/core/src/task.ts', `import { retrieve } from '@chorus/brain'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
    })

    it('architecture.md §7: permits packages/core importing shared config', () => {
      const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('core depends on nothing'))!
      const violations = checkBoundaries(
        [file('packages/core/src/task.ts', `import preset from '@chorus/config'`)],
        [rule],
      )
      expect(violations).toEqual([])
    })

    it('architecture.md §7: flags a package importing an app', () => {
      const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('never import from apps'))!
      const violations = checkBoundaries(
        [file('packages/brain/src/x.ts', `import { app } from '@chorus/api'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
    })

    it('architecture.md §7: flags llm reaching upward into a feature package', () => {
      const rule = CHORUS_BOUNDARY_RULES.find((r) => r.id.includes('db and llm depend only on core'))!
      const violations = checkBoundaries(
        [file('packages/llm/src/router.ts', `import { x } from '@chorus/agent'`)],
        [rule],
      )
      expect(violations).toHaveLength(1)
    })
  })

  describe('rule hygiene', () => {
    it('NFR-2: every rule states why it exists, because a rule nobody understands gets deleted', () => {
      for (const rule of CHORUS_BOUNDARY_RULES) {
        expect(rule.rationale.length, `${rule.id} needs a rationale`).toBeGreaterThan(40)
      }
    })

    it('NFR-2: every rule forbids something', () => {
      for (const rule of CHORUS_BOUNDARY_RULES) {
        const forbids = (rule.forbidImports?.length ?? 0) + (rule.forbidContent?.length ?? 0)
        expect(forbids, `${rule.id} forbids nothing`).toBeGreaterThan(0)
      }
    })

    it('NFR-2: a clean file trips no rule', () => {
      const clean: SourceFile[] = [
        file('packages/agent/src/run.ts', `import { generate } from '@chorus/llm'\nexport const run = () => generate({ purpose: 'classify' })`),
        file('packages/llm/src/router.ts', `import Anthropic from '@anthropic-ai/sdk'`),
        file('packages/db/src/pool.ts', `import { Pool } from 'pg'`),
      ]
      expect(checkBoundaries(clean, CHORUS_BOUNDARY_RULES)).toEqual([])
    })
  })

  describe('scoping', () => {
    it('NFR-2: a rule ignores files outside its scope', () => {
      const rule: BoundaryRule = {
        id: 'test',
        rationale: 'x'.repeat(50),
        appliesTo: /^packages\/core\//,
        forbidImports: [/^forbidden$/],
      }
      expect(checkBoundaries([file('packages/other/src/a.ts', `import 'forbidden'`)], [rule])).toEqual([])
    })
  })
})

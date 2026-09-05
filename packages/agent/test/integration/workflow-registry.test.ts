import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { builtInWorkflows, loadWorkflowDirectory } from '../../src/definitions.js'

/**
 * AGENT-1 AC1 — definitions are validated at load.
 *
 * > **Then** it fails at startup with a message naming the workflow and the
 * > problem — never at run time.
 *
 * "Never at run time" is the requirement, and the reason is in the order things
 * happen: a workflow that dies at step four because step four names a tool that
 * does not exist has already run steps one to three, and one of those may have
 * written something. A definition is data, and data that is wrong should be
 * caught while it is still only data.
 *
 * `validateDefinition` in `core` already proves the individual checks. What this
 * suite is about is the *loader*: that the shipped set is actually loaded and
 * actually checked against the real tools and the real prompt files, and that
 * the process refuses to start rather than carrying a broken workflow to the
 * first person who triggers it.
 */
describe('AGENT-1 workflow registry', () => {
  let root: string

  const sound = {
    name: 'sound-flow',
    version: 1,
    steps: [{ id: 'write', type: 'emit', artefact: 'prd' }],
  }

  function put(name: string, definition: unknown): void {
    writeFileSync(join(root, `${name}.yaml`), JSON.stringify(definition), 'utf8')
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chorus-workflows-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('AGENT-1 AC1: a definition naming an unregistered tool fails at load', () => {
    put('bad', { ...sound, tools: ['delete_everything'] })

    // Naming both, because the person reading this message has a directory of
    // workflows and needs to know which file to open.
    expect(() => loadWorkflowDirectory(root, { tools: [], prompts: [] })).toThrow(
      /bad-flow|sound-flow/,
    )
    expect(() => loadWorkflowDirectory(root, { tools: [], prompts: [] })).toThrow(
      /delete_everything/,
    )
  })

  it('AGENT-1 AC1: a definition naming a prompt file that is not there fails at load', () => {
    put('bad', {
      ...sound,
      steps: [{ id: 'think', type: 'model', prompt: 'shaping/absent' }],
    })

    expect(() => loadWorkflowDirectory(root, { tools: [], prompts: [] })).toThrow(
      /shaping\/absent/,
    )
  })

  it('AGENT-1 AC1: every problem across every file is reported at once', () => {
    put('one', { ...sound, name: 'one-flow', tools: ['missing_a'] })
    put('two', { ...sound, name: 'two-flow', tools: ['missing_b'] })

    // A loader that threw on the first bad file would make fixing a directory
    // of workflows a restart-per-typo exercise, which is the experience this
    // exists to prevent.
    let message = ''
    try {
      loadWorkflowDirectory(root, { tools: [], prompts: [] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/missing_a/)
    expect(message).toMatch(/missing_b/)
  })

  it('AGENT-1 AC1: a file that is not a workflow at all fails loudly, not silently', () => {
    writeFileSync(join(root, 'broken.yaml'), 'name: 3\nversion: "one"\n', 'utf8')

    // Skipping anything that fails to parse would mean a workflow with a typo
    // in it simply stops existing, and the first symptom is a router that
    // cannot find it.
    expect(() => loadWorkflowDirectory(root, { tools: [], prompts: [] })).toThrow(/broken/)
  })

  it('AGENT-1 AC1: a README beside the definitions is not mistaken for one', () => {
    put('sound', sound)
    writeFileSync(join(root, 'README.md'), '# Workflows\n', 'utf8')
    mkdirSync(join(root, '_drafts'))
    writeFileSync(join(root, '_drafts', 'wip.yaml'), 'nonsense: true\n', 'utf8')

    // Documentation lives with the thing it documents. Excluded by an explicit
    // rule rather than by ignoring parse failures, which would hide the case
    // above.
    const registry = loadWorkflowDirectory(root, { tools: [], prompts: [] })
    expect(registry.names()).toEqual(['sound-flow'])
  })

  it('AGENT-1 AC4: a version is addressable, and the latest is the highest', () => {
    put('v1', { ...sound, version: 1 })
    put('v3', { ...sound, version: 3 })
    put('v2', { ...sound, version: 2 })

    const registry = loadWorkflowDirectory(root, { tools: [], prompts: [] })
    // A run pins the version it started with, so an old version has to stay
    // reachable by number after a new one is published.
    expect(registry.get('sound-flow', 1).version).toBe(1)
    expect(registry.get('sound-flow', 3).version).toBe(3)
    // Highest, not last-loaded: directory order is not a fact about versions.
    expect(registry.latest('sound-flow').version).toBe(3)
  })

  it('AGENT-1 AC1: the same name at the same version twice is refused', () => {
    put('a', sound)
    put('b', sound)

    // Whichever loaded last would win, and which one that is depends on
    // filesystem order — a difference between machines that nothing reports.
    expect(() => loadWorkflowDirectory(root, { tools: [], prompts: [] })).toThrow(
      /sound-flow@1|more than once|twice/i,
    )
  })

  it('AGENT-1 AC1: asking for a workflow that was never loaded says so', () => {
    put('sound', sound)
    const registry = loadWorkflowDirectory(root, { tools: [], prompts: [] })

    expect(() => registry.latest('imaginary-flow')).toThrow(/imaginary-flow/)
    expect(() => registry.get('sound-flow', 9)).toThrow(/sound-flow/)
  })

  it('AGENT-1 AC1: the workflows this repository ships load against the real tools and prompts', () => {
    // The gate that keeps the shipped set honest. Everything above tests the
    // loader with fixtures; this one tests the actual files, against the actual
    // tool registry and the actual prompt directory, which is the check that
    // would have caught a renamed prompt before a user did.
    const registry = builtInWorkflows()

    expect(registry.names().length).toBeGreaterThan(0)
  })
})

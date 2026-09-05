import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * The project website.
 *
 * A site that describes a project is a claim about that project, and a claim
 * nothing checks is one that quietly stops being true. So the figures it shows
 * are generated from the repository rather than typed, and this suite asserts
 * that what the page says still matches what the repository contains.
 *
 * The specific failure being guarded against: a contributor adds a route, or a
 * suite grows, and the front page keeps advertising last month's numbers to
 * everyone evaluating whether to trust the project.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const BUILD = join(ROOT, 'website', 'build.mjs')

interface Status {
  tests: { byLayer: Array<{ name: string; total: number }>; total: number }
  routes: Array<{ method: string; path: string; auth: { kind: string; role?: string } }>
  requirements: { total: number; must: number; withPassingTests: number; ids: string[] }
}

describe('the project website', () => {
  let html: string
  let status: Status

  beforeAll(() => {
    // Built into a throwaway directory: the site is a build artefact, and a
    // committed one drifts from its sources the first time someone edits either.
    const out = mkdtempSync(join(tmpdir(), 'chorus-site-'))
    execFileSync(process.execPath, [BUILD, '--out', out], { cwd: ROOT, stdio: 'pipe' })
    html = readFileSync(join(out, 'index.html'), 'utf8')
    status = JSON.parse(
      readFileSync(join(ROOT, 'website', 'src', 'status.json'), 'utf8'),
    ) as Status
  }, 120_000)

  it('builds a single self-contained page', () => {
    expect(html).toContain('<!doctype html>')
    expect(html).toMatch(/<html[^>]+lang="en"/)
    expect((html.match(/<h1[\s>]/g) ?? []).length, 'exactly one h1 per page').toBe(1)
  })

  it('depends on no external host, so it cannot break or leak on someone else’s outage', () => {
    // Also a privacy property: a visitor to the project page is not announced
    // to a third party they did not choose.
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!)
    const remoteAssets = external.filter(
      (url) => /\.(js|css|woff2?|ttf)(\?|$)/.test(url) || url.includes('fonts.googleapis'),
    )
    expect(remoteAssets, 'every asset must be inlined or local').toEqual([])
  })

  it('every internal anchor points at something that exists on the page', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!))
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!)
    expect(anchors.length, 'the page should have navigation').toBeGreaterThan(0)
    for (const anchor of anchors) {
      expect(ids.has(anchor), `#${anchor} is linked but no element has that id`).toBe(true)
    }
  })

  it('states the real test count, not a remembered one', () => {
    expect(status.tests.total).toBeGreaterThan(0)
    expect(html).toContain(String(status.tests.total))
  })

  it('states the real route count and the real requirement totals', () => {
    expect(html).toContain(String(status.routes.length))
    expect(html).toContain(String(status.requirements.total))
  })

  it('claims a requirement is proven only where a test names it', () => {
    // The catalogue has 116 requirements and almost none are built. A site that
    // blurred "has a test" into "is done" would be the most damaging kind of
    // inaccuracy here, because it is the one a reader cannot check quickly.
    expect(status.requirements.withPassingTests).toBe(status.requirements.ids.length)
    expect(status.requirements.withPassingTests).toBeLessThan(status.requirements.total)
    for (const id of status.requirements.ids) {
      expect(html, `${id} is proven but not shown`).toContain(id)
    }
  })

  it('shows only transcripts that were really recorded against the running system', () => {
    const transcripts = JSON.parse(
      readFileSync(join(ROOT, 'website', 'src', 'transcripts.json'), 'utf8'),
    ) as { exchanges: Array<{ title: string; steps: Array<{ status: number }> }> }

    expect(transcripts.exchanges.length).toBeGreaterThan(0)
    for (const exchange of transcripts.exchanges) {
      expect(html, `"${exchange.title}" is recorded but not shown`).toContain(exchange.title)
    }

    // A demo page that only ever shows success is a brochure. The refusals are
    // the interesting part of this system, so at least one must be on display.
    const statuses = transcripts.exchanges.flatMap((e) => e.steps.map((s) => s.status))
    expect(statuses.some((code) => code >= 400), 'show a refusal, not only happy paths').toBe(true)
  })

  it('says plainly how little of the interface exists', () => {
    // The one claim a reader is most likely to assume and most likely to be
    // wrong about. Counted rather than trusted, so a second screen makes this
    // page's sentence false loudly rather than quietly.
    expect(screens(), 'a screen was added or removed — update this page').toEqual(SCREENS_TODAY)
    expect(html.toLowerCase()).toMatch(
      /interface is one screen|no (user interface|web (app|interface))/,
    )
  })

  it('points contributors at the rules the project actually enforces', () => {
    for (const link of ['CONTRIBUTING.md', 'CLAUDE.md', 'architecture.md']) {
      expect(html, `the page should link ${link}`).toContain(link)
    }
  })

  it('is deployed by a workflow that builds from source', () => {
    const workflowPath = join(ROOT, '.github', 'workflows', 'pages.yml')
    expect(existsSync(workflowPath), 'a deploy workflow must exist').toBe(true)

    const workflow = parse(readFileSync(workflowPath, 'utf8')) as {
      on: Record<string, unknown>
      permissions: Record<string, string>
      jobs: Record<string, { steps: Array<{ uses?: string; run?: string }> }>
    }

    // Least privilege: Pages deployment needs exactly these, and a workflow
    // with blanket write access to the repository is a supply-chain risk for a
    // marketing page.
    expect(workflow.permissions).toMatchObject({ contents: 'read', pages: 'write' })

    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
    expect(
      steps.some((step) => step.run?.includes('website/build.mjs')),
      'the workflow must build the site rather than publish a committed copy',
    ).toBe(true)
    expect(steps.some((step) => step.uses?.startsWith('actions/deploy-pages'))).toBe(true)
  })
})

/**
 * Every screen the web app actually has.
 *
 * Derived from the filesystem rather than listed, so adding a page fails this
 * test and whoever added it has to say so in the prose. The original version of
 * this gate asserted that `apps/web` did not exist, which was true for exactly
 * as long as it took somebody to build one — and a gate that can only hold
 * while nothing happens is not a gate.
 */
function screens(): string[] {
  const root = join(ROOT, 'apps', 'web', 'src', 'app')
  if (!existsSync(root)) return []

  const found: string[] = []
  const walk = (directory: string, route: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${route}/${entry.name}`)
      } else if (entry.name === 'page.tsx') {
        found.push(route === '' ? '/' : route)
      }
    }
  }
  walk(root, '')
  return found.sort()
}

const SCREENS_TODAY = ['/', '/workspaces/[workspaceId]/documents/[documentId]']

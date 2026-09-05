import { test, expect, request, type BrowserContext, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { STATE_PATH, type HarnessState } from './harness.js'

/**
 * DOC-2 AC1, AC2 — two people in one document.
 *
 * The channel's own properties are asserted headlessly, against two Yjs
 * clients, in `test/acceptance/collaboration.test.ts`. What only a browser can
 * show is the part a person actually experiences: that typing appears in
 * somebody else's editor, and that their cursor is visible and labelled with
 * their name. That is the whole reason this suite is worth its cost.
 */
const state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as HarnessState

/**
 * A document of this journey's own.
 *
 * Sharing one between journeys made the second read the first's leftovers —
 * including a cursor belonging to a browser that had closed. Each test creating
 * its own is what CLAUDE.md §5 means by parallel-safe, and it is cheap.
 */
async function newDocument(title: string): Promise<string> {
  const api = await request.newContext({
    baseURL: state.apiUrl,
    extraHTTPHeaders: {
      cookie: state.people[0]!.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    },
  })
  const response = await api.post(
    `/workspaces/${state.workspaceId}/teams/${state.teamId}/documents`,
    { data: { type: 'prd', title } },
  )
  if (!response.ok()) throw new Error(`could not create a document: ${response.status()}`)
  const document = (await response.json()) as { id: string }
  await api.dispose()
  return document.id
}

async function openAs(context: BrowserContext, who: number, documentId: string): Promise<Page> {
  const person = state.people[who]!
  await context.addCookies([...person.cookies])
  const page = await context.newPage()
  await page.goto(`/workspaces/${state.workspaceId}/documents/${documentId}`)
  // The editor is mounted client-side and connects before it is usable; typing
  // into it earlier would produce edits the CRDT has nowhere to send.
  await expect(page.getByRole('textbox', { name: 'Document body' })).toBeVisible()
  return page
}

const body = (page: Page) => page.getByRole('textbox', { name: 'Document body' })

test('DOC-2 AC1: what one person types appears in the other person’s editor', async ({
  browser,
}) => {
  const documentId = await newDocument('Typing together')
  const ada = await openAs(await browser.newContext(), 0, documentId)
  const grace = await openAs(await browser.newContext(), 1, documentId)

  await body(ada).click()
  await body(ada).pressSequentially('Finance reconciles by hand.')

  // Seen by the other person, in their browser, without a reload. Everything
  // before this is machinery; this is the requirement.
  await expect(body(grace)).toContainText('Finance reconciles by hand.')

  await body(grace).click()
  await body(grace).pressSequentially(' Every week.')
  await expect(body(ada)).toContainText('Every week.')
})

test('DOC-2 AC2: a collaborator’s cursor is visible, and labelled with their name', async ({
  browser,
}) => {
  const documentId = await newDocument('Cursors')
  const ada = await openAs(await browser.newContext(), 0, documentId)
  const grace = await openAs(await browser.newContext(), 1, documentId)

  await body(grace).click()
  await body(grace).pressSequentially('Grace is here.')

  // A caret and a name. A highlight alone would be indistinguishable from a
  // selection you made yourself, which is the version of this feature that
  // tells you nothing.
  //
  // Attachment rather than visibility: the caret is a hairline — two borders
  // around an empty inline span — so it has no width to be "visible" by, and
  // asserting on that would be a test of a CSS box rather than of presence.
  await expect(ada.locator('.collaboration-cursor__caret')).toBeAttached()
  await expect(ada.locator('.collaboration-cursor__label')).toHaveText('Grace')

  // And gone when she closes the tab. Presence that lingers is worse than
  // none: it shows a colleague still reading a document they left an hour ago,
  // and people act on that.
  await grace.close()
  await expect(ada.locator('.collaboration-cursor__caret')).toHaveCount(0)
})

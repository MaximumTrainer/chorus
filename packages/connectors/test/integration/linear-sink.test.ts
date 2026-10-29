import { describe, it, expect } from 'vitest'
import { RateLimitedError, UpstreamError } from '@chorus/core'
import { createLinearConnector } from '../../src/linear/index.js'
import { runSinkAction } from '../../src/sink-runner.js'
import { cassettePlayer } from '../../src/testing/cassettes.js'
import type { ConnectorContext } from '../../src/contract.js'

/**
 * INT-4 — the Linear sink, from cassettes.
 *
 * The framework's idempotency guarantee (find-before-execute) is proven against
 * the reference connector in the contract kit. This proves the Linear sink
 * actually implements it against Linear's GraphQL shape: a create carries an
 * idempotency marker and `find` searches for it, so a retry — including one
 * after a lost response — resolves to the one issue rather than making a
 * second (AC2). It also proves the errors a sink must tell apart are told apart
 * (AC3): a rate limit is retryable, a validation failure is permanent.
 *
 * Cassettes are hand-authored from Linear's published GraphQL shapes; nobody has
 * run this against linear.app. Every request is a POST to one URL, so the player
 * matches interactions in order.
 */

const frozen = new Date('2026-09-02T12:00:00.000Z')

function context(cassette: string): ConnectorContext {
  return {
    workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    integrationId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
    credentials: { accessToken: 'lin_oauth_cassette' },
    config: { teamId: 'team-1' },
    now: () => frozen,
    fetch: cassettePlayer(cassette),
    saveCredentials: async () => {},
  }
}

describe('INT-4 Linear sink', () => {
  it('INT-4 AC1: declares the sink capability and external-write actions', () => {
    const connector = createLinearConnector()
    expect(connector.capabilities.sink).toBe(true)
    const actions = connector.sink?.actions ?? {}
    expect(Object.keys(actions).sort()).toEqual(
      ['comment', 'create_issue', 'transition', 'update_issue'].sort(),
    )
    for (const action of Object.values(actions)) {
      expect(action.sideEffect).toBe('external')
    }
  })

  it('INT-4 AC2: creating an issue returns the created issue', async () => {
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/sink-create.json') })
    const action = connector.sink!.actions.create_issue!

    const ref = await runSinkAction(
      action,
      { title: 'The deploy step times out', description: 'It hangs after the build.' },
      'idem-create-1',
      context('linear/sink-create.json'),
    )

    expect(ref.externalId).toBe('lin-issue-new')
    expect(ref.url).toBe('https://linear.app/acme/issue/ACME-42')
  })

  it('INT-4 AC2: a create whose response was lost does not make a second issue on retry', async () => {
    // The first create reached Linear and succeeded, but its response was lost,
    // so the caller never ran `find` and the retry goes through the wrapper.
    // `find` must discover the issue the lost call made (by its idempotency
    // marker) rather than create a duplicate.
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/sink-idempotent.json') })
    const action = connector.sink!.actions.create_issue!
    const ctx = context('linear/sink-idempotent.json')

    const stranded = await action.execute(
      { title: 'The deploy step times out' },
      'idem-lost-1',
      ctx,
    )
    const retried = await runSinkAction(action, { title: 'The deploy step times out' }, 'idem-lost-1', ctx)

    expect(retried.externalId).toBe(stranded.externalId)
  })

  it('INT-4 AC3: a rate limit is reported as retryable', async () => {
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/sink-rate-limited.json') })
    const action = connector.sink!.actions.create_issue!

    const raised = await action
      .execute({ title: 'x' }, 'idem-rate-1', context('linear/sink-rate-limited.json'))
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(raised, 'a rate limit must be retryable, not a permanent failure').toBeInstanceOf(
      RateLimitedError,
    )
  })

  it('INT-4 AC3: a validation failure fails immediately with an actionable message', async () => {
    const connector = createLinearConnector({ fetch: cassettePlayer('linear/sink-invalid.json') })
    const action = connector.sink!.actions.create_issue!

    const raised = await action
      .execute({ title: '' }, 'idem-invalid-1', context('linear/sink-invalid.json'))
      .then(() => undefined)
      .catch((error: unknown) => error)

    // Permanent, not retryable: retrying a request the source rejected as
    // invalid just fails again. The message has to say what was wrong.
    expect(raised).toBeInstanceOf(UpstreamError)
    expect(raised).not.toBeInstanceOf(RateLimitedError)
    expect((raised as UpstreamError).message).toMatch(/title/i)
  })
})

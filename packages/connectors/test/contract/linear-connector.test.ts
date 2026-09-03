import { createHmac } from 'node:crypto'
import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createLinearConnector } from '../../src/linear/index.js'

/**
 * INT-2 AC5, AC6 — the Linear connector against the INT-1 contract kit.
 *
 * The third real provider, and the one that differs most: Linear is **GraphQL**,
 * so every request is a POST to one URL and pagination is an opaque `after`
 * cursor rather than a page number or a header. A framework that had grown up
 * around two REST providers would have assumed a URL identifies a request; the
 * cassette player consuming interactions in order is what makes GraphQL
 * expressible at all.
 *
 * Linear also offers no per-delivery identifier, so the connector derives one.
 * That path is exercised here rather than left to a comment.
 *
 * Cassettes are hand-authored from Linear's published schema shapes; nobody has
 * run this against linear.app.
 */

const WEBHOOK_SECRET = 'linear-webhook-secret'

function sampleDelivery(): {
  request: { headers: Record<string, string>; body: string }
  secret: string
} {
  const body = JSON.stringify({
    action: 'create',
    type: 'Issue',
    createdAt: '2026-09-01T09:00:00.000Z',
    webhookTimestamp: 1788000000000,
    webhookId: 'wh-1',
    data: {
      id: 'lin-issue-1',
      identifier: 'ACME-7',
      title: 'The deploy step times out',
      description: 'It hangs after the build.',
      url: 'https://linear.app/acme/issue/ACME-7',
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:10:00.000Z',
      state: { name: 'Todo', type: 'unstarted' },
      team: { id: 'team-1', key: 'ACME' },
      creator: { id: 'user-501', name: 'Ada Lovelace', displayName: 'ada' },
    },
  })
  return {
    secret: WEBHOOK_SECRET,
    request: {
      headers: {
        'linear-signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
        'linear-event': 'Issue',
      },
      body,
    },
  }
}

describeConnectorContract(
  'linear',
  () => createLinearConnector({ fetch: cassettePlayer('linear/pull.json') }),
  {
    context: {
      credentials: {
        accessToken: 'lin_oauth_cassette',
        refreshToken: 'refresh-original',
        webhookSecret: WEBHOOK_SECRET,
      },
      config: { organisation: 'acme', privateByDefault: true },
    },
    scenarios: {
      rateLimited: () =>
        createLinearConnector({ fetch: cassettePlayer('linear/rate-limited.json') }),
      credentialExpired: () =>
        createLinearConnector({ fetch: cassettePlayer('linear/credential-expired.json') }),
      expiredAccessToken: () =>
        createLinearConnector({
          fetch: cassettePlayer('linear/refresh.json'),
          clientId: 'chorus-linear-app',
          clientSecret: 'chorus-linear-secret',
        }),
    },
    webhookSample: sampleDelivery,
  },
)

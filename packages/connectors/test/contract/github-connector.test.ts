import { createHmac } from 'node:crypto'
import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createGitHubConnector } from '../../src/github/index.js'

/**
 * INT-2 AC6 — the GitHub connector against the INT-1 contract kit.
 *
 * Exactly the suite the reference connector passes, from cassettes rather than
 * a live account. That is the point of AC6: a framework guarantee that holds
 * for the reference connector and not for a real one was never a guarantee, it
 * was a property of the fixture.
 *
 * The cassettes are hand-authored from GitHub's published response shapes
 * rather than recorded against a real installation — nobody has run this
 * against github.com. They are honest about the *shape* the connector must
 * parse and dishonest about nothing else; recording them against a real
 * installation is a follow-up, and the harness supports it.
 */

const WEBHOOK_SECRET = 'github-webhook-secret'

function sampleDelivery(): {
  request: { headers: Record<string, string>; body: string }
  secret: string
} {
  const body = JSON.stringify({
    action: 'opened',
    issue: {
      id: 2001,
      number: 7,
      title: 'The deploy step times out',
      body: 'It hangs after the build.',
      html_url: 'https://github.com/acme/widgets/issues/7',
      created_at: '2026-09-01T09:00:00Z',
      user: { id: 501, login: 'ada' },
    },
    repository: { id: 900, full_name: 'acme/widgets', private: true },
  })
  return {
    secret: WEBHOOK_SECRET,
    request: {
      headers: {
        'x-github-delivery': 'e0e1c2d3-0000-4000-8000-000000000001',
        'x-github-event': 'issues',
        'x-hub-signature-256': `sha256=${createHmac('sha256', WEBHOOK_SECRET)
          .update(body)
          .digest('hex')}`,
      },
      body,
    },
  }
}

describeConnectorContract(
  'github',
  () =>
    createGitHubConnector({
      fetch: cassettePlayer('github/pull.json'),
    }),
  {
    context: {
      credentials: { installationToken: 'ghs_cassette', webhookSecret: WEBHOOK_SECRET },
      config: { installationId: '12345', repositories: ['acme/widgets'] },
    },
    scenarios: {
      rateLimited: () =>
        createGitHubConnector({ fetch: cassettePlayer('github/rate-limited.json') }),
      credentialExpired: () =>
        createGitHubConnector({ fetch: cassettePlayer('github/credential-expired.json') }),
    },
    webhookSample: sampleDelivery,
  },
)

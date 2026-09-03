import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createGitLabConnector } from '../../src/gitlab/index.js'

/**
 * INT-2 AC6 — the GitLab connector against the INT-1 contract kit.
 *
 * The same suite GitHub and the reference connector pass. GitLab is here as the
 * second real provider precisely because it differs where it matters: it
 * paginates by header rather than by short page, it authenticates webhooks with
 * a **plain shared token** rather than an HMAC, and its OAuth access tokens
 * expire and must be refreshed. Each of those is a place a framework shaped
 * around GitHub alone would have quietly baked in an assumption.
 *
 * Cassettes are hand-authored from GitLab's published response shapes; nobody
 * has run this against gitlab.com.
 */

const WEBHOOK_TOKEN = 'gitlab-webhook-token'

function sampleDelivery(): {
  request: { headers: Record<string, string>; body: string }
  secret: string
} {
  const body = JSON.stringify({
    object_kind: 'issue',
    project: { id: 77, path_with_namespace: 'acme/widgets', visibility_level: 0 },
    object_attributes: {
      id: 3001,
      iid: 7,
      title: 'The deploy step times out',
      description: 'It hangs after the build.',
      state: 'opened',
      url: 'https://gitlab.com/acme/widgets/-/issues/7',
      created_at: '2026-09-01 09:00:00 UTC',
      updated_at: '2026-09-01 09:10:00 UTC',
    },
    user: { id: 501, username: 'ada' },
  })
  return {
    secret: WEBHOOK_TOKEN,
    request: {
      headers: {
        'x-gitlab-event-uuid': 'b1c2d3e4-0000-4000-8000-000000000001',
        'x-gitlab-event': 'Issue Hook',
        // Not a signature: GitLab sends the shared secret itself. The framework
        // must not assume every source signs.
        'x-gitlab-token': WEBHOOK_TOKEN,
      },
      body,
    },
  }
}

describeConnectorContract(
  'gitlab',
  () => createGitLabConnector({ fetch: cassettePlayer('gitlab/pull.json') }),
  {
    context: {
      credentials: {
        accessToken: 'glpat-cassette',
        refreshToken: 'refresh-original',
        webhookToken: WEBHOOK_TOKEN,
      },
      config: { projects: ['acme/widgets'], privateProjects: ['acme/widgets'] },
    },
    scenarios: {
      rateLimited: () =>
        createGitLabConnector({ fetch: cassettePlayer('gitlab/rate-limited.json') }),
      credentialExpired: () =>
        createGitLabConnector({ fetch: cassettePlayer('gitlab/credential-expired.json') }),
      expiredAccessToken: () =>
        createGitLabConnector({
          fetch: cassettePlayer('gitlab/refresh.json'),
          clientId: 'chorus-gitlab-app',
          clientSecret: 'chorus-gitlab-secret',
        }),
    },
    webhookSample: sampleDelivery,
  },
)

import { createHmac } from 'node:crypto'
import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createJiraConnector } from '../../src/jira/index.js'

const WEBHOOK_SECRET = 'jira_hook_secret'

/** A genuine Jira `issue_updated` delivery, signed with the webhook secret. */
const sampleDelivery = () => {
  const body = JSON.stringify({
    timestamp: 1_756_717_800_000,
    webhookEvent: 'jira:issue_updated',
    issue: {
      id: '10001',
      key: 'ACME-7',
      fields: {
        summary: 'The deploy step times out',
        status: { name: 'In Progress' },
        issuetype: { name: 'Bug', subtask: false },
        project: { key: 'ACME', id: 'proj-1' },
      },
    },
  })
  return {
    request: {
      headers: { 'x-hub-signature': `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}` },
      body,
    },
    secret: WEBHOOK_SECRET,
  }
}

/**
 * INT-8 — the Jira source connector against the connector contract kit.
 *
 * Jira is REST, so pagination is offset-based (`startAt`/`total`) and a request
 * is identified by its path and query; the cassette player matches those
 * exactly. Atlassian rotates its refresh token on every use, like GitLab, so
 * the refresh scenario asserts the connector hands the new token back rather
 * than merely using it.
 *
 * Cassettes are hand-authored from Jira's published REST shapes; nobody has run
 * this against a live site.
 */
describeConnectorContract(
  'jira',
  () => createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/pull.json') }),
  {
    context: {
      credentials: { accessToken: 'jira_access', refreshToken: 'jira_refresh', webhookSecret: WEBHOOK_SECRET },
      config: { siteUrl: 'https://acme.atlassian.net', privateByDefault: true },
    },
    webhookSample: sampleDelivery,
    scenarios: {
      rateLimited: () =>
        createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/rate-limited.json') }),
      credentialExpired: () =>
        createJiraConnector({ apiUrl: 'https://jira.test/api', fetch: cassettePlayer('jira/credential-expired.json') }),
      expiredAccessToken: () =>
        createJiraConnector({
          apiUrl: 'https://jira.test/api',
          fetch: cassettePlayer('jira/refresh.json'),
          clientId: 'chorus-jira-app',
          clientSecret: 'chorus-jira-secret',
        }),
    },
  },
)

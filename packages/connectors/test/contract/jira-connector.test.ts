import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createJiraConnector } from '../../src/jira/index.js'

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
      credentials: { accessToken: 'jira_access', refreshToken: 'jira_refresh' },
      config: { siteUrl: 'https://acme.atlassian.net', privateByDefault: true },
    },
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

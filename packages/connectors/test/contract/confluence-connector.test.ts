import { describeConnectorContract, cassettePlayer } from '../../src/testing/index.js'
import { createConfluenceConnector } from '../../src/confluence/index.js'

/**
 * INT-9 — the Confluence source connector against the connector contract kit.
 *
 * Confluence is REST and shares Jira's Atlassian auth, so pagination is
 * offset-based and the refresh scenario asserts the rotated token is handed
 * back. Cassettes are hand-authored from Confluence's published REST shapes;
 * nobody has run this against a live site.
 */
describeConnectorContract(
  'confluence',
  () => createConfluenceConnector({ apiUrl: 'https://conf.test/api', fetch: cassettePlayer('confluence/pull.json') }),
  {
    context: {
      credentials: { accessToken: 'conf-access', refreshToken: 'conf-refresh' },
      config: { siteUrl: 'https://acme.atlassian.net', privateByDefault: true },
    },
    scenarios: {
      rateLimited: () =>
        createConfluenceConnector({ apiUrl: 'https://conf.test/api', fetch: cassettePlayer('confluence/rate-limited.json') }),
      credentialExpired: () =>
        createConfluenceConnector({ apiUrl: 'https://conf.test/api', fetch: cassettePlayer('confluence/credential-expired.json') }),
      expiredAccessToken: () =>
        createConfluenceConnector({
          apiUrl: 'https://conf.test/api',
          fetch: cassettePlayer('confluence/refresh.json'),
          clientId: 'chorus-confluence-app',
          clientSecret: 'chorus-confluence-secret',
        }),
    },
  },
)

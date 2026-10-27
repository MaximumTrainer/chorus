import { describe, it, expect } from 'vitest'
import { parsePullRequestUrl } from './pull-requests.js'

describe('MCP-3 pull request addresses', () => {
  it('MCP-3: reads the repository and number from a GitHub pull request', () => {
    expect(parsePullRequestUrl('https://github.com/acme/widgets/pull/42')).toEqual({
      provider: 'github',
      repository: 'acme/widgets',
      number: 42,
    })
  })

  it('MCP-3: reads a GitLab merge request, subgroups included', () => {
    expect(parsePullRequestUrl('https://gitlab.com/acme/platform/widgets/-/merge_requests/7')).toEqual({
      provider: 'gitlab',
      repository: 'acme/platform/widgets',
      number: 7,
    })
  })

  it('MCP-3: refuses what is not a pull request on a host Chorus connects to', () => {
    for (const url of [
      'http://github.com/acme/widgets/pull/42',
      'https://github.com/acme/widgets/issues/42',
      'https://github.com/acme/widgets/pull/42/files',
      'https://github.com/acme/widgets/pull/0',
      'https://example.com/acme/widgets/pull/42',
      'https://gitlab.com/acme/widgets/merge_requests/7',
      'not a url',
    ]) {
      expect(parsePullRequestUrl(url), url).toBeUndefined()
    }
  })
})

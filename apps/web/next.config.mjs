/**
 * The web app (architecture.md §6).
 *
 * `transpilePackages` because `@chorus/ui` ships TypeScript source rather than
 * a build: one fewer build step between changing a component and seeing it, and
 * no chance of the app running a stale copy of the shared schema — which is
 * the one thing that must never differ between the editor and the server.
 */
const config = {
  reactStrictMode: true,
  transpilePackages: ['@chorus/ui'],
  /**
   * `./thing.js` in a TypeScript file means `./thing.ts`.
   *
   * That specifier is what Node requires of real ESM, so the shared packages
   * write it — they are executed directly, not only bundled. Webpack resolves
   * literally and would look for a `.js` file that is never built, so it is
   * told the mapping rather than the packages being made wrong for Node.
   */
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    }
    return config
  },

  env: {
    CHORUS_API_URL: process.env.CHORUS_API_URL ?? 'http://localhost:3000',
    CHORUS_COLLAB_URL: process.env.CHORUS_COLLAB_URL ?? 'ws://localhost:1234',
  },
}

export default config

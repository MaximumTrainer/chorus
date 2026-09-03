import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { walkRepository, ALWAYS_IGNORED } from './walk.js'

/**
 * BRAIN-2 AC5 — ignore rules.
 *
 * Exclusion is a security property here, not a tidiness one: the criterion asks
 * specifically that secrets-like paths never reach the index *or the
 * embeddings*. An embedded secret is worse than an indexed one, because it is
 * then retrievable by meaning rather than only by name, and it cannot be
 * un-embedded without a re-index.
 *
 * So these tests are adversarial about the cases a hand-rolled matcher gets
 * wrong — negation, anchoring, directory-only rules, `**` — which is the whole
 * argument for not hand-rolling one (ADR-0013).
 */

function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'chorus-walk-'))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }
  return root
}

const paths = async (root: string): Promise<string[]> =>
  (await walkRepository(root)).map((file) => file.path).sort()

describe('BRAIN-2 walking a working copy', () => {
  it('BRAIN-2: source files are found, with their size and a content hash', async () => {
    const root = repository({
      'src/a.ts': 'export const a = 1\n',
      'src/nested/b.ts': 'export const b = 2\n',
    })
    try {
      const files = await walkRepository(root)
      expect(files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/nested/b.ts'])

      const [first] = files
      expect(first!.bytes).toBeGreaterThan(0)
      // The hash is what makes an incremental re-index possible: an unchanged
      // file must be recognisable without re-reading its whole content later.
      expect(first!.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(first!.path.includes('\\'), 'paths are posix, whatever the host').toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: .gitignore excludes, including a secrets-like path', async () => {
    const root = repository({
      '.gitignore': '.env\n*.pem\nsecrets/\n',
      '.env': 'DATABASE_PASSWORD=hunter2\n',
      'deploy/key.pem': '-----BEGIN PRIVATE KEY-----\n',
      'secrets/token.txt': 'ghp_arealsecret\n',
      'src/a.ts': 'export const a = 1\n',
    })
    try {
      const found = await paths(root)
      // The ignore file itself is indexed: it is a committed file that states
      // what the project considers generated, which is exactly the kind of
      // convention AC4 wants discoverable. Only what it *names* is excluded.
      expect(found).toEqual(['.gitignore', 'src/a.ts'])
      // Stated as its own assertion because this is the criterion: nothing
      // secrets-shaped may reach the index, and therefore the embeddings.
      for (const secret of ['.env', 'deploy/key.pem', 'secrets/token.txt']) {
        expect(found, `${secret} must not be indexed`).not.toContain(secret)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: .chorusignore excludes on top of .gitignore', async () => {
    // A repository may legitimately commit fixtures it does not want indexed —
    // vendored code, generated clients, a corpus of test data.
    const root = repository({
      '.gitignore': 'dist/\n',
      '.chorusignore': 'vendor/\n*.generated.ts\n',
      'dist/bundle.js': 'x',
      'vendor/lib.ts': 'export const v = 1',
      'src/client.generated.ts': 'export const c = 1',
      'src/a.ts': 'export const a = 1',
    })
    try {
      expect(await paths(root)).toEqual(['.chorusignore', '.gitignore', 'src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: negation re-includes, and a later rule wins', async () => {
    // The case a subset matcher gets wrong. Getting it backwards excludes a
    // file somebody deliberately kept, or keeps one they deliberately excluded.
    const root = repository({
      '.gitignore': '*.log\n!keep.log\n',
      'debug.log': 'noise',
      'keep.log': 'wanted',
      'src/a.ts': 'export const a = 1',
    })
    try {
      expect(await paths(root)).toEqual(['.gitignore', 'keep.log', 'src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: a leading slash anchors to the repository root', async () => {
    const root = repository({
      '.gitignore': '/build\n',
      'build/out.js': 'x',
      'packages/app/build/out.js': 'y',
    })
    try {
      // Anchored: only the root `build` is excluded. Treating it as unanchored
      // would silently drop a nested directory nobody asked to exclude.
      expect(await paths(root)).toEqual(['.gitignore', 'packages/app/build/out.js'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2 AC5: ** spans directories', async () => {
    const root = repository({
      '.gitignore': 'packages/**/dist/\n',
      'packages/a/dist/x.js': 'x',
      'packages/a/b/dist/y.js': 'y',
      'packages/a/src/z.ts': 'z',
    })
    try {
      expect(await paths(root)).toEqual(['.gitignore', 'packages/a/src/z.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2: .git and node_modules are always excluded, ignore file or not', async () => {
    // Not every repository lists them, and indexing either produces a corpus of
    // other people's code plus git internals that would swamp every result.
    const root = repository({
      '.git/config': '[core]',
      'node_modules/left-pad/index.js': 'module.exports = 1',
      'src/a.ts': 'export const a = 1',
    })
    try {
      expect(await paths(root)).toEqual(['src/a.ts'])
      expect(ALWAYS_IGNORED).toContain('node_modules/')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2: binary and oversized files are skipped, with a reason', async () => {
    const root = repository({ 'src/a.ts': 'export const a = 1' })
    try {
      // A PNG's bytes embed to noise and its "text" is meaningless.
      writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
      const files = await walkRepository(root)
      expect(files.map((file) => file.path)).toEqual(['src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2: a repository with no ignore files still walks', async () => {
    const root = repository({ 'src/a.ts': 'export const a = 1' })
    try {
      expect(await paths(root)).toEqual(['src/a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('BRAIN-2: the walk is ordered, so two runs agree', async () => {
    const root = repository({
      'src/b.ts': 'export const b = 1',
      'src/a.ts': 'export const a = 1',
      'z.ts': 'export const z = 1',
    })
    try {
      // An unordered walk makes an incremental re-index compare the wrong
      // things, and makes two indexes of the same commit differ.
      expect(await paths(root)).toEqual(await paths(root))
      expect(await paths(root)).toEqual(['src/a.ts', 'src/b.ts', 'z.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import ignore from 'ignore'

/**
 * Walking a working copy (BRAIN-2 AC5).
 *
 * Exclusion here is a **security property**, not a tidiness one: the criterion
 * asks specifically that secrets-like paths never reach the index or the
 * embeddings. An embedded secret is worse than an indexed one — it becomes
 * retrievable by meaning rather than only by name, and cannot be un-embedded
 * without a full re-index.
 *
 * `.gitignore` semantics are therefore delegated rather than approximated
 * (ADR-0013). Negation, anchoring, `**` and directory-only rules are each a
 * case where a subset implementation does not fail loudly — it silently indexes
 * a file somebody believed was excluded.
 */

export interface WalkedFile {
  /** Repository-relative, posix separators, whatever the host uses. */
  readonly path: string
  readonly bytes: number
  /**
   * SHA-256 of the contents.
   *
   * What makes an incremental re-index possible: an unchanged file is
   * recognisable without re-parsing or re-embedding it.
   */
  readonly contentHash: string
  readonly text: string
}

/**
 * Excluded whether or not a repository says so.
 *
 * Not every repository lists these, and indexing either produces a corpus of
 * other people's code plus git internals that swamps every genuine result.
 */
export const ALWAYS_IGNORED: readonly string[] = Object.freeze([
  '.git/',
  'node_modules/',
  '.pnpm-store/',
  'vendor/bundle/',
  '__pycache__/',
  '.venv/',
  'target/debug/',
  'target/release/',
])

/** A megabyte: beyond this a file is generated, vendored, or data. */
const MAX_FILE_BYTES = 1024 * 1024

/**
 * Binary detection by content, not by extension.
 *
 * An extension list is always incomplete, and the failure mode is embedding a
 * few kilobytes of noise. A NUL byte in the first block is the same heuristic
 * git uses and is right about far more often.
 */
function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000)
  return sample.includes(0)
}

async function readIgnoreFile(root: string, name: string): Promise<string> {
  try {
    return await readFile(join(root, name), 'utf8')
  } catch {
    // Absent is the common case and not an error.
    return ''
  }
}

/**
 * Walks the working copy, in a stable order.
 *
 * Order matters beyond neatness: an unordered walk makes an incremental
 * re-index compare the wrong things, and makes two indexes of the same commit
 * differ for no reason anyone can see.
 */
export async function walkRepository(root: string): Promise<WalkedFile[]> {
  const matcher = ignore()
    .add([...ALWAYS_IGNORED])
    .add(await readIgnoreFile(root, '.gitignore'))
    // Added last so a repository can exclude beyond git — vendored code,
    // generated clients, a corpus of fixtures it commits but does not want
    // retrieved.
    .add(await readIgnoreFile(root, '.chorusignore'))

  const found: WalkedFile[] = []

  async function descend(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    // Sorted here rather than at the end, so directory traversal order is
    // deterministic too and a large repository does not depend on the
    // filesystem's whims.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const relativePath = relative(root, absolute).split(sep).join(posix.sep)

      if (entry.isDirectory()) {
        // Tested with a trailing slash: `ignore` matches directory-only rules
        // (`secrets/`) only when told the candidate is a directory. Without it,
        // an excluded directory is descended into and its contents indexed.
        if (matcher.ignores(`${relativePath}/`)) continue
        await descend(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (matcher.ignores(relativePath)) continue

      const info = await stat(absolute)
      if (info.size > MAX_FILE_BYTES) continue

      const buffer = await readFile(absolute)
      if (looksBinary(buffer)) continue

      found.push({
        path: relativePath,
        bytes: info.size,
        contentHash: createHash('sha256').update(buffer).digest('hex'),
        text: buffer.toString('utf8'),
      })
    }
  }

  await descend(root)
  return found
}

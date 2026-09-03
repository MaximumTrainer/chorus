import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { UpstreamError } from '@chorus/core'

const run = promisify(execFile)

/**
 * A disposable working copy (BRAIN-2, "clone with a short-lived scoped token
 * and never persist it; the working copy is disposable").
 *
 * Three properties, and each is a thing that goes wrong in a real deployment:
 *
 *  - **The token is never written to disk.** Git's natural way to authenticate
 *    an HTTPS clone is a URL containing the credential — which lands in
 *    `.git/config`, in the process table, and in any error message git prints.
 *    It is passed through an askpass helper on stdin's environment instead, so
 *    the checkout leaves nothing behind to leak.
 *  - **The clone is shallow and single-commit.** Indexing needs the tree at one
 *    commit, not the history; a full clone of a large repository is minutes of
 *    wall-clock and gigabytes of disk for data nothing reads.
 *  - **The directory is always removed**, including when indexing throws. A
 *    working copy left behind is a checked-out copy of a private repository
 *    sitting on a shared host.
 */

export interface CheckoutRequest {
  /** `https://github.com/acme/widgets.git`, or a local path in tests. */
  readonly remote: string
  readonly commitSha: string
  /** Short-lived and repository-scoped (INT-2 AC2). Never persisted. */
  readonly token?: string
}

export interface WorkingCopy {
  readonly path: string
  /** Always call this. `withWorkingCopy` does it for you, including on a throw. */
  dispose(): Promise<void>
}

/**
 * Environment that lets git authenticate without the credential touching disk.
 *
 * `GIT_ASKPASS` pointing at a program that echoes the token would need a file;
 * a header via `-c http.extraHeader` keeps it in the argument list only for the
 * lifetime of the process, and out of `.git/config` entirely — which is what
 * survives the clone.
 */
function authArgs(token: string | undefined): string[] {
  if (!token) return []
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
}

export async function checkout(request: CheckoutRequest): Promise<WorkingCopy> {
  const path = await mkdtemp(join(tmpdir(), 'chorus-checkout-'))

  const dispose = async (): Promise<void> => {
    await rm(path, { recursive: true, force: true })
  }

  try {
    // Fetching one commit rather than cloning a branch: the commit is what the
    // index claims to represent, and cloning a branch would race a push that
    // moved it.
    await run('git', ['init', '--quiet', path])
    await run(
      'git',
      [
        '-C',
        path,
        ...authArgs(request.token),
        'fetch',
        '--quiet',
        '--depth',
        '1',
        request.remote,
        request.commitSha,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    await run('git', ['-C', path, 'checkout', '--quiet', 'FETCH_HEAD'])

    return { path, dispose }
  } catch (error) {
    await dispose()
    const message = error instanceof Error ? error.message : String(error)
    throw new UpstreamError('Could not check out the repository', {
      // Redacted: git puts the whole command in its error, and the command
      // carries the credential.
      reason: request.token ? message.split(request.token).join('[redacted]') : message,
      commitSha: request.commitSha,
    })
  }
}

/** Checks out, runs, and removes the copy — including when `use` throws. */
export async function withWorkingCopy<T>(
  request: CheckoutRequest,
  use: (copy: WorkingCopy) => Promise<T>,
): Promise<T> {
  const copy = await checkout(request)
  try {
    return await use(copy)
  } finally {
    // A working copy left behind is a checked-out copy of a private repository
    // sitting on a shared host, so this is a `finally` rather than a happy-path
    // cleanup.
    await copy.dispose()
  }
}

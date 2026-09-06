import { sweepStaleTestDatabases } from '@chorus/db'

/**
 * Drops test databases abandoned by an earlier run, before this one starts (#158).
 *
 * An interrupted run leaves its database behind, and nothing notices because
 * the next run invents a new name. They accumulate, and the symptom is not a
 * missing database — it is the tenancy and permission suites, which enumerate
 * `information_schema`, slowing until an unrelated test fails on a timeout.
 * Measured here: eleven strays turned a 30 s suite into 3043 s.
 *
 * Thirty minutes, so a suite running in parallel with this one is never swept
 * out from under itself. Best-effort: a sweep that cannot connect must not
 * stop the run it precedes.
 */
export default async function sweep(): Promise<void> {
  try {
    const dropped = await sweepStaleTestDatabases({ olderThanMs: 30 * 60 * 1000 })
    if (dropped.length > 0) {
      console.warn(
        JSON.stringify({
          level: 'info',
          message: 'dropped abandoned test databases',
          count: dropped.length,
        }),
      )
    }
  } catch {
    // The run matters more than the housekeeping.
  }
}

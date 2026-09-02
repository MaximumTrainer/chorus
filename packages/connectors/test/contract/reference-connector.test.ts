import { describeConnectorContract } from '../../src/testing/index.js'
import { createReferenceConnector } from '../../src/reference/index.js'

/**
 * INT-1 AC7 — the contract kit, run against the reference connector.
 *
 * The kit is the deliverable here, not this file. Every connector must pass
 * exactly this suite, so a contribution is testable without a live account and
 * a framework guarantee cannot quietly hold for one connector and not another.
 *
 * The reference connector exists to keep the interface honest *before* a real
 * API distorts it: it is deliberately simple, and it is scriptable, so the kit
 * can demand behaviours — a rate-limit response, an expired credential, a
 * forged signature — that a real source will not produce on request.
 */
describeConnectorContract('reference', () => createReferenceConnector())

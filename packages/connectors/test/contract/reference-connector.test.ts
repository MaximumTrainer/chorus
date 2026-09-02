import { createHmac } from 'node:crypto'
import { describeConnectorContract } from '../../src/testing/index.js'
import { createReferenceConnector } from '../../src/reference/index.js'

const WEBHOOK_SECRET = 'contract-kit-secret'

function sampleDelivery(): { request: { headers: Record<string, string>; body: string }; secret: string } {
  const body = JSON.stringify({
    id: 'hook-contract-1',
    text: 'a delivery the kit can forge',
    at: '2026-09-01T09:00:00.000Z',
  })
  return {
    secret: WEBHOOK_SECRET,
    request: {
      headers: {
        'x-reference-delivery': 'contract-delivery-1',
        'x-reference-signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'),
      },
      body,
    },
  }
}

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
describeConnectorContract('reference', () => createReferenceConnector(), {
  scenarios: {
    rateLimited: () => createReferenceConnector({ rateLimitedAfterMs: 30_000 }),
    credentialExpired: () => createReferenceConnector({ credentialExpired: true }),
  },
  webhookSample: sampleDelivery,
})

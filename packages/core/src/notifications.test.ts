import { describe, it, expect } from 'vitest'
import {
  GATING_NOTIFICATION_KINDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  defaultNotificationPreference,
  isNotificationChannel,
  isNotificationKind,
  mayDisable,
} from './notifications.js'

/**
 * SLACK-6 — the rules that decide whether a person is told.
 *
 * Pure, and here rather than in the dispatcher, because the API validating a
 * preference and the dispatcher deciding whether to send must agree. Two
 * implementations of "you may not turn this off" would eventually disagree,
 * and the disagreement is somebody who quietly stopped being told.
 */
describe('SLACK-6 notification rules', () => {
  it('SLACK-6 AC3: every kind has a default on every channel', () => {
    // A missing default would read as `undefined`, which is falsy, which means
    // a new kind would silently notify nobody — the failure that looks like
    // nothing happening.
    for (const kind of NOTIFICATION_KINDS) {
      for (const channel of NOTIFICATION_CHANNELS) {
        expect(
          typeof defaultNotificationPreference(kind, channel),
          `${kind} has no default for ${channel}`,
        ).toBe('boolean')
      }
    }
  })

  it('SLACK-6 AC1: a gating kind defaults to on for every channel it may use', () => {
    // The cost of an unwanted email is far below the cost of a run stopped at a
    // gate nobody saw, so this one defaults loud.
    for (const kind of GATING_NOTIFICATION_KINDS) {
      expect(defaultNotificationPreference(kind, 'in_app')).toBe(true)
      expect(defaultNotificationPreference(kind, 'email')).toBe(true)
    }
  })

  it('SLACK-6: defaults are not a blanket, or the preference model is decorative', () => {
    // At least one kind must default off somewhere. Without this the suite
    // above would pass just as well against `() => true`.
    const anyOff = NOTIFICATION_KINDS.some((kind) =>
      NOTIFICATION_CHANNELS.some((channel) => !defaultNotificationPreference(kind, channel)),
    )
    expect(anyOff).toBe(true)
  })

  it('SLACK-6: a gating kind keeps its in-app channel but may decline email', () => {
    // "Offer channel choice rather than complete opt-out." Muting the only
    // channel does not mute the work — the run still waits, and nobody comes.
    expect(mayDisable('checkpoint_requested', 'in_app')).toBe(false)
    expect(mayDisable('checkpoint_requested', 'email')).toBe(true)
  })

  it('SLACK-6 AC3: a non-gating kind may be turned off everywhere', () => {
    // Otherwise the rule above is indistinguishable from "preferences do not
    // work", and every kind becomes effectively mandatory.
    for (const channel of NOTIFICATION_CHANNELS) {
      expect(mayDisable('job_status', channel)).toBe(true)
    }
  })

  it('SLACK-6: every gating kind is a real kind', () => {
    // The two lists are maintained by hand. A gating entry that is not a kind
    // would protect nothing while looking as though it did.
    for (const kind of GATING_NOTIFICATION_KINDS) {
      expect(NOTIFICATION_KINDS).toContain(kind)
    }
  })

  it('SLACK-6: kinds and channels arriving over the wire are checked, not trusted', () => {
    expect(isNotificationKind('checkpoint_requested')).toBe(true)
    expect(isNotificationKind('checkpoint-requested')).toBe(false)
    expect(isNotificationKind(null)).toBe(false)
    expect(isNotificationChannel('email')).toBe(true)
    expect(isNotificationChannel('sms')).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TransitionError,
  UpstreamError,
  LimitExceededError,
  ConfigurationError,
  UnauthenticatedError,
} from './errors.js'

const ALL = [
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  TransitionError,
  UpstreamError,
  LimitExceededError,
  ConfigurationError,
] as const

describe('AppError hierarchy', () => {
  it('every error is an Error, so stack traces and instanceof both work', () => {
    for (const Kind of ALL) {
      const error = new Kind('boom')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(AppError)
      expect(error.stack).toBeDefined()
    }
  })

  it('every error names itself, so logs identify the kind without parsing prose', () => {
    for (const Kind of ALL) {
      expect(new Kind('boom').name).toBe(Kind.name)
    }
  })

  it('type discriminators are unique, because callers branch on them', () => {
    const types = ALL.map((Kind) => new Kind('boom').type)
    expect(new Set(types).size).toBe(types.length)
  })

  it('renders RFC 9457 problem details including its context', () => {
    const error = new ValidationError('title is required', { field: 'title' })
    expect(error.toProblemDetails()).toEqual({
      type: 'https://chorus.dev/problems/validation',
      title: 'ValidationError',
      status: 400,
      detail: 'title is required',
      field: 'title',
    })
  })

  it('only transient failures are retryable, so consumers do not retry a permission error forever', () => {
    expect(new UpstreamError('provider down').retryable).toBe(true)
    expect(new LimitExceededError('spend limit').retryable).toBe(true)
    expect(new ForbiddenError('nope').retryable).toBe(false)
    expect(new ValidationError('bad').retryable).toBe(false)
    // A misconfigured deployment needs a human, not a retry loop.
    expect(new ConfigurationError('missing key').retryable).toBe(false)
  })

  it('details are frozen, so an error cannot be mutated after it is thrown', () => {
    const error = new NotFoundError('gone', { id: 'abc' })
    expect(() => {
      ;(error.details as Record<string, unknown>).id = 'changed'
    }).toThrow()
    expect(error.details.id).toBe('abc')
  })

  it('preserves the underlying cause for diagnosis', () => {
    const cause = new Error('socket hang up')
    expect(new UpstreamError('provider unreachable', {}, { cause }).cause).toBe(cause)
  })
})

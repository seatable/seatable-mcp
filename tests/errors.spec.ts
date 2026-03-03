import { describe, expect, it } from 'vitest'
import type { AxiosError } from 'axios'
import { toCodedAxiosError } from '../src/errors.js'

function fakeAxiosError(status?: number, data?: any): AxiosError {
  return {
    name: 'AxiosError',
    message: 'x',
    config: {},
    isAxiosError: true,
    toJSON: () => ({}),
    response: status ? { status, data } as any : undefined,
  } as AxiosError
}

describe('toCodedAxiosError', () => {
  it('maps 401 to ERR_AUTH_EXPIRED', () => {
    const e = toCodedAxiosError(fakeAxiosError(401), 'op')
    expect(e.code).toBe('ERR_AUTH_EXPIRED')
  })
  it('maps 408 to ERR_TIMEOUT', () => {
    const e = toCodedAxiosError(fakeAxiosError(408), 'op')
    expect(e.code).toBe('ERR_TIMEOUT')
  })
  it('maps 429 to ERR_RATE_LIMITED', () => {
    const e = toCodedAxiosError(fakeAxiosError(429), 'op')
    expect(e.code).toBe('ERR_RATE_LIMITED')
  })
  it('maps 500 to ERR_SERVER', () => {
    const e = toCodedAxiosError(fakeAxiosError(500), 'op')
    expect(e.code).toBe('ERR_SERVER')
  })
  it('maps 400 to ERR_BAD_REQUEST', () => {
    const e = toCodedAxiosError(fakeAxiosError(400), 'op')
    expect(e.code).toBe('ERR_BAD_REQUEST')
  })
  it('maps 403 to ERR_BAD_REQUEST with permission message', () => {
    const e = toCodedAxiosError(fakeAxiosError(403, { error_msg: "You don't have permission to perform this operation on this base." }), 'op')
    expect(e.code).toBe('ERR_BAD_REQUEST')
    expect(e.message).toContain("You don't have permission")
  })
  it('includes error_msg in message', () => {
    const e = toCodedAxiosError(fakeAxiosError(400, { error_msg: 'Table not found' }), 'op')
    expect(e.message).toBe('ERR_BAD_REQUEST: Table not found')
  })
  it('includes detail in message', () => {
    const e = toCodedAxiosError(fakeAxiosError(429, { detail: 'Rate limit exceeded' }), 'op')
    expect(e.message).toBe('ERR_RATE_LIMITED: Rate limit exceeded')
  })
  it('falls back to code-only message when no detail', () => {
    const e = toCodedAxiosError(fakeAxiosError(500), 'op')
    expect(e.message).toBe('ERR_SERVER')
  })
})

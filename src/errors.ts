import type { AxiosError } from 'axios'

export type ErrorCode =
  | 'ERR_AUTH_EXPIRED'
  | 'ERR_SCHEMA_UNKNOWN_TABLE'
  | 'ERR_SCHEMA_UNKNOWN_COLUMN'
  | 'ERR_FILE_TOO_LARGE'
  | 'ERR_UPSERT_MISSING_KEY'
  | 'ERR_UPSERT_AMBIGUOUS'
  | 'ERR_TIMEOUT'
  | 'ERR_RATE_LIMITED'
  | 'ERR_SERVER'
  | 'ERR_BAD_REQUEST'

export type CodedError = Error & { code: ErrorCode; meta?: Record<string, unknown> }

export function makeError(code: ErrorCode, message: string, meta?: Record<string, unknown>): CodedError {
  const err = new Error(message) as CodedError
  err.code = code
  if (meta) err.meta = meta
  return err
}

export function toCodedAxiosError(error: unknown, op: string): CodedError {
  const err = error as AxiosError
  const status = err.response?.status
  const data = err.response?.data as any
  const detail = data?.error_msg || data?.detail || ''
  const msg = (code: ErrorCode) => detail ? `${code}: ${detail}` : code

  if (status === 401) return makeError('ERR_AUTH_EXPIRED', msg('ERR_AUTH_EXPIRED'), { op, status, data })
  if (status === 403) return makeError('ERR_BAD_REQUEST', msg('ERR_BAD_REQUEST'), { op, status, data })
  if (status === 408) return makeError('ERR_TIMEOUT', msg('ERR_TIMEOUT'), { op, status, data })
  if (status === 429) return makeError('ERR_RATE_LIMITED', msg('ERR_RATE_LIMITED'), { op, status, data })
  if (status && status >= 500) return makeError('ERR_SERVER', msg('ERR_SERVER'), { op, status, data })
  if (status && status >= 400) return makeError('ERR_BAD_REQUEST', msg('ERR_BAD_REQUEST'), { op, status, data })
  return makeError('ERR_SERVER', msg('ERR_SERVER'), { op, status, data })
}

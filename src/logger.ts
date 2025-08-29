import pino, { Logger } from 'pino'

// Send logs to stderr (fd: 2) so MCP stdio stdout stays clean
const destination = pino.destination({ fd: 2 })

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined, // do not add pid/hostname
  redact: ['req.headers.authorization', 'config.headers.Authorization'],
  timestamp: pino.stdTimeFunctions.isoTime,
}, destination)

export function withRequest<T extends Record<string, unknown>>(fields: T) {
  return logger.child(fields)
}

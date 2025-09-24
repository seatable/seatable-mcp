import type { Logger } from 'pino'

let logger: Logger

if (typeof process !== 'undefined' && process.versions?.node) {
    const pinoModule = await import('pino')
    const destination = pinoModule.destination({ fd: 2 })
    logger = pinoModule.default({
        level: process.env.LOG_LEVEL || 'info',
        base: undefined,
        redact: ['req.headers.authorization', 'config.headers.Authorization'],
        timestamp: pinoModule.default.stdTimeFunctions.isoTime,
    }, destination)
} else {
    const createFallbackLogger = () => {
        const base: any = {
            level: 'info',
            fatal: (...args: unknown[]) => console.error(...args),
            error: (...args: unknown[]) => console.error(...args),
            warn: (...args: unknown[]) => console.warn(...args),
            info: (...args: unknown[]) => console.log(...args),
            debug: (...args: unknown[]) => console.debug(...args),
            trace: (...args: unknown[]) => console.debug(...args),
            silent: () => {},
        }
        base.child = () => base
        return base as Logger
    }
    logger = createFallbackLogger()
}

export { logger }

export function withRequest<T extends Record<string, unknown>>(fields: T) {
    return logger.child(fields)
}

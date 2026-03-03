import { createRequire } from 'node:module'

import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

const require = createRequire(import.meta.url)

const pkg = require('../../package.json') as { version: string }

export const VERSION: string = pkg.version

if (typeof process !== 'undefined' && process.versions?.node) {
    loadEnv()
}

export const ServerModeSchema = z.enum(['selfhosted', 'managed']).default('selfhosted')
export type ServerMode = z.infer<typeof ServerModeSchema>

const EnvSchema = z
    .object({
        SEATABLE_SERVER_URL: z.string().url(),
        SEATABLE_MODE: ServerModeSchema,
        SEATABLE_API_TOKEN: z.string().min(1).optional(),
        // Multi-base: JSON array, e.g. '[{"base_name":"CRM","api_token":"..."}]'
        SEATABLE_BASES: z.string().optional(),
        LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
        HTTP_TIMEOUT_MS: z
            .string()
            .optional()
            .transform((v) => (v ? Number(v) : undefined))
            .pipe(z.number().int().positive().optional()),
        SEATABLE_MOCK: z
            .string()
            .optional()
            .transform((v) => (v === '1' || v === 'true' ? true : false))
            .optional(),
        // Feature flags
        SEATABLE_ENABLE_FIND_ROWS: z
            .string()
            .optional()
            .transform((v) => (v === '1' || v === 'true' ? true : false))
            .optional(),
        // Debug / experimental tools (e.g. echo_args). Should NEVER be enabled in production unless explicitly needed.
        SEATABLE_ENABLE_DEBUG_TOOLS: z
            .string()
            .optional()
            .transform((v) => (v === '1' || v === 'true' ? true : false))
            .optional(),
    })
    .superRefine((data, ctx) => {
        if (data.SEATABLE_MODE === 'selfhosted' && !data.SEATABLE_API_TOKEN && !data.SEATABLE_BASES) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'SEATABLE_API_TOKEN or SEATABLE_BASES is required in selfhosted mode',
                path: ['SEATABLE_API_TOKEN'],
            })
        }
    })

export type Env = z.infer<typeof EnvSchema>

type EnvOverrides = Partial<Record<keyof Env, string>>

let overrides: Record<string, string> | undefined

function buildEnvSource(): Record<string, string | undefined> {
    const base = typeof process !== 'undefined' && process.env ? { ...process.env } : {}
    return overrides ? { ...base, ...overrides } : base
}

export function setEnvOverrides(values: EnvOverrides | undefined): void {
    if (!values) return
    overrides = overrides ?? {}
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string') {
            overrides[key] = value
        } else if (value === undefined) {
            delete overrides[key]
        }
    }
}

export function clearEnvOverrides(): void {
    overrides = undefined
}

export interface BaseEntry {
    name: string
    apiToken: string
}

export function parseBases(raw: string): BaseEntry[] {
    let arr: unknown
    try {
        arr = JSON.parse(raw)
    } catch {
        throw new Error('SEATABLE_BASES must be a valid JSON array, e.g. \'[{"base_name":"CRM","api_token":"..."}]\'')
    }
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error('SEATABLE_BASES must be a non-empty JSON array')
    }
    return arr.map((entry: unknown, i: number) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new Error(`SEATABLE_BASES[${i}]: expected an object`)
        }
        const obj = entry as Record<string, unknown>
        if (typeof obj.base_name !== 'string' || !obj.base_name) {
            throw new Error(`SEATABLE_BASES[${i}]: missing or empty "base_name"`)
        }
        if (typeof obj.api_token !== 'string' || !obj.api_token) {
            throw new Error(`SEATABLE_BASES[${i}]: missing or empty "api_token"`)
        }
        return { name: obj.base_name, apiToken: obj.api_token }
    })
}

export function getEnv(): Env {
    const parsed = EnvSchema.safeParse(buildEnvSource())
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
        throw new Error(`Invalid environment configuration:\n${issues}`)
    }
    return parsed.data
}

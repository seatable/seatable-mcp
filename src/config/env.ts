import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

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
        // Multi-base: comma-separated "Name:token" pairs, e.g. "CRM:token_abc,Projects:token_def"
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
    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const colonIdx = entry.indexOf(':')
            if (colonIdx <= 0) {
                throw new Error(`Invalid SEATABLE_BASES entry: "${entry}" (expected "Name:token")`)
            }
            return {
                name: entry.slice(0, colonIdx).trim(),
                apiToken: entry.slice(colonIdx + 1).trim(),
            }
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

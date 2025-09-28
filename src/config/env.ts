import { config as loadEnv } from 'dotenv'
import { z } from 'zod'

if (typeof process !== 'undefined' && process.versions?.node) {
    loadEnv()
}

const EnvSchema = z.object({
    SEATABLE_SERVER_URL: z.string().url(),
    SEATABLE_API_TOKEN: z.string().min(1),
    SEATABLE_BASE_UUID: z.string().min(1),
    SEATABLE_TABLE_NAME: z.string().optional(),
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
    SEATABLE_TOKEN_ENDPOINT_PATH: z.string().optional(),
    // Expiry string passed to app-access-token endpoint, e.g., '3d', '1h'
    SEATABLE_ACCESS_TOKEN_EXP: z.string().optional(),
    // Feature flags
    SEATABLE_ENABLE_FIND_ROWS: z
        .string()
        .optional()
        .transform((v) => (v === '1' || v === 'true' ? true : false))
        .optional(),
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

export function getEnv(): Env {
    const parsed = EnvSchema.safeParse(buildEnvSource())
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
        throw new Error(`Invalid environment configuration:\n${issues}`)
    }
    return parsed.data
}

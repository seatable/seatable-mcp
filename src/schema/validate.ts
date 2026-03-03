import { z } from 'zod'

import { makeError } from '../errors.js'
import type { GenericColumn, GenericSchema } from './generic.js'

export const ValidateOptionsSchema = z.object({
    allowCreateColumns: z.boolean().default(false),
})
export type ValidateOptions = z.infer<typeof ValidateOptionsSchema>

const READ_ONLY_TYPES = new Set([
    'formula',
    'creator',
    'ctime',
    'mtime',
    'auto_number',
    'button',
    'link_formula',
    'digital_sign',
    'link',
])

export function validateRowsAgainstSchema(
    schema: GenericSchema,
    tableName: string,
    rows: Array<Record<string, unknown>>,
    opts?: Partial<ValidateOptions>
): { rows: Array<Record<string, unknown>>; unknownColumns: string[] } {
    const options = ValidateOptionsSchema.parse({ allowCreateColumns: false, ...(opts || {}) })
    const table = schema.tables.find((t) => t.name === tableName)
    if (!table) {
        throw makeError('ERR_SCHEMA_UNKNOWN_TABLE', 'ERR_SCHEMA_UNKNOWN_TABLE', { tableName })
    }

    const columnMap = new Map<string, GenericColumn>()
    for (const col of table.columns) {
        columnMap.set(col.name, col)
    }

    const allowed = new Set(table.columns.map((c) => c.name))
    const unknown = new Set<string>()

    for (const row of rows) {
        // Strip read-only columns silently
        for (const key of Object.keys(row)) {
            const col = columnMap.get(key)
            if (col && READ_ONLY_TYPES.has(col.type)) {
                delete row[key]
            }
        }

        // Check unknown columns
        for (const key of Object.keys(row)) {
            if (!allowed.has(key)) unknown.add(key)
        }

        // Type-specific validation & coercion
        for (const key of Object.keys(row)) {
            const col = columnMap.get(key)
            if (!col) continue

            if (col.type === 'checkbox') {
                row[key] = coerceCheckbox(key, row[key])
            } else if (col.type === 'rate') {
                validateRating(key, row[key], col)
            } else if (col.type === 'date' || col.type === 'datetime') {
                validateDate(key, row[key])
            } else if (col.type === 'geolocation') {
                validateGeolocation(key, row[key])
            } else if (col.type === 'single_select') {
                validateSingleSelect(key, row[key], col)
            } else if (col.type === 'multi_select') {
                validateMultiSelect(key, row[key], col)
            }
        }
    }

    const unknownColumns = Array.from(unknown)
    if (unknownColumns.length && !options.allowCreateColumns) {
        throw makeError('ERR_SCHEMA_UNKNOWN_COLUMN', `Unknown columns: ${unknownColumns.join(', ')}`, {
            tableName,
            unknownColumns,
        })
    }

    return { rows, unknownColumns }
}

function coerceCheckbox(colName: string, value: unknown): boolean {
    if (typeof value === 'boolean') return value
    if (value === 1 || value === '1' || value === 'true') return true
    if (value === 0 || value === '0' || value === 'false') return false
    throw makeError('ERR_VALIDATION', `Column "${colName}": invalid checkbox value "${value}". Use true/false.`, {
        column: colName,
        value,
    })
}

function validateRating(colName: string, value: unknown, col: GenericColumn): void {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw makeError('ERR_VALIDATION', `Column "${colName}": rating must be an integer.`, {
            column: colName,
            value,
        })
    }
    const max = (col.options?.rate_max_number as number) || 5
    if (value < 1 || value > max) {
        throw makeError('ERR_VALIDATION', `Column "${colName}": rating must be between 1 and ${max}.`, {
            column: colName,
            value,
            max,
        })
    }
}

function validateDate(colName: string, value: unknown): void {
    if (typeof value !== 'string') {
        throw makeError('ERR_VALIDATION', `Column "${colName}": date must be a string.`, {
            column: colName,
            value,
        })
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
        throw makeError(
            'ERR_VALIDATION',
            `Column "${colName}": date must start with YYYY-MM-DD format, got "${value}".`,
            { column: colName, value }
        )
    }
}

function getSelectOptions(col: GenericColumn): Set<string> {
    const opts = col.options?.options as Array<{ name: string }> | undefined
    if (!Array.isArray(opts)) return new Set()
    return new Set(opts.map((o) => o.name))
}

function validateSingleSelect(colName: string, value: unknown, col: GenericColumn): void {
    if (value == null || value === '') return
    if (typeof value !== 'string') {
        throw makeError('ERR_VALIDATION', `Column "${colName}": single-select value must be a string.`, {
            column: colName,
            value,
        })
    }
    const valid = getSelectOptions(col)
    if (valid.size > 0 && !valid.has(value)) {
        throw makeError(
            'ERR_VALIDATION',
            `Column "${colName}": unknown option "${value}". Valid options: ${[...valid].join(', ')}`,
            { column: colName, value, validOptions: [...valid] }
        )
    }
}

function validateMultiSelect(colName: string, value: unknown, col: GenericColumn): void {
    if (value == null) return
    if (!Array.isArray(value)) {
        throw makeError('ERR_VALIDATION', `Column "${colName}": multi-select value must be an array.`, {
            column: colName,
            value,
        })
    }
    const valid = getSelectOptions(col)
    if (valid.size === 0) return
    for (const item of value) {
        if (typeof item !== 'string') {
            throw makeError('ERR_VALIDATION', `Column "${colName}": multi-select values must be strings.`, {
                column: colName,
                value: item,
            })
        }
        if (!valid.has(item)) {
            throw makeError(
                'ERR_VALIDATION',
                `Column "${colName}": unknown option "${item}". Valid options: ${[...valid].join(', ')}`,
                { column: colName, value: item, validOptions: [...valid] }
            )
        }
    }
}

function validateGeolocation(colName: string, value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const obj = value as Record<string, unknown>
    const hasLat = 'lat' in obj
    const hasLng = 'lng' in obj
    if (hasLat !== hasLng) {
        const missing = hasLat ? 'lng' : 'lat'
        throw makeError(
            'ERR_VALIDATION',
            `Column "${colName}": geolocation requires both "lat" and "lng", missing "${missing}".`,
            { column: colName, missing }
        )
    }
}

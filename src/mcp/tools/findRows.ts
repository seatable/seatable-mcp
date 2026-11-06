import { z } from 'zod'

import { makeError } from '../../errors.js'
import type { SeaTableRow } from '../../seatable/types.js'
import { ToolRegistrar } from './types.js'

// Zod schema for the DSL (kept for reference/tests but not enforced at the boundary)
const FieldRef = z.object({ field: z.string() })
const Eq = z.object({ eq: FieldRef.extend({ value: z.any() }) })
const Ne = z.object({ ne: FieldRef.extend({ value: z.any() }) })
const In = z.object({ in: FieldRef.extend({ values: z.array(z.any()) }) })
const CmpValue = z.any()
const Gt = z.object({ gt: FieldRef.extend({ value: CmpValue }) })
const Gte = z.object({ gte: FieldRef.extend({ value: CmpValue }) })
const Lt = z.object({ lt: FieldRef.extend({ value: CmpValue }) })
const Lte = z.object({ lte: FieldRef.extend({ value: CmpValue }) })
const Contains = z.object({ contains: FieldRef.extend({ value: z.string(), case_sensitive: z.boolean().optional() }) })
const StartsWith = z.object({ starts_with: FieldRef.extend({ value: z.string(), case_sensitive: z.boolean().optional() }) })
const EndsWith = z.object({ ends_with: FieldRef.extend({ value: z.string(), case_sensitive: z.boolean().optional() }) })
const IsNull = z.object({ is_null: FieldRef })

export const Where: z.ZodTypeAny = z.lazy(() =>
  z.union([
    Eq,
    Ne,
    In,
    Gt,
    Gte,
    Lt,
    Lte,
    Contains,
    StartsWith,
    EndsWith,
    IsNull,
    z.object({ and: z.array(Where).min(1) }),
    z.object({ or: z.array(Where).min(1) }),
    z.object({ not: Where }),
  ])
)
export type Where = z.infer<typeof Where>

// Use a loose schema for boundary parsing
const InputSchema = z.object({
  table: z.string().describe('Target table name'),
  where: z.unknown().optional().describe('Filter predicate (e.g. {"eq":{"field":"Name","value":"foo"}} or shorthand {"Name":"foo"})'),
  page: z.number().int().min(1).optional().default(1).describe('Page number (1-based)'),
  page_size: z.number().int().min(1).max(1000).optional().default(100).describe('Rows per page (max 1000)'),
  order_by: z.string().optional().describe('Column name to sort by'),
  direction: z.enum(['asc', 'desc']).optional().default('asc').describe('Sort direction'),
})

function toStringSafe(v: unknown): string {
  return v == null ? '' : String(v)
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = toStringSafe(a)
  const bs = toStringSafe(b)
  if (as < bs) return -1
  if (as > bs) return 1
  return 0
}

function get(row: SeaTableRow, path: string): unknown {
  // Simple top-level field lookup; can extend to dotted paths later
  return (row as any)[path]
}

// Models often send values as text. Only plain numbers count: "55,99" and "1,000"
// could mean several things, and Number() would also accept "", "0x10" and "1e3".
function plainNumber(text: string): number | undefined {
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : undefined
}

/** Is the cell equal to a filter value, which may be of another type? */
function matchesValue(cell: unknown, value: unknown): boolean {
  if (cell === value) return true
  if (typeof cell === 'number' && typeof value === 'string') return plainNumber(value) === cell
  if (typeof cell === 'string' && typeof value === 'number') return cell === String(value)
  if (typeof cell === 'boolean' && typeof value === 'string') return value === String(cell)
  return false
}

/**
 * Order a cell against a filter value of another type as numbers. As text, "9.49"
 * would be greater than "10". NaN fails every comparison, so what can't be read as
 * a number matches nothing, and neither does an empty cell, as in SQL.
 */
function compareToValue(cell: unknown, value: unknown): number {
  if (cell === undefined || cell === null || cell === '' || value === undefined || value === null) return NaN
  if (typeof cell === 'number' && typeof value === 'string') return cell - (plainNumber(value) ?? NaN)
  if (typeof cell === 'string' && typeof value === 'number') return (plainNumber(cell) ?? NaN) - value
  return compare(cell, value)
}

export function evalWhere(row: SeaTableRow, where: any): boolean {
  if (where == null) return true
  if (where.and) return (where.and as any[]).every((w: any) => evalWhere(row, w))
  if (where.or) return (where.or as any[]).some((w: any) => evalWhere(row, w))
  if (where.not) return !evalWhere(row, where.not as any)

  if (where.eq) {
    const { field, value } = where.eq
    return matchesValue(get(row, field), value)
  }
  if (where.ne) {
    const { field, value } = where.ne
    return !matchesValue(get(row, field), value)
  }
  if (where.in) {
    const { field, values } = where.in
    const v = get(row, field)
    return (values as unknown[]).some((x) => matchesValue(v, x))
  }
  if (where.gt) {
    const { field, value } = where.gt
    return compareToValue(get(row, field), value) > 0
  }
  if (where.gte) {
    const { field, value } = where.gte
    return compareToValue(get(row, field), value) >= 0
  }
  if (where.lt) {
    const { field, value } = where.lt
    return compareToValue(get(row, field), value) < 0
  }
  if (where.lte) {
    const { field, value } = where.lte
    return compareToValue(get(row, field), value) <= 0
  }
  if (where.contains) {
    const { field, value, case_sensitive } = where.contains
    const sv = toStringSafe(get(row, field))
    const needle = String(value)
    return case_sensitive ? sv.includes(needle) : sv.toLowerCase().includes(needle.toLowerCase())
  }
  if (where.starts_with) {
    const { field, value, case_sensitive } = where.starts_with
    const sv = toStringSafe(get(row, field))
    const needle = String(value)
    return case_sensitive ? sv.startsWith(needle) : sv.toLowerCase().startsWith(needle.toLowerCase())
  }
  if (where.ends_with) {
    const { field, value, case_sensitive } = where.ends_with
    const sv = toStringSafe(get(row, field))
    const needle = String(value)
    return case_sensitive ? sv.endsWith(needle) : sv.toLowerCase().endsWith(needle.toLowerCase())
  }
  if (where.is_null) {
    const { field } = where.is_null
    const v = get(row, field)
    return v == null
  }
  return false
}

// Map common operator aliases to canonical DSL operators
const OP_ALIASES: Record<string, string> = {
  '=': 'eq', '==': 'eq', '===': 'eq', 'equals': 'eq',
  '!=': 'ne', '!==': 'ne', '<>': 'ne', 'not_equal': 'ne',
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  'like': 'contains', '$eq': 'eq', '$ne': 'ne', '$gt': 'gt',
  '$gte': 'gte', '$lt': 'lt', '$lte': 'lte', '$in': 'in',
  '$contains': 'contains',
}

// Detect { column/field, op/operator, value } pattern from weaker models
function normalizeFilterObject(where: any): any | null {
  const col = where.column ?? where.field ?? where.col
  const op = where.op ?? where.operator ?? where.operation
  if (typeof col !== 'string' || op == null) return null

  const canonicalOp = OP_ALIASES[String(op).toLowerCase()] ?? String(op).toLowerCase()
  const val = where.value ?? where.values

  if (canonicalOp === 'in') return { in: { field: col, values: Array.isArray(val) ? val : [val] } }
  if (canonicalOp === 'is_null') return { is_null: { field: col } }
  return { [canonicalOp]: { field: col, value: val } }
}

// Detect MongoDB-style { ColumnName: { $op: value } }
function normalizeMongoStyle(where: any): any | null {
  const entries = Object.entries(where)
  if (entries.length === 0) return null
  // Every value must be an object with exactly one $-prefixed key
  if (!entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Object.keys(v)[0].startsWith('$'))) return null

  const clauses = entries.map(([field, cond]: [string, any]) => {
    const [mongoOp, val] = Object.entries(cond)[0]
    const canonicalOp = OP_ALIASES[mongoOp.toLowerCase()] ?? mongoOp.slice(1).toLowerCase()
    if (canonicalOp === 'in') return { in: { field, values: Array.isArray(val) ? val : [val] } }
    if (canonicalOp === 'is_null') return { is_null: { field } }
    return { [canonicalOp]: { field, value: val } }
  })
  return clauses.length === 1 ? clauses[0] : { and: clauses }
}

function invalidWhere() {
  return makeError('ERR_VALIDATION', 'where must be an object, e.g. {"eq":{"field":"Name","value":"foo"}} or {"Name":"foo"}')
}

function parseWhereString(where: string): object {
  let parsed: unknown
  try {
    parsed = JSON.parse(where)
  } catch {
    throw invalidWhere()
  }
  if (parsed === null || typeof parsed !== 'object') throw invalidWhere()
  return parsed
}

const VALUE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with'])

function invalidCondition(problem: string) {
  return makeError('ERR_VALIDATION', `Invalid where: ${problem}. Example: {"eq":{"field":"Name","value":"foo"}}`)
}

/** Reject what evalWhere() couldn't apply. An empty "and" stays valid: it's how {} and [] mean "no filter". */
function checkCondition(where: any): void {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) throw invalidWhere()
  const operators = Object.keys(where)
  if (operators.length !== 1) throw invalidCondition(`a condition needs exactly one operator, got: ${operators.join(', ')}`)

  const operator = operators[0]
  const arg = where[operator]
  if (operator === 'and' || operator === 'or') {
    if (!Array.isArray(arg) || (operator === 'or' && arg.length === 0)) throw invalidCondition(`"${operator}" needs a list of conditions`)
    arg.forEach(checkCondition)
    return
  }
  if (operator === 'not') {
    checkCondition(arg)
    return
  }
  if (operator !== 'in' && operator !== 'is_null' && !VALUE_OPERATORS.has(operator)) {
    throw invalidCondition(`unknown operator "${operator}"`)
  }
  if (typeof arg?.field !== 'string') throw invalidCondition(`"${operator}" needs a field`)
  if (operator === 'in' && !Array.isArray(arg.values)) throw invalidCondition('"in" needs a list of values')
  if (VALUE_OPERATORS.has(operator) && !('value' in arg)) throw invalidCondition(`"${operator}" needs a value`)
}

/** The columns a checked condition refers to. */
function fieldsOf(where: any): string[] {
  if (where === undefined || where === null) return []
  if (where.and || where.or) return (where.and ?? where.or).flatMap(fieldsOf)
  if (where.not) return fieldsOf(where.not)
  return [(Object.values(where)[0] as { field: string }).field]
}

/**
 * An unknown column matches no row either. The metadata decides, as a table may
 * have no rows; as it is cached, a column created a moment ago still counts if a
 * row has it. Tables the metadata doesn't know are left to the lookup of the rows.
 * System columns start with an underscore.
 */
function checkColumnsExist(metadata: any, table: string, fields: string[], rows: SeaTableRow[]): void {
  const columns: Array<{ name: string }> | undefined = metadata?.tables?.find((t: any) => t.name === table)?.columns
  if (!columns) return
  const known = new Set(columns.map((c) => c.name))
  const missing = [...new Set(fields)].filter((f) => !f.startsWith('_') && !known.has(f) && !rows.some((r) => f in r))
  if (missing.length > 0) {
    const names = missing.map((f) => `"${f}"`).join(', ')
    throw makeError('ERR_SCHEMA_UNKNOWN_COLUMN', `Column ${names} not found in table "${table}". Columns: ${[...known].join(', ')}`)
  }
}

// Normalize shorthand forms:
// 1) { column, op, value } or { field, operator, value } -> canonical DSL
// 2) { Name: { $eq: "foo" } } (MongoDB-style) -> canonical DSL
// 3) { Name: "foo", Status: "bar" } -> { and: [ { eq: { field:'Name', value:'foo'} }, ... ] }
// 4) { or: [ ... ] } etc. -> recursively normalized
// 5) a JSON string, as weaker models send it -> the object it contains
// Anything it can't apply is an error: evalWhere() would reject every row, and
// "0 rows" reads like a real answer and sends the model searching elsewhere.
export function normalizeWhere(where: any): any {
  const normalized = normalize(where)
  if (normalized !== undefined && normalized !== null) checkCondition(normalized)
  return normalized
}

function normalize(where: any): any {
  if (where === undefined || where === null) return where
  if (typeof where === 'string') return normalize(parseWhereString(where))
  if (typeof where !== 'object') throw invalidWhere()

  // Array of conditions → AND
  if (Array.isArray(where)) {
    const clauses = where.map((w: any) => normalize(w))
    return clauses.length === 1 ? clauses[0] : { and: clauses }
  }

  // { column/field, op, value } pattern
  const filterObj = normalizeFilterObject(where)
  if (filterObj) return filterObj

  // Canonical DSL operators
  const operatorKeys = ['eq','ne','in','gt','gte','lt','lte','contains','starts_with','ends_with','is_null','and','or','not']
  if (operatorKeys.some(k => k in where)) {
    if (Array.isArray(where.and)) where.and = where.and.map((w: any) => normalize(w))
    if (Array.isArray(where.or)) where.or = where.or.map((w: any) => normalize(w))
    if (where.not) where.not = normalize(where.not)
    return where
  }

  // MongoDB-style { Name: { $eq: value } }
  const mongoNorm = normalizeMongoStyle(where)
  if (mongoNorm) return mongoNorm

  // Plain object => conjunction of eq clauses
  const entries = Object.entries(where)
  const clauses = entries.map(([field, value]) => ({ eq: { field, value } }))
  if (clauses.length === 1) return clauses[0]
  return { and: clauses }
}

export const registerFindRows: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'find_rows',
    {
      title: 'Find Rows',
      description:
        'Find rows using a predicate DSL. Filtering is performed client-side. ' +
        'where is an object, not a string: {"eq":{"field":"Name","value":"foo"}} or shorthand {"Name":"foo"}. ' +
        'Operators: eq, ne, in, gt, gte, lt, lte, contains, starts_with, ends_with, is_null. ' +
        'Combine with {"and":[...]} or {"or":[...]}. Negate with {"not":{...}}.',
      inputSchema: getInputSchema(InputSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: unknown) => {
      const parsed = InputSchema.parse(args)
      const normalizedWhere = normalizeWhere(parsed.where)
      const pageSizeFetch = 1000
      const maxPages = 50 // safety cap (50k rows scanned)
      let page = 1
      const all: SeaTableRow[] = []
      while (page <= maxPages) {
        const res = await client.listRows({ table: parsed.table, page, page_size: pageSizeFetch })
        all.push(...res.rows)
        if (!res.rows.length || res.rows.length < pageSizeFetch) break
        page += 1
      }

      const fields = [...fieldsOf(normalizedWhere), ...(parsed.order_by ? [parsed.order_by] : [])]
      if (fields.length > 0) checkColumnsExist(await client.getMetadata(), parsed.table, fields, all)

      // Apply predicate locally
  let matched = all.filter((r) => evalWhere(r, normalizedWhere))

      // Optional ordering
      if (parsed.order_by) {
        const dir = parsed.direction === 'desc' ? -1 : 1
        matched = matched.sort((a, b) => dir * compare((a as any)[parsed.order_by!], (b as any)[parsed.order_by!]))
      }

      // Paginate locally
      const pageOut = parsed.page ?? 1
      const pageSizeOut = parsed.page_size ?? 100
      const start = (pageOut - 1) * pageSizeOut
      const end = start + pageSizeOut
      const slice = matched.slice(start, end)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ rows: slice, page: pageOut, page_size: pageSizeOut, total: matched.length }),
          },
        ],
      }
    }
  )
}

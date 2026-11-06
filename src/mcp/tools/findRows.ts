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
  '=': 'eq', '==': 'eq', '===': 'eq', 'equals': 'eq', 'equal': 'eq',
  '!=': 'ne', '!==': 'ne', '<>': 'ne', 'not_equal': 'ne', 'not_equals': 'ne',
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
  'like': 'contains', 'startswith': 'starts_with', 'endswith': 'ends_with',
  'nin': 'not_in', 'notin': 'not_in', 'isnull': 'is_null',
  'not_null': 'is_not_null', 'notnull': 'is_not_null',
}

const VALUE_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with'])
const FIELD_OPERATORS = new Set([...VALUE_OPERATORS, 'in', 'not_in', 'is_null', 'is_not_null'])
const OPERATORS = new Set([...FIELD_OPERATORS, 'and', 'or', 'not'])

function canonicalOperator(name: string): string {
  const plain = name.toLowerCase().replace(/^\$/, '')
  return OP_ALIASES[plain] ?? plain
}

const isPlainObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const allOf = (clauses: any[]) => (clauses.length === 1 ? clauses[0] : { and: clauses })

/** The canonical condition for an operator, a column and its value or values. */
function condition(op: string, field: string, value: unknown): any {
  if (op === 'in') return { in: { field, values: Array.isArray(value) || value === undefined ? value : [value] } }
  if (op === 'not_in') return { not: condition('in', field, value) }
  if (op === 'is_null') return { is_null: { field } }
  if (op === 'is_not_null') return { not: { is_null: { field } } }
  if (Array.isArray(value) && op === 'eq') return condition('in', field, value)
  if (Array.isArray(value) && op === 'ne') return condition('not_in', field, value)
  return { [op]: { field, value } }
}

const valueOf = (arg: Record<string, any>) => ('value' in arg ? arg.value : arg.values)

/** An operator's argument in any form we can read. What we can't stays as it is, for checkCondition() to report. */
function conditionFromArg(op: string, arg: any): any {
  if (typeof arg === 'string' && (op === 'is_null' || op === 'is_not_null')) return condition(op, arg, undefined)
  if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') return condition(op, arg[0], arg[1])
  if (!isPlainObject(arg)) return { [op]: arg }

  const hasValue = 'value' in arg || 'values' in arg
  const field = arg.field ?? arg.column ?? arg.col ?? (hasValue ? arg.name : undefined)
  if (typeof field === 'string') return condition(op, field, valueOf(arg))
  const entries = Object.entries(arg)
  if (hasValue || entries.length === 0) return { [op]: arg }
  return allOf(entries.map(([column, value]) => condition(op, column, value)))
}

/** One key of a filter object: an operator or a column. */
function normalizeEntry(key: string, value: any): any {
  const op = canonicalOperator(key)
  if (op === 'and' || op === 'or') {
    if (Array.isArray(value)) return { [op]: value.map(normalize) }
    if (isPlainObject(value)) return { [op]: Object.entries(value).map(([k, v]) => normalizeEntry(k, v)) }
    return { [op]: value }
  }
  if (op === 'not') return { not: normalize(value) }

  if (FIELD_OPERATORS.has(op)) {
    const isFilter = isPlainObject(value) || Array.isArray(value) || (typeof value === 'string' && key.toLowerCase().includes('null'))
    if (isFilter) return conditionFromArg(op, value)
    // "eq" with a plain value is a mistake, a column called "Like" is not
    if (key === op) return { [op]: value }
  }
  if (key.startsWith('$')) return { [op]: value }
  // Shaped like a condition, so the key was meant as an operator we don't know
  if (isPlainObject(value) && (value.field ?? value.column ?? value.col) !== undefined && ('value' in value || 'values' in value)) return { [op]: value }

  if (Array.isArray(value)) return condition('in', key, value)
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    const areOperators = entries.length > 0 && entries.every(([k]) => k.startsWith('$') || OPERATORS.has(canonicalOperator(k)))
    if (areOperators) return allOf(entries.map(([k, v]) => condition(canonicalOperator(k), key, v)))
  }
  return condition('eq', key, value)
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
    throw invalidCondition(`unknown operator "${operator}", use one of ${[...OPERATORS].join(', ')}`)
  }
  if (typeof arg?.field !== 'string') throw invalidCondition(`"${operator}" needs a field`)
  if (operator === 'in' && !Array.isArray(arg.values)) throw invalidCondition('"in" needs a list of values')
  if (VALUE_OPERATORS.has(operator)) {
    if (arg.value === undefined) throw invalidCondition(`"${operator}" needs a value`)
    if (arg.value !== null && typeof arg.value === 'object') throw invalidCondition(`column "${arg.field}" needs a single value for "${operator}", not an object or list`)
  }
}

function renameFields(where: any, names: Map<string, string>): void {
  if (where === undefined || where === null) return
  if (where.and || where.or) (where.and ?? where.or).forEach((w: any) => renameFields(w, names))
  else if (where.not) renameFields(where.not, names)
  else {
    const arg: any = Object.values(where)[0]
    arg.field = names.get(arg.field) ?? arg.field
  }
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
 * System columns start with an underscore. Returns the names it can correct: SQL
 * quotes and a different case, if only one column fits. A typo stays an error.
 */
function resolveColumns(metadata: any, table: string, fields: string[], rows: SeaTableRow[]): Map<string, string> {
  const names = new Map<string, string>()
  const columns: Array<{ name: string }> | undefined = metadata?.tables?.find((t: any) => t.name === table)?.columns
  if (!columns) return names

  const known = columns.map((c) => c.name)
  const missing: string[] = []
  for (const field of new Set(fields)) {
    const name = field.replace(/^`|`$/g, '')
    if (name.startsWith('_') || known.includes(name) || rows.some((r) => name in r)) {
      if (name !== field) names.set(field, name)
      continue
    }
    const sameCase = known.filter((k) => k.toLowerCase() === name.toLowerCase())
    if (sameCase.length === 1) names.set(field, sameCase[0])
    else missing.push(field)
  }
  if (missing.length > 0) {
    const list = missing.map((f) => `"${f}"`).join(', ')
    throw makeError('ERR_SCHEMA_UNKNOWN_COLUMN', `Column ${list} not found in table "${table}". Columns: ${known.join(', ')}`)
  }
  return names
}

// Reads a filter in the forms models send, as long as the meaning is clear:
// 1) a JSON string -> the object it contains
// 2) { column, op, value } or { field, operator, value }, also without op
// 3) { Name: "foo", Status: "bar" } -> all of them; a list -> in
// 4) { Name: { $eq: "foo" } }, { Name: { eq: "foo" } }, { Betrag: { gt: 1, lt: 9 } }
// 5) { eq: { column: "Name", value: "foo" } }, { eq: { Name: "foo" } }, { eq: ["Name", "foo"] }
// 6) operator aliases such as "=", "EQ", "$eq", "not_in", "is_not_null"
// 7) several operators next to each other -> all of them
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
  const column = where.column ?? where.field ?? where.col
  const op = where.op ?? where.operator ?? where.operation
  if (typeof column === 'string' && op != null) return condition(canonicalOperator(String(op)), column, valueOf(where))
  if (typeof column === 'string' && 'value' in where) return condition('eq', column, where.value)

  return allOf(Object.entries(where).map(([key, value]) => normalizeEntry(key, value)))
}

export const registerFindRows: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'find_rows',
    {
      title: 'Find Rows',
      description:
        'Find rows using a predicate DSL. Filtering is performed client-side. ' +
        'where is an object, not a string: {"eq":{"field":"Name","value":"foo"}} or shorthand {"Name":"foo"}. ' +
        'Operators: eq, ne, in, not_in, gt, gte, lt, lte, contains, starts_with, ends_with, is_null, is_not_null. ' +
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
      const corrected = fields.length > 0 ? resolveColumns(await client.getMetadata(), parsed.table, fields, all) : new Map<string, string>()
      renameFields(normalizedWhere, corrected)
      const orderBy = parsed.order_by && (corrected.get(parsed.order_by) ?? parsed.order_by)
      const notice = corrected.size > 0
        ? [...corrected].map(([from, to]) => `Read column "${from}" as "${to}".`).join(' ')
        : undefined

      // Apply predicate locally
  let matched = all.filter((r) => evalWhere(r, normalizedWhere))

      // Optional ordering
      if (orderBy) {
        const dir = parsed.direction === 'desc' ? -1 : 1
        matched = matched.sort((a, b) => dir * compare((a as any)[orderBy], (b as any)[orderBy]))
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
            text: JSON.stringify({ ...(notice && { notice }), rows: slice, page: pageOut, page_size: pageSizeOut, total: matched.length }),
          },
        ],
      }
    }
  )
}

import { z } from 'zod'

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
  where: z.unknown().describe('Filter predicate (e.g. {"eq":{"field":"Name","value":"foo"}} or shorthand {"Name":"foo"})'),
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

export function evalWhere(row: SeaTableRow, where: any): boolean {
  if (where == null) return true
  if (where.and) return (where.and as any[]).every((w: any) => evalWhere(row, w))
  if (where.or) return (where.or as any[]).some((w: any) => evalWhere(row, w))
  if (where.not) return !evalWhere(row, where.not as any)

  if (where.eq) {
    const { field, value } = where.eq
    return get(row, field) === value
  }
  if (where.ne) {
    const { field, value } = where.ne
    return get(row, field) !== value
  }
  if (where.in) {
    const { field, values } = where.in
    const v = get(row, field)
    return (values as unknown[]).some((x) => x === v)
  }
  if (where.gt) {
    const { field, value } = where.gt
    return compare(get(row, field), value) > 0
  }
  if (where.gte) {
    const { field, value } = where.gte
    return compare(get(row, field), value) >= 0
  }
  if (where.lt) {
    const { field, value } = where.lt
    return compare(get(row, field), value) < 0
  }
  if (where.lte) {
    const { field, value } = where.lte
    return compare(get(row, field), value) <= 0
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

// Normalize shorthand forms:
// 1) { column, op, value } or { field, operator, value } -> canonical DSL
// 2) { Name: { $eq: "foo" } } (MongoDB-style) -> canonical DSL
// 3) { Name: "foo", Status: "bar" } -> { and: [ { eq: { field:'Name', value:'foo'} }, ... ] }
// 4) { or: [ ... ] } etc. -> recursively normalized
export function normalizeWhere(where: any): any {
  if (!where || typeof where !== 'object') return where

  // Array of conditions → AND
  if (Array.isArray(where)) {
    const clauses = where.map((w: any) => normalizeWhere(w))
    return clauses.length === 1 ? clauses[0] : { and: clauses }
  }

  // { column/field, op, value } pattern
  const filterObj = normalizeFilterObject(where)
  if (filterObj) return filterObj

  // Canonical DSL operators
  const operatorKeys = ['eq','ne','in','gt','gte','lt','lte','contains','starts_with','ends_with','is_null','and','or','not']
  if (operatorKeys.some(k => k in where)) {
    if (Array.isArray(where.and)) where.and = where.and.map((w: any) => normalizeWhere(w))
    if (Array.isArray(where.or)) where.or = where.or.map((w: any) => normalizeWhere(w))
    if (where.not) where.not = normalizeWhere(where.not)
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
        'where format: {"eq":{"field":"Name","value":"foo"}} or shorthand {"Name":"foo"}. ' +
        'Operators: eq, ne, in, gt, gte, lt, lte, contains, starts_with, ends_with, is_null. ' +
        'Combine with {"and":[...]} or {"or":[...]}. Negate with {"not":{...}}.',
      inputSchema: getInputSchema(InputSchema),
      annotations: { readOnlyHint: true },
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

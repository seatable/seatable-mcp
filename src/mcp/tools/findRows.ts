import { z } from 'zod'

import { getEnv } from '../../config/env.js'
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
  table: z.string(),
  where: z.unknown(), // Accept anything; we'll normalize below
  page: z.number().int().min(1).optional().default(1),
  page_size: z.number().int().min(1).max(1000).optional().default(100),
  order_by: z.string().optional(),
  direction: z.enum(['asc', 'desc']).optional().default('asc'),
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

// Normalize shorthand forms:
// 1) { Name: "foo", Status: "bar" } -> { and: [ { eq: { field:'Name', value:'foo'} }, { eq: { field:'Status', value:'bar'} } ] }
// 2) { or: [ { Name: 'x' }, { eq:{ field:'Y', value:1}} ] } -> recursively normalized
// 3) primitives or unexpected shapes are passed through
function normalizeWhere(where: any, nameToKey?: Record<string,string>): any {
  if (!where || typeof where !== 'object') return where
  const operatorKeys = ['eq','ne','in','gt','gte','lt','lte','contains','starts_with','ends_with','is_null','and','or','not']
  if (operatorKeys.some(k => k in where)) {
    // Recurse logical wrappers
  if (Array.isArray(where.and)) where.and = where.and.map((w: any) => normalizeWhere(w, nameToKey))
  if (Array.isArray(where.or)) where.or = where.or.map((w: any) => normalizeWhere(w, nameToKey))
    if (where.not) where.not = normalizeWhere(where.not, nameToKey)
    // Map field names inside leaf operators
    for (const op of operatorKeys) {
      if (where[op] && where[op].field && nameToKey && nameToKey[where[op].field]) {
        where[op].field = nameToKey[where[op].field]
      }
    }
    return where
  }
  // Plain object => conjunction of eq clauses; map display names
  const entries = Object.entries(where)
  const clauses = entries.map(([field,value]) => {
    const mapped = nameToKey && nameToKey[field] ? nameToKey[field] : field
    return { eq: { field: mapped, value }}
  })
  if (clauses.length === 1) return clauses[0]
  return { and: clauses }
}

export const registerFindRows: ToolRegistrar = (server, { client, getInputSchema }) => {
  server.registerTool(
    'find_rows',
    {
      title: 'Find Rows',
      description:
        'Find rows using a predicate DSL. Filtering is performed client-side for broad compatibility. Supports and/or/not, eq, ne, in, gt/gte/lt/lte, contains, starts_with, ends_with, is_null.',
      inputSchema: getInputSchema(InputSchema),
    },
    async (args: unknown) => {
      const parsed = InputSchema.parse(args)
      // Build name->key from metadata for friendly field names
      const metadata = await client.getMetadata()
      const tables: any[] = (metadata?.tables || metadata?.metadata?.tables) || []
      const t = tables.find((x) => x.name === parsed.table)
      const nameToKey: Record<string,string> = {}
      if (t && Array.isArray(t.columns)) {
        for (const c of t.columns) {
          if (c && typeof c.name === 'string' && typeof c.key === 'string') nameToKey[c.name] = c.key
        }
      }
      const normalizedWhere = normalizeWhere(parsed.where, nameToKey)
      if (getEnv().LOG_LEVEL === 'debug') {
        // lightweight debug insight
        console.log('[find_rows]', JSON.stringify({ where_original: parsed.where, normalized: normalizedWhere }))
      }
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

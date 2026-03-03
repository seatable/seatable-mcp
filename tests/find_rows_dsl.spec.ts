import { describe, it, expect, beforeAll } from 'vitest'
import { evalWhere, normalizeWhere } from '../src/mcp/tools/findRows'
import type { SeaTableRow } from '../src/seatable/types'

beforeAll(() => {
  process.env.SEATABLE_SERVER_URL = 'http://localhost'
  process.env.SEATABLE_API_TOKEN = 'test-token'
})

describe('find_rows DSL evaluator', () => {
  const row: SeaTableRow = { _id: 'row_1', Name: 'Urgent task', Priority: 5, Status: 'Open' }

  it('eq/ne/in', () => {
    expect(evalWhere(row, { eq: { field: 'Status', value: 'Open' } } as any)).toBe(true)
    expect(evalWhere(row, { ne: { field: 'Status', value: 'Closed' } } as any)).toBe(true)
    expect(evalWhere(row, { in: { field: 'Priority', values: [1, 5, 10] } } as any)).toBe(true)
  })

  it('gt/gte/lt/lte', () => {
    expect(evalWhere(row, { gt: { field: 'Priority', value: 3 } } as any)).toBe(true)
    expect(evalWhere(row, { gte: { field: 'Priority', value: 5 } } as any)).toBe(true)
    expect(evalWhere(row, { lt: { field: 'Priority', value: 10 } } as any)).toBe(true)
    expect(evalWhere(row, { lte: { field: 'Priority', value: 5 } } as any)).toBe(true)
  })

  it('string ops', () => {
    expect(evalWhere(row, { contains: { field: 'Name', value: 'urgent' } } as any)).toBe(true)
    expect(evalWhere(row, { starts_with: { field: 'Name', value: 'Urg' } } as any)).toBe(true)
    expect(evalWhere(row, { ends_with: { field: 'Name', value: 'task' } } as any)).toBe(true)
  })

  it('null check and boolean logic', () => {
    expect(evalWhere(row, { is_null: { field: 'Missing' } } as any)).toBe(true)
    expect(
      evalWhere(row, { and: [{ eq: { field: 'Status', value: 'Open' } }, { gt: { field: 'Priority', value: 1 } }] } as any)
    ).toBe(true)
    expect(
      evalWhere(row, { or: [{ eq: { field: 'Status', value: 'Closed' } }, { eq: { field: 'Status', value: 'Open' } }] } as any)
    ).toBe(true)
    expect(evalWhere(row, { not: { eq: { field: 'Status', value: 'Closed' } } } as any)).toBe(true)
  })
})

describe('normalizeWhere — wrong format recovery', () => {
  const row: SeaTableRow = { _id: 'row_1', Name: 'Alice', Priority: 5, Status: 'Open' }

  it('{ column, op, value } pattern', () => {
    const w = normalizeWhere({ column: 'Priority', op: '=', value: 5 })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('{ field, operator, value } pattern', () => {
    const w = normalizeWhere({ field: 'Status', operator: '!=', value: 'Closed' })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('{ column, op: ">", value } pattern', () => {
    const w = normalizeWhere({ column: 'Priority', op: '>', value: 3 })
    expect(evalWhere(row, w)).toBe(true)
    expect(evalWhere(row, normalizeWhere({ column: 'Priority', op: '>', value: 10 }))).toBe(false)
  })

  it('{ column, op: "<=", value } pattern', () => {
    const w = normalizeWhere({ column: 'Priority', op: '<=', value: 5 })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('{ column, op: "in", values } pattern', () => {
    const w = normalizeWhere({ column: 'Status', op: 'in', values: ['Open', 'Pending'] })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('MongoDB-style { Name: { $eq: value } }', () => {
    const w = normalizeWhere({ Status: { $eq: 'Open' } })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('MongoDB-style multi-field { Name: { $eq: ... }, Priority: { $gt: ... } }', () => {
    const w = normalizeWhere({ Status: { $eq: 'Open' }, Priority: { $gt: 3 } })
    expect(evalWhere(row, w)).toBe(true)
    expect(evalWhere(row, normalizeWhere({ Status: { $eq: 'Open' }, Priority: { $gt: 10 } }))).toBe(false)
  })

  it('array of conditions → AND', () => {
    const w = normalizeWhere([{ column: 'Status', op: '=', value: 'Open' }, { column: 'Priority', op: '>=', value: 5 }])
    expect(evalWhere(row, w)).toBe(true)
  })

  it('canonical DSL still works unchanged', () => {
    const w = normalizeWhere({ eq: { field: 'Status', value: 'Open' } })
    expect(evalWhere(row, w)).toBe(true)
  })

  it('shorthand { Name: "foo" } still works', () => {
    const w = normalizeWhere({ Name: 'Alice', Status: 'Open' })
    expect(evalWhere(row, w)).toBe(true)
    expect(evalWhere(row, normalizeWhere({ Name: 'Bob' }))).toBe(false)
  })
})

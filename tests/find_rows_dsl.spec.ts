import { describe, it, expect, beforeAll } from 'vitest'
import { evalWhere } from '../src/mcp/tools/findRows'
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

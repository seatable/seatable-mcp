import { describe, expect, it } from 'vitest'
import { mapMetadataToGeneric } from '../src/schema/map.js'

describe('mapMetadataToGeneric', () => {
  it('maps SeaTable metadata to GenericSchema', () => {
    const meta = {
      base_id: 'baseX',
      tables: [
        {
          _id: 't1',
          name: 'Tasks',
          columns: [
            { key: 'c1', name: 'Title', type: 'text' },
            { key: 'c2', name: 'Done', type: 'checkbox' },
            { key: 'c3', name: 'File', type: 'file' },
            { key: 'c4', name: 'Image', type: 'image' },
          ],
        },
      ],
    }
    const generic = mapMetadataToGeneric(meta)
    expect(generic.base_id).toBe('baseX')
    expect(generic.tables[0].id).toBe('t1')
    expect(generic.tables[0].name).toBe('Tasks')
    const cols = generic.tables[0].columns
    expect(cols.find((c) => c.name === 'Title')?.type).toBe('text')
    expect(cols.find((c) => c.name === 'Done')?.type).toBe('checkbox')
    expect(cols.find((c) => c.name === 'File')?.type).toBe('attachment')
    expect(cols.find((c) => c.name === 'Image')?.type).toBe('attachment')
  })

  describe('normalizeType — hyphenated types', () => {
    const makeMetaWithType = (type: string) => ({
      base_id: 'b1',
      tables: [
        {
          _id: 't1',
          name: 'T',
          columns: [{ key: 'c1', name: 'Col', type }],
        },
      ],
    })

    const cases: [string, string][] = [
      ['single-select', 'single_select'],
      ['multiple-select', 'multi_select'],
      ['auto-number', 'auto_number'],
      ['link-formula', 'link_formula'],
      ['digital-sign', 'digital_sign'],
      ['long-text', 'long_text'],
      ['last-modifier', 'last_modifier'],
    ]

    for (const [input, expected] of cases) {
      it(`maps "${input}" to "${expected}"`, () => {
        const generic = mapMetadataToGeneric(makeMetaWithType(input))
        expect(generic.tables[0].columns[0].type).toBe(expected)
      })
    }
  })

  describe('normalizeType — new types', () => {
    const makeMetaWithType = (type: string) => ({
      base_id: 'b1',
      tables: [
        {
          _id: 't1',
          name: 'T',
          columns: [{ key: 'c1', name: 'Col', type }],
        },
      ],
    })

    const directTypes = ['rate', 'duration', 'geolocation', 'collaborator', 'creator', 'ctime', 'mtime', 'button']

    for (const type of directTypes) {
      it(`maps "${type}" to "${type}"`, () => {
        const generic = mapMetadataToGeneric(makeMetaWithType(type))
        expect(generic.tables[0].columns[0].type).toBe(type)
      })
    }
  })
})

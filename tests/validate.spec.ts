import { describe, it, expect } from 'vitest'
import { validateRowsAgainstSchema } from '../src/schema/validate.js'
import type { GenericSchema } from '../src/schema/generic.js'

const schema: GenericSchema = {
  base_id: 'base1',
  tables: [
    {
      id: 'tbl1',
      name: 'Tasks',
      columns: [
        { id: 'col1', name: 'Title', type: 'text' },
        { id: 'col2', name: 'Done', type: 'checkbox' },
        { id: 'col3', name: 'Rating', type: 'rate', options: { rate_max_number: 5 } },
        { id: 'col4', name: 'BigRating', type: 'rate', options: { rate_max_number: 10 } },
        { id: 'col5', name: 'Due', type: 'date' },
        { id: 'col6', name: 'Location', type: 'geolocation' },
        { id: 'col7', name: 'Formula', type: 'formula' },
        { id: 'col8', name: 'Creator', type: 'creator' },
        { id: 'col9', name: 'Created', type: 'ctime' },
        { id: 'col10', name: 'Modified', type: 'mtime' },
        { id: 'col11', name: 'AutoNum', type: 'auto_number' },
        { id: 'col12', name: 'Btn', type: 'button' },
        { id: 'col13', name: 'LinkFormula', type: 'link_formula' },
        { id: 'col14', name: 'DigSign', type: 'digital_sign' },
        { id: 'col15', name: 'Link', type: 'link' },
        { id: 'col16', name: 'Stamp', type: 'datetime' },
        { id: 'col17', name: 'RatingDefault', type: 'rate' },
      ],
    },
  ],
}

describe('validateRowsAgainstSchema', () => {
  it('passes when all columns are known', () => {
    const rows = [{ Title: 'A', Done: true }]
    const res = validateRowsAgainstSchema(schema, 'Tasks', rows)
    expect(res.unknownColumns).toEqual([])
  })

  it('throws on unknown columns by default', () => {
    const rows = [{ Title: 'A', Extra: 1 }]
    expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError()
  })

  it('returns unknowns when allowCreateColumns=true', () => {
    const rows = [{ Title: 'A', Extra: 1 }]
    const res = validateRowsAgainstSchema(schema, 'Tasks', rows, { allowCreateColumns: true })
    expect(res.unknownColumns).toEqual(['Extra'])
  })

  it('throws on unknown table', () => {
    const rows = [{}]
    expect(() => validateRowsAgainstSchema(schema, 'Nope', rows)).toThrowError('ERR_SCHEMA_UNKNOWN_TABLE')
  })

  // Read-only column stripping
  describe('read-only columns', () => {
    it('strips formula columns silently', () => {
      const rows = [{ Title: 'A', Formula: 'computed' }]
      const res = validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0]).not.toHaveProperty('Formula')
      expect(res.unknownColumns).toEqual([])
    })

    it('strips all read-only types', () => {
      const rows = [{
        Title: 'A',
        Creator: 'user@test.com',
        Created: '2025-01-01',
        Modified: '2025-01-01',
        AutoNum: '001',
        Btn: 'click',
        LinkFormula: 'val',
        DigSign: 'sig',
        Link: 'linked',
      }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(Object.keys(rows[0])).toEqual(['Title'])
    })
  })

  // Checkbox coercion
  describe('checkbox coercion', () => {
    it('coerces 1 to true', () => {
      const rows = [{ Title: 'A', Done: 1 }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(true)
    })

    it('coerces "true" to true', () => {
      const rows = [{ Title: 'A', Done: 'true' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(true)
    })

    it('coerces "1" to true', () => {
      const rows = [{ Title: 'A', Done: '1' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(true)
    })

    it('coerces 0 to false', () => {
      const rows = [{ Title: 'A', Done: 0 }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(false)
    })

    it('coerces "false" to false', () => {
      const rows = [{ Title: 'A', Done: 'false' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(false)
    })

    it('coerces "0" to false', () => {
      const rows = [{ Title: 'A', Done: '0' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(false)
    })

    it('passes boolean true through', () => {
      const rows = [{ Title: 'A', Done: true }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(true)
    })

    it('passes boolean false through', () => {
      const rows = [{ Title: 'A', Done: false }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Done).toBe(false)
    })

    it('throws on invalid checkbox value', () => {
      const rows = [{ Title: 'A', Done: 'invalid' }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('invalid checkbox value')
    })
  })

  // Rating range
  describe('rating validation', () => {
    it('accepts valid rating', () => {
      const rows = [{ Title: 'A', Rating: 3 }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
      expect(rows[0].Rating).toBe(3)
    })

    it('accepts max rating', () => {
      const rows = [{ Title: 'A', BigRating: 10 }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('throws on rating too high', () => {
      const rows = [{ Title: 'A', Rating: 8 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('between 1 and 5')
    })

    it('throws on rating zero', () => {
      const rows = [{ Title: 'A', Rating: 0 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('between 1 and 5')
    })

    it('throws on negative rating', () => {
      const rows = [{ Title: 'A', Rating: -1 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('between 1 and 5')
    })

    it('throws on non-integer rating', () => {
      const rows = [{ Title: 'A', Rating: 3.5 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('must be an integer')
    })

    it('uses default max of 5 when no options', () => {
      const rows = [{ Title: 'A', RatingDefault: 6 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('between 1 and 5')
    })
  })

  // Date format
  describe('date validation', () => {
    it('accepts YYYY-MM-DD', () => {
      const rows = [{ Title: 'A', Due: '2025-06-15' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('accepts YYYY-MM-DD HH:MM', () => {
      const rows = [{ Title: 'A', Due: '2025-06-15 14:30' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('accepts ISO 8601 datetime', () => {
      const rows = [{ Title: 'A', Stamp: '2025-06-15T14:30:00Z' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('throws on MM/DD/YYYY format', () => {
      const rows = [{ Title: 'A', Due: '13/31/2025' }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('YYYY-MM-DD')
    })

    it('throws on random string', () => {
      const rows = [{ Title: 'A', Due: 'tomorrow' }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('YYYY-MM-DD')
    })

    it('throws on non-string date', () => {
      const rows = [{ Title: 'A', Due: 12345 }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('must be a string')
    })
  })

  // Geolocation completeness
  describe('geolocation validation', () => {
    it('accepts complete geolocation', () => {
      const rows = [{ Title: 'A', Location: { lat: 52.52, lng: 13.405 } }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('throws when only lng provided', () => {
      const rows = [{ Title: 'A', Location: { lng: 13.405 } }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('missing "lat"')
    })

    it('throws when only lat provided', () => {
      const rows = [{ Title: 'A', Location: { lat: 52.52 } }]
      expect(() => validateRowsAgainstSchema(schema, 'Tasks', rows)).toThrowError('missing "lng"')
    })

    it('accepts null geolocation', () => {
      const rows = [{ Title: 'A', Location: null }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })

    it('accepts string geolocation', () => {
      // Some APIs might pass address strings
      const rows = [{ Title: 'A', Location: 'Berlin' }]
      validateRowsAgainstSchema(schema, 'Tasks', rows)
    })
  })
})

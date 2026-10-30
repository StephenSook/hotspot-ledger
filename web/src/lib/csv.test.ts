import { describe, expect, it } from 'vitest'
import { csv, csvCell } from './csv'

describe('csv', () => {
  it('quotes and escapes double quotes', () => {
    expect(csvCell('Front St "SW"')).toBe('"Front St ""SW"""')
  })

  it('neutralises spreadsheet formulas', () => {
    for (const bad of ['=HYPERLINK("x")', '+1', '-1+2', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(bad).startsWith(`"'`)).toBe(true)
    }
    expect(csvCell(' =1+1')).toBe(`"' =1+1"`)
    expect(csvCell('Front St SW')).toBe('"Front St SW"')
    expect(csvCell(42)).toBe('"42"')
  })

  it('joins rows', () => {
    expect(csv([['a', 1], ['b', 2]])).toBe('"a","1"\n"b","2"')
  })
})

import { describe, expect, it } from 'vitest';
import { completenessOf, toCopyLine } from '../src/ingest.js';
import type { DocRow } from '../src/record.js';

function row(overrides: Partial<DocRow>): DocRow {
  return {
    source: 'zlib3',
    sourceId: null,
    md5: 'a'.repeat(32),
    title: null,
    author: null,
    publisher: null,
    language: null,
    year: null,
    extension: null,
    filesize: null,
    pages: null,
    series: null,
    edition: null,
    doi: null,
    isbn: null,
    description: null,
    aacid: null,
    dateAdded: null,
    ...overrides,
  };
}

describe('completenessOf', () => {
  it('counts non-null fields', () => {
    expect(completenessOf(row({}))).toBe(0);
    expect(completenessOf(row({ title: 'x', author: 'y', year: 2000 }))).toBe(3);
    expect(completenessOf(row({ filesize: 0 }))).toBe(1);
  });
});

describe('toCopyLine', () => {
  it('escapes COPY special chars and encodes nulls', () => {
    const line = toCopyLine(row({ title: 'a\\b\tc\nd', year: 1999 }));
    const fields = line.split('\t');
    expect(fields.length).toBe(18);
    expect(fields[3]).toBe('a\\\\b c d');
    expect(fields[7]).toBe('1999');
    expect(fields[4]).toBe('\\N');
  });
});

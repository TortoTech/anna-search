import { describe, expect, it } from 'vitest';
import { normalizeRecord } from '../src/record.js';

function wrap(metadata: Record<string, unknown>): Record<string, unknown> {
  return { aacid: 'aacid__zlib3_records__test', metadata };
}

describe('normalizeRecord', () => {
  it('maps a full zlib3_records row', () => {
    const row = normalizeRecord(
      wrap({
        zlibrary_id: 12345,
        md5_reported: 'ABCDEF0123456789abcdef0123456789',
        title: '  Dune  ',
        author: 'Frank Herbert',
        publisher: 'Ace',
        language: 'english',
        year: '1965',
        extension: 'epub',
        filesize_reported: 1234567,
        isbn: '978-0-441-17271-9',
        series: 'Dune Chronicles',
        edition: '1st',
        pages: 412,
        date_added: '2021-05-30 21:11:45',
        description: 'Spice.',
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.md5).toBe('abcdef0123456789abcdef0123456789');
    expect(row!.title).toBe('Dune');
    expect(row!.sourceId).toBe('12345');
    expect(row!.year).toBe(1965);
    expect(row!.filesize).toBe(1234567);
    expect(row!.isbn).toBe('9780441172719');
    expect(row!.pages).toBe('412');
    expect(row!.source).toBe('zlib3');
    expect(row!.aacid).toBe('aacid__zlib3_records__test');
    expect(row!.dateAdded).toBe('2021-05-30 21:11:45');
  });

  it('skips records flagged deleted_as_duplicate', () => {
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), deleted_as_duplicate: true }))).toBeNull();
  });

  it('skips rows with missing or malformed md5', () => {
    expect(normalizeRecord(wrap({ title: 'no md5' }))).toBeNull();
    expect(normalizeRecord(wrap({ md5_reported: 'xyz' }))).toBeNull();
    expect(normalizeRecord(wrap({ md5_reported: 'g'.repeat(32) }))).toBeNull();
    expect(normalizeRecord('not an object')).toBeNull();
    expect(normalizeRecord({ metadata: 'nope' })).toBeNull();
  });

  it('clamps and rejects out-of-range years', () => {
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), year: '2020-01' }))!.year).toBe(2020);
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), year: 1601 }))!.year).toBe(1601);
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), year: 'abc' }))!.year).toBeNull();
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), year: 3000 }))!.year).toBeNull();
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), year: 999 }))!.year).toBeNull();
  });

  it('normalizes isbn variants', () => {
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), isbns: ['978-7-5366-9293-0', '123'] }))!.isbn).toBe(
      '9787536692930',
    );
    expect(normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), identifier_isbn: '' }))!.isbn).toBeNull();
  });

  it('falls back to filesize and md5 aliases', () => {
    const row = normalizeRecord(wrap({ md5: 'b'.repeat(32), filesize: '4242' }));
    expect(row!.md5).toBe('b'.repeat(32));
    expect(row!.filesize).toBe(4242);
  });

  it('truncates oversized fields', () => {
    const row = normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), title: 'x'.repeat(5000) }));
    expect(row!.title!.length).toBe(4000);
  });

  it('treats empty strings as null', () => {
    const row = normalizeRecord(wrap({ md5_reported: 'a'.repeat(32), title: '   ', author: '' }));
    expect(row!.title).toBeNull();
    expect(row!.author).toBeNull();
  });
});

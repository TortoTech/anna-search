import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Deliberately requires an explicit E2E_DATABASE_URL (never falls back to
// DATABASE_URL) so a production database can never be truncated by accident.
const databaseUrl = process.env.E2E_DATABASE_URL;
const enabled = Boolean(databaseUrl) && process.env.RUN_E2E === '1';

process.env.DATABASE_URL = databaseUrl ?? 'postgresql://annas:annas@localhost:5432/annas_e2e_disabled';
process.env.ANNAS_DOMAINS = '';

const { pool } = await import('../src/db.js');
const { ingestFiles } = await import('../src/ingest.js');
const { searchBooks } = await import('../src/search.js');
const { compress } = await import('zstd-napi');

const MD5_DUNE = 'a'.repeat(32);
const MD5_SANTI = 'b'.repeat(32);
const MD5_KAHNEMAN = 'c'.repeat(32);

const FIXTURE_LINES = [
  JSON.stringify({
    aacid: 'aacid__zlib3_records__test__0001',
    metadata: {
      zlibrary_id: 1,
      md5_reported: MD5_DUNE,
      title: 'Dune',
      author: 'Frank Herbert',
      publisher: 'Ace Books',
      language: 'english',
      year: '1965',
      extension: 'epub',
      filesize_reported: 1234567,
      isbn: '978-0-441-17271-9',
    },
  }),
  JSON.stringify({
    aacid: 'aacid__zlib3_records__test__0002',
    metadata: {
      zlibrary_id: 2,
      md5_reported: MD5_SANTI,
      title: '三体',
      author: '刘慈欣',
      language: 'chinese',
      year: '2008',
      extension: 'pdf',
      filesize: 2345678,
    },
  }),
  JSON.stringify({
    aacid: 'aacid__zlib3_records__test__0003',
    metadata: {
      zlibrary_id: 3,
      md5_reported: MD5_KAHNEMAN,
      title: 'Thinking, Fast and Slow',
      author: 'Daniel Kahneman',
      language: 'english',
      year: 2011,
      extension: 'pdf',
    },
  }),
  JSON.stringify({
    aacid: 'aacid__zlib3_records__test__0004',
    metadata: { md5_reported: 'd'.repeat(32), deleted_as_duplicate: true },
  }),
  'this line is not valid json',
];

describe.runIf(enabled)('e2e: ingest -> search -> detail URL', () => {
  let fixturePath: string;

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anna-search-e2e-'));
    fixturePath = path.join(dir, 'fixture.jsonl.zst');
    writeFileSync(fixturePath, compress(Buffer.from(`${FIXTURE_LINES.join('\n')}\n`)));

    await pool.query('TRUNCATE documents');
    await ingestFiles({ input: [fixturePath], batchSize: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('imports valid rows and skips bad ones', async () => {
    const res = await pool.query('SELECT count(*)::int AS n FROM documents');
    expect(res.rows[0].n).toBe(3);
  });

  it('full-text search returns md5 + Anna detail URL', async () => {
    const outcome = await searchBooks({ q: 'dune' });
    expect(outcome.mode).toBe('fts');
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0].md5).toBe(MD5_DUNE);
    expect(outcome.results[0].title).toBe('Dune');
    expect(outcome.results[0].url).toBe(`https://annas-archive.gl/md5/${MD5_DUNE}`);
  });

  it('matches CJK titles via FTS exact token', async () => {
    const outcome = await searchBooks({ q: '三体' });
    expect(outcome.results.map((r) => r.md5)).toContain(MD5_SANTI);
  });

  it('falls back to trigram fuzzy match for partial CJK queries', async () => {
    const outcome = await searchBooks({ q: '刘慈' });
    expect(outcome.mode).toBe('fuzzy');
    expect(outcome.results.map((r) => r.md5)).toContain(MD5_SANTI);
  });

  it('supports combined filters', async () => {
    const outcome = await searchBooks({ language: 'english', extension: 'pdf', yearFrom: 2010 });
    expect(outcome.results.map((r) => r.md5)).toEqual([MD5_KAHNEMAN]);
  });

  it('finds by normalized isbn', async () => {
    const outcome = await searchBooks({ isbn: '9780441172719' });
    expect(outcome.results.map((r) => r.md5)).toContain(MD5_DUNE);
  });
});

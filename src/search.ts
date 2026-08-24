import { annaDetailUrl } from './config.js';
import { pool } from './db.js';

export interface SearchFilters {
  q?: string;
  author?: string;
  language?: string;
  extension?: string;
  isbn?: string;
  yearFrom?: number;
  yearTo?: number;
  limit?: number;
}

export interface BookResult {
  md5: string;
  title: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  year: number | null;
  extension: string | null;
  filesize: number | null;
  series: string | null;
  edition: string | null;
  isbn: string | null;
  dateAdded: string | null;
  url: string;
}

export type SearchMode = 'fts' | 'fuzzy' | 'filter';

export interface SearchOutcome {
  mode: SearchMode;
  results: BookResult[];
}

const SELECT_FIELDS = [
  'md5',
  'title',
  'author',
  'publisher',
  'language',
  'year',
  'extension',
  'filesize',
  'series',
  'edition',
  'isbn',
  'date_added',
].join(', ');

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function hasQueryText(f: SearchFilters): boolean {
  return Boolean(
    f.q?.trim() ||
      f.author?.trim() ||
      f.language?.trim() ||
      f.extension?.trim() ||
      f.isbn?.trim() ||
      f.yearFrom !== undefined ||
      f.yearTo !== undefined,
  );
}

interface Built {
  text: string;
  values: unknown[];
}

function appendFilters(f: SearchFilters, values: unknown[], where: string[]): number {
  let idx = values.length + 1;
  if (f.author?.trim()) {
    where.push(`author ILIKE $${idx}`);
    values.push(`%${escapeLike(f.author.trim())}%`);
    idx += 1;
  }
  if (f.language?.trim()) {
    where.push(`language ILIKE $${idx}`);
    values.push(f.language.trim());
    idx += 1;
  }
  if (f.extension?.trim()) {
    where.push(`extension ILIKE $${idx}`);
    values.push(f.extension.trim());
    idx += 1;
  }
  if (f.isbn?.trim()) {
    where.push(`replace(isbn, '-', '') = replace($${idx}, '-', '')`);
    values.push(f.isbn.trim());
    idx += 1;
  }
  if (f.yearFrom !== undefined) {
    where.push(`year >= $${idx}`);
    values.push(f.yearFrom);
    idx += 1;
  }
  if (f.yearTo !== undefined) {
    where.push(`year <= $${idx}`);
    values.push(f.yearTo);
    idx += 1;
  }
  return idx;
}

/** PostgreSQL full-text search over the weighted tsvector. */
export function buildFtsQuery(f: SearchFilters, q: string): Built {
  const values: unknown[] = [q];
  const where = [`search_vector @@ websearch_to_tsquery('english_unaccent', $1)`];
  let idx = appendFilters(f, values, where);
  values.push(f.limit ?? 20);
  return {
    text: `SELECT ${SELECT_FIELDS}
FROM documents
WHERE ${where.join(' AND ')}
ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english_unaccent', $1)) DESC, year DESC NULLS LAST
LIMIT $${idx}`,
    values,
  };
}

/** Trigram ILIKE fallback — also matches CJK substrings the stemmer can't handle. */
export function buildFuzzyQuery(f: SearchFilters, q: string): Built {
  const values: unknown[] = [`%${escapeLike(q)}%`];
  const where = [`(title ILIKE $1 OR author ILIKE $1 OR series ILIKE $1 OR publisher ILIKE $1)`];
  let idx = appendFilters(f, values, where);
  values.push(f.limit ?? 20);
  return {
    text: `SELECT ${SELECT_FIELDS}
FROM documents
WHERE ${where.join(' AND ')}
ORDER BY year DESC NULLS LAST, md5
LIMIT $${idx}`,
    values,
  };
}

/** Filters only (no free-text query). */
export function buildFilterQuery(f: SearchFilters): Built {
  const values: unknown[] = [];
  const where: string[] = [];
  let idx = appendFilters(f, values, where);
  if (where.length === 0) where.push('TRUE');
  values.push(f.limit ?? 20);
  return {
    text: `SELECT ${SELECT_FIELDS}
FROM documents
WHERE ${where.join(' AND ')}
ORDER BY year DESC NULLS LAST, md5
LIMIT $${idx}`,
    values,
  };
}

function mapRows(rows: Record<string, unknown>[]): BookResult[] {
  return rows.map((r) => ({
    md5: String(r['md5']).trim(),
    title: (r['title'] as string | null) ?? null,
    author: (r['author'] as string | null) ?? null,
    publisher: (r['publisher'] as string | null) ?? null,
    language: (r['language'] as string | null) ?? null,
    year: (r['year'] as number | null) ?? null,
    extension: (r['extension'] as string | null) ?? null,
    filesize: (r['filesize'] as number | string | null) == null ? null : Number(r['filesize']),
    series: (r['series'] as string | null) ?? null,
    edition: (r['edition'] as string | null) ?? null,
    isbn: (r['isbn'] as string | null) ?? null,
    dateAdded: (r['date_added'] as string | null) ?? null,
    url: annaDetailUrl(String(r['md5']).trim()),
  }));
}

export async function searchBooks(f: SearchFilters): Promise<SearchOutcome> {
  const q = f.q?.trim() ?? '';

  if (q) {
    const fts = buildFtsQuery(f, q);
    const res = await pool.query(fts.text, fts.values);
    if (res.rowCount && res.rowCount > 0) {
      return { mode: 'fts', results: mapRows(res.rows) };
    }
    const fuzzy = buildFuzzyQuery(f, q);
    const fallback = await pool.query(fuzzy.text, fuzzy.values);
    return { mode: 'fuzzy', results: mapRows(fallback.rows) };
  }

  const built = buildFilterQuery(f);
  const res = await pool.query(built.text, built.values);
  return { mode: 'filter', results: mapRows(res.rows) };
}

export interface DocRow {
  source: string;
  sourceId: string | null;
  md5: string;
  title: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  year: number | null;
  extension: string | null;
  filesize: number | null;
  pages: string | null;
  series: string | null;
  edition: string | null;
  doi: string | null;
  isbn: string | null;
    description: string | null;
    dateAdded: string | null;
}

export const COPY_COLUMNS = [
  'source',
  'source_id',
  'md5',
  'title',
  'author',
  'publisher',
  'language',
  'year',
  'extension',
  'filesize',
  'pages',
  'series',
  'edition',
  'doi',
  'isbn',
  'description',
  'date_added',
] as const;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isObject(v: unknown): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getStr(meta: Record<string, JsonValue>, keys: string[]): string | null {
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function truncate(s: string, max: number): string | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function parseYear(v: JsonValue | undefined): number | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : null;
  if (!s || s.length < 4) return null;
  const y = Number.parseInt(s.slice(0, 4), 10);
  if (!Number.isFinite(y) || y < 1000 || y > 2100) return null;
  return y;
}

function parseFilesize(meta: Record<string, JsonValue>): number | null {
  for (const key of ['filesize_reported', 'filesize', 'filesize_best']) {
    const v = meta[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v);
    if (typeof v === 'string') {
      const n = Number.parseInt(v.trim(), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function cleanIsbn(s: string): string | null {
  const cleaned = s.replace(/-/g, '').trim().slice(0, 13);
  return cleaned === '' ? null : cleaned;
}

function extractIsbn(meta: Record<string, JsonValue>): string | null {
  const direct = getStr(meta, ['isbn', 'identifier_isbn']);
  if (direct) {
    const cleaned = cleanIsbn(direct);
    if (cleaned) return cleaned;
  }
  for (const key of ['isbns', 'isbn_multiple']) {
    const arr = meta[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0];
      if (typeof first === 'string') {
        const cleaned = cleanIsbn(first);
        if (cleaned) return cleaned;
      }
    }
  }
  return null;
}

const MD5_RE = /^[0-9a-f]{32}$/;

export function isValidMd5(s: string): boolean {
  return MD5_RE.test(s);
}

/**
 * Normalize one zlib3_records JSONL line (`{aacid, metadata: {...}}`) into a
 * flat row. Returns null for records that should be skipped (duplicates,
 * missing/invalid md5).
 */
export function normalizeRecord(raw: unknown, source = 'zlib3'): DocRow | null {
  if (!isObject(raw)) return null;
  const meta = raw['metadata'];
  if (!isObject(meta)) return null;

  if (meta['deleted_as_duplicate'] === true) return null;

  const md5Raw = getStr(meta, ['md5_reported', 'md5', 'md5_hash']);
  if (!md5Raw) return null;
  const md5 = md5Raw.trim().toLowerCase();
  if (!isValidMd5(md5)) return null;

  let sourceId: string | null = null;
  for (const key of ['zlibrary_id', 'libgen_id', 'id', 'primary_id', 'doi']) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim() !== '') {
      sourceId = v;
      break;
    }
    if (typeof v === 'number') {
      sourceId = String(v);
      break;
    }
  }

  const pagesValue = meta['pages'];
  let pages: string | null = null;
  if (typeof pagesValue === 'string' && pagesValue.trim() !== '') {
    pages = truncate(pagesValue, 50);
  } else if (typeof pagesValue === 'number') {
    pages = String(pagesValue);
  }
  if (pages === null) {
    const total = meta['total_pages'];
    if (typeof total === 'number' && Number.isFinite(total)) pages = String(total);
  }

  return {
    source,
    sourceId,
    md5,
    title: truncate(getStr(meta, ['title', 'title_best']) ?? '', 4000),
    author: truncate(getStr(meta, ['author', 'author_best']) ?? '', 2000),
    publisher: truncate(getStr(meta, ['publisher']) ?? '', 1000),
    language: truncate(getStr(meta, ['language', 'language_best']) ?? '', 100),
    year: parseYear(meta['year'] ?? meta['year_best']),
    extension: truncate(getStr(meta, ['extension', 'extension_best', 'file_type']) ?? '', 20),
    filesize: parseFilesize(meta),
    pages,
    series: truncate(getStr(meta, ['series']) ?? '', 1000),
    edition: truncate(getStr(meta, ['edition']) ?? '', 500),
    doi: truncate(getStr(meta, ['doi']) ?? '', 200),
    isbn: extractIsbn(meta),
    description: truncate(getStr(meta, ['description']) ?? '', 2000),
    dateAdded: getStr(meta, ['date_added']),
  };
}

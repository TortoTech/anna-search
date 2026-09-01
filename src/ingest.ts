import { appendFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { from as copyFrom } from 'pg-copy-streams';
import { globSync } from 'tinyglobby';
import type pg from 'pg';
import { pool } from './db.js';
import { createIndexes, dropIndexes } from './indexes.js';
import { COPY_COLUMNS, normalizeRecord, type DocRow } from './record.js';
import { zstdJsonlLines } from './zjsonl.js';

const TRACE_FILE = process.env.AA_TRACE_FILE;
export function trace(msg: string): void {
  if (TRACE_FILE) {
    const m = process.memoryUsage();
    appendFileSync(
      TRACE_FILE,
      `${new Date().toISOString()} ${msg} heap=${Math.round(m.heapUsed / 1048576)}MB rss=${Math.round(m.rss / 1048576)}MB ext=${Math.round(m.external / 1048576)}MB\n`,
    );
  }
}

function sanitize(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[\uD800-\uDFFF]/g, '\uFFFD');
}

function escapeCopy(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
}

function field(v: string | number | null): string {
  if (v === null) return '\\N';
  return escapeCopy(sanitize(String(v)));
}

export function toCopyLine(row: DocRow): string {
  return [
    field(row.source),
    field(row.sourceId),
    field(row.md5),
    field(row.title),
    field(row.author),
    field(row.publisher),
    field(row.language),
    field(row.year),
    field(row.extension),
    field(row.filesize),
    field(row.pages),
    field(row.series),
    field(row.edition),
    field(row.doi),
    field(row.isbn),
    field(row.description),
    field(row.dateAdded),
  ].join('\t');
}

const TEMP_COLUMNS = COPY_COLUMNS.map((c) => `${c} TEXT`).join(', ');

const COMPLETENESS_FIELDS = [
  'source_id',
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
];

const MERGE_SQL = `
INSERT INTO documents (${COPY_COLUMNS.join(', ')}, completeness)
SELECT ${COPY_COLUMNS.map((c) => {
  if (c === 'year') return 't.year::smallint';
  if (c === 'filesize') return 't.filesize::bigint';
  return `t.${c}`;
}).join(', ')},
       num_nonnulls(${COMPLETENESS_FIELDS.map((f) => `t.${f}`).join(', ')})::smallint
FROM tmp_import t
ON CONFLICT (md5) DO UPDATE SET
  ${COPY_COLUMNS.filter((c) => c !== 'md5').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
  completeness = EXCLUDED.completeness
WHERE EXCLUDED.completeness > documents.completeness
`;

export function completenessOf(row: DocRow): number {
  let n = 0;
  if (row.sourceId !== null) n += 1;
  if (row.title !== null) n += 1;
  if (row.author !== null) n += 1;
  if (row.publisher !== null) n += 1;
  if (row.language !== null) n += 1;
  if (row.year !== null) n += 1;
  if (row.extension !== null) n += 1;
  if (row.filesize !== null) n += 1;
  if (row.pages !== null) n += 1;
  if (row.series !== null) n += 1;
  if (row.edition !== null) n += 1;
  if (row.doi !== null) n += 1;
  if (row.isbn !== null) n += 1;
  if (row.description !== null) n += 1;
  if (row.dateAdded !== null) n += 1;
  return n;
}

/** Remove duplicate md5s inside one batch; keep the most complete record. */
function dedupeBatch(batch: DocRow[]): DocRow[] {
  const byMd5 = new Map<string, DocRow>();
  for (const row of batch) {
    const prev = byMd5.get(row.md5);
    if (!prev || completenessOf(row) > completenessOf(prev)) {
      byMd5.set(row.md5, row);
    }
  }
  return byMd5.size === batch.length ? batch : [...byMd5.values()];
}

async function flushBatch(client: pg.PoolClient, batch: DocRow[]): Promise<void> {
  const rows = dedupeBatch(batch);
  trace(`flush-begin rows=${rows.length}`);
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TEMP TABLE tmp_import (${TEMP_COLUMNS}) ON COMMIT DROP`);
    const copyStream = client.query(copyFrom(`COPY tmp_import (${COPY_COLUMNS.join(', ')}) FROM STDIN`));
    for (const row of rows) {
      if (!copyStream.write(`${toCopyLine(row)}\n`)) {
        await once(copyStream, 'drain');
      }
    }
    copyStream.end();
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      copyStream.once('error', onError);
      copyStream.once('finish', () => {
        copyStream.removeListener('error', onError);
        resolve();
      });
    });
    trace(`copy-done rows=${rows.length}`);
    await client.query(MERGE_SQL);
    trace(`merge-done`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

export interface IngestOptions {
  input: string[];
  limit?: number;
  batchSize?: number;
  source?: string;
  dropIndexes?: boolean;
  createIndexes?: boolean;
  vacuumFull?: boolean;
}

export interface IngestStats {
  files: number;
  imported: number;
  skipped: number;
  batches: number;
  ms: number;
}

export function expandInputs(patterns: string[]): string[] {
  const found: string[] = [];
  for (const p of patterns) {
    const abs = path.resolve(p);
    const root = path.parse(abs).root;
    const rel = path.relative(root, abs).split(path.sep).join('/');
    found.push(...globSync(rel, { cwd: root, absolute: true }));
  }
  return [...new Set(found)].sort();
}

export async function ingestFiles(options: IngestOptions): Promise<IngestStats> {
  const batchSize = options.batchSize ?? 10_000;
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`invalid batchSize: ${String(batchSize)}`);
  }
  const source = options.source ?? 'zlib3';
  const limit = options.limit;
  const files = expandInputs(options.input);
  if (files.length === 0) {
    throw new Error(`no input files matched: ${options.input.join(', ')}`);
  }

  const startedAt = Date.now();
  let imported = 0;
  let skipped = 0;
  let batches = 0;
  let processed = 0;
  let batch: DocRow[] = [];

  const client = await pool.connect();
  // ingest is idempotent (ON CONFLICT merge), so a crash can lose at most the
  // uncommitted batch — trade durability for speed during bulk load
  await client.query('SET synchronous_commit = off');
  if (options.dropIndexes) {
    console.log('dropping secondary indexes for bulk load (PK kept)...');
    await dropIndexes(client);
  }
  const logProgress = (): void => {
    const secs = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const rate = Math.round(imported / secs);
    const m = process.memoryUsage();
    console.log(
      `  progress: ${imported.toLocaleString()} imported, ${skipped.toLocaleString()} skipped, ~${rate.toLocaleString()} rows/s, heap=${(m.heapUsed / 1048576).toFixed(0)}MB rss=${(m.rss / 1048576).toFixed(0)}MB`,
    );
  };

  try {
    for (const file of files) {
      console.log(`==> ingesting ${file}`);
      trace(`file-start ${file}`);
      let sinceTrace = 0;
      for await (const rawLine of zstdJsonlLines(file)) {
        const line = rawLine.trim();
        if (line === '') continue;
        processed += 1;
        sinceTrace += 1;
        if (sinceTrace >= 100_000) {
          sinceTrace = 0;
          trace(`scan processed=${processed} imported=${imported} skipped=${skipped}`);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          skipped += 1;
          continue;
        }
        const row = normalizeRecord(parsed, source);
        if (!row) {
          skipped += 1;
          continue;
        }
        batch.push(row);
        imported += 1;

        if (batch.length >= batchSize) {
          trace(`pre-flush batch=${batch.length}`);
          await flushBatch(client, batch);
          batch = [];
          batches += 1;
          if (batches % 5 === 0) logProgress();
        }

        if (limit !== undefined && imported >= limit) break;
      }

      if (limit !== undefined && imported >= limit) break;
    }

    if (batch.length > 0) {
      await flushBatch(client, batch);
      batches += 1;
    }

    if (options.vacuumFull) {
      // rewrite the heap to reclaim dead tuples from ON CONFLICT merges;
      // cheapest here, while secondary indexes are still dropped
      console.log('running VACUUM (FULL, ANALYZE) documents...');
      const t0 = Date.now();
      await client.query('VACUUM (FULL, ANALYZE) documents');
      console.log(`  vacuum full done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }

    if (options.createIndexes) {
      console.log('rebuilding secondary indexes...');
      await createIndexes(client);
    }
  } finally {
    client.release();
  }

  const ms = Date.now() - startedAt;
  console.log(
    `done: ${imported.toLocaleString()} imported, ${skipped.toLocaleString()} skipped, ${batches} batches, ${(ms / 1000).toFixed(1)}s`,
  );
  return { files: files.length, imported, skipped, batches, ms };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const program = new Command();
  program
    .name('ingest')
    .description('Import zlib3_records .jsonl.zst dumps into PostgreSQL')
    .requiredOption('-i, --input <glob...>', 'input dump files (glob patterns)')
    .option('-l, --limit <n>', 'stop after importing N rows (sample mode)', (v) => Number.parseInt(v, 10))
    .option('-b, --batch <n>', 'rows per COPY batch', (v) => Number.parseInt(v, 10), 10_000)
    .option('-s, --source <name>', 'source collection name', 'zlib3')
    .option('--drop-indexes', 'drop secondary indexes before ingest (bulk-load speedup)')
    .option('--vacuum-full', 'VACUUM (FULL, ANALYZE) after ingest, before index rebuild')
    .option('--create-indexes', '(re)create secondary indexes after ingest finishes')
    .parse(process.argv);

  const opts = program.opts<{
    input: string[];
    limit?: number;
    batch: number;
    source: string;
    dropIndexes?: boolean;
    vacuumFull?: boolean;
    createIndexes?: boolean;
  }>();

  process.on('SIGINT', () => {
    console.error('\ninterrupted');
    process.exit(130);
  });

  ingestFiles({
    input: opts.input,
    limit: opts.limit,
    batchSize: opts.batch,
    source: opts.source,
    dropIndexes: opts.dropIndexes,
    vacuumFull: opts.vacuumFull,
    createIndexes: opts.createIndexes,
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

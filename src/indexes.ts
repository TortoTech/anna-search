import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type pg from 'pg';
import { pool } from './db.js';
import { FTS_EXPRESSION } from './search.js';

// Keep in sync with db/schema.sql
export const SECONDARY_INDEXES = [
  'idx_documents_search',
  'idx_documents_title_trgm',
  'idx_documents_author_trgm',
  'idx_documents_language',
  'idx_documents_extension',
  'idx_documents_year',
  'idx_documents_isbn',
  'idx_documents_doi',
] as const;

export const CREATE_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING GIN (${FTS_EXPRESSION})`,
  `CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_author_trgm ON documents USING GIN (author gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_language ON documents (language) WHERE language IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_documents_extension ON documents (extension) WHERE extension IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_documents_year ON documents (year) WHERE year IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_documents_isbn ON documents (isbn) WHERE isbn IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_documents_doi ON documents (doi) WHERE doi IS NOT NULL`,
];

export async function dropIndexes(client: pg.PoolClient): Promise<void> {
  for (const name of SECONDARY_INDEXES) {
    const t0 = Date.now();
    await client.query(`DROP INDEX IF EXISTS ${name}`);
    console.log(`  dropped ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

export async function createIndexes(client: pg.PoolClient): Promise<void> {
  await client.query(`SET maintenance_work_mem = '1GB'`);
  await client.query(`SET max_parallel_maintenance_workers = 4`);
  for (const sql of CREATE_INDEXES_SQL) {
    const name = /INDEX IF NOT EXISTS (\w+)/.exec(sql)?.[1] ?? sql;
    const t0 = Date.now();
    console.log(`  building ${name}...`);
    await client.query(sql);
    console.log(`  built ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const program = new Command();
  program
    .name('indexes')
    .description('Drop/recreate secondary indexes around bulk ingest (PK is always kept)')
    .addCommand(
      new Command('drop')
        .description('drop secondary indexes before bulk ingest')
        .action(async () => {
          const client = await pool.connect();
          try {
            await dropIndexes(client);
          } finally {
            client.release();
            await pool.end();
          }
        }),
    )
    .addCommand(
      new Command('create')
        .description('(re)create secondary indexes after bulk ingest')
        .action(async () => {
          const client = await pool.connect();
          try {
            await createIndexes(client);
          } finally {
            client.release();
            await pool.end();
          }
        }),
    )
    .parse(process.argv);
}

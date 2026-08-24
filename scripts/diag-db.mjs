import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = await pool.connect();

const COLS = [
  'source','source_id','md5','title','author','publisher','language','year','extension','filesize',
  'pages','series','edition','doi','isbn','description','aacid','date_added',
];
const TEMP_COLUMNS = COLS.map((c) => `${c} TEXT`).join(', ');
const MERGE_SQL = `
INSERT INTO documents (${COLS.join(', ')}, completeness)
SELECT ${COLS.map((c) => (c === 'year' ? 't.year::smallint' : c === 'filesize' ? 't.filesize::bigint' : `t.${c}`)).join(', ')},
       num_nonnulls(t.source_id, t.title, t.author, t.publisher, t.language, t.year, t.extension, t.filesize, t.pages, t.series, t.edition, t.doi, t.isbn, t.description, t.date_added)::smallint
FROM tmp_import t
ON CONFLICT (md5) DO UPDATE SET
  ${COLS.filter((c) => c !== 'md5').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
  completeness = EXCLUDED.completeness
WHERE EXCLUDED.completeness > documents.completeness
`;

function makeRows(n, offset) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const md5 = ((offset + i).toString(16).padStart(8, '0') + 'deadbeefdeadbeefdeadbeefdeadbeef').slice(0, 32);
    rows.push([
      'zlib3', String(offset + i), md5, `Synthetic Book Title Number ${offset + i}`, 'Author Name',
      'Publisher', 'english', '2015', 'pdf', '123456', '200', null, null, null, null,
      'A'.repeat(500), `aacid__synth__${offset + i}`, '2022-01-01',
    ]);
  }
  return rows;
}

async function flush(rows) {
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE tmp_import (${TEMP_COLUMNS}) ON COMMIT DROP`);
  const cs = client.query(copyFrom(`COPY tmp_import (${COLS.join(', ')}) FROM STDIN`));
  for (const r of rows) {
    if (!cs.write(`${r.join('\t')}\n`)) await once(cs, 'drain');
  }
  cs.end();
  await finished(cs);
  await client.query(MERGE_SQL);
  await client.query('COMMIT');
}

for (let b = 0; b < 40; b++) {
  const t0 = Date.now();
  await flush(makeRows(10000, b * 10000));
  const m = process.memoryUsage();
  console.log(`batch=${b} ms=${Date.now() - t0} heap=${(m.heapUsed / 1048576).toFixed(0)}MB rss=${(m.rss / 1048576).toFixed(0)}MB`);
}
client.release();
await pool.end();
process.exit(0);

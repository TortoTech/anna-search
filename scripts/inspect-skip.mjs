import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { DecompressStream } from 'zstd-napi';

class LineSplitter extends Transform {
  constructor() {
    super({ readableObjectMode: true });
    this.leftover = null;
  }
  _transform(chunk, _enc, done) {
    const buf = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) break;
      this.push(buf.subarray(start, nl));
      start = nl + 1;
    }
    this.leftover = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    done();
  }
  _flush(done) {
    if (this.leftover?.length) this.push(this.leftover);
    done();
  }
}

const MAX = Number(process.argv[2] ?? 30000);
const file = process.argv[3];
const SKIP = Number(process.argv[4] ?? 0);
const counts = { ok: 0, bad_json: 0, dup_flag: 0, no_md5: 0, bad_md5: 0 };
const samples = {};
const seen = new Set();
let scanned = 0;

const lines = createReadStream(file).pipe(new DecompressStream({ windowLogMax: 31 })).pipe(new LineSplitter());
for await (const raw of lines) {
  const line = raw.toString('utf8').trim();
  if (!line) continue;
  scanned += 1;
  if (scanned <= SKIP) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    counts.bad_json += 1;
    samples.bad_json ??= line.slice(0, 300);
    continue;
  }
  const meta = obj?.metadata;
  if (!meta || typeof meta !== 'object') {
    counts.no_md5 += 1;
    samples.no_md5 ??= line.slice(0, 300);
    continue;
  }
  if (meta.deleted_as_duplicate === true) {
    counts.dup_flag += 1;
    samples.dup_flag ??= line.slice(0, 300);
    continue;
  }
  const md5 = String(meta.md5_reported ?? meta.md5 ?? meta.md5_hash ?? '').trim().toLowerCase();
  if (!md5) {
    counts.no_md5 += 1;
    samples.no_md5 ??= line.slice(0, 300);
    continue;
  }
  if (!/^[0-9a-f]{32}$/.test(md5)) {
    counts.bad_md5 += 1;
    samples.bad_md5 ??= line.slice(0, 300);
    continue;
  }
  counts.ok += 1;
  if (!seen.has(md5)) seen.add(md5);
  if (scanned >= SKIP + MAX) break;
}
console.log(JSON.stringify({ scanned, counts, unique_md5: seen.size }, null, 2));
for (const [k, v] of Object.entries(samples)) console.log(`--- sample ${k}:\n${v}\n`);

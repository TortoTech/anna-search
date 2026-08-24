import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';
import { DecompressStream } from 'zstd-napi';
import { normalizeRecord } from './dist/record.js';

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

const file = process.argv[2];
const lines = createReadStream(file).pipe(new DecompressStream({ windowLogMax: 31 })).pipe(new LineSplitter());
let n = 0;
let imported = 0;
let batch = [];
let batches = 0;
for await (const raw of lines) {
  const line = raw.toString('utf8').trim();
  if (!line) continue;
  n += 1;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const row = normalizeRecord(obj);
  if (!row) continue;
  batch.push(row);
  imported += 1;
  if (batch.length >= 10000) {
    batch = [];
    batches += 1;
    if (batches % 5 === 0) {
      const m = process.memoryUsage();
      console.log(`batches=${batches} imported=${imported} heap=${(m.heapUsed / 1048576).toFixed(0)}MB rss=${(m.rss / 1048576).toFixed(0)}MB`);
    }
  }
  if (imported >= 500000) break;
}
console.log('done', n, imported);
process.exit(0);

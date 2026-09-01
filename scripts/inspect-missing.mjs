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

const MAX = Number(process.argv[2] ?? 3000000);
const file = process.argv[3];
const keySets = new Map();
const samples = [];
let missing = 0;
let otherNoMd5 = 0;
let ok = 0;
let scanned = 0;

const lines = createReadStream(file).pipe(new DecompressStream({ windowLogMax: 31 })).pipe(new LineSplitter());
for await (const raw of lines) {
  const line = raw.toString('utf8').trim();
  if (!line) continue;
  scanned += 1;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const meta = obj?.metadata;
  if (!meta || typeof meta !== 'object') continue;
  const md5 = String(meta.md5_reported ?? meta.md5 ?? meta.md5_hash ?? '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(md5)) {
    ok += 1;
    continue;
  }
  if (meta.missing === 1) {
    missing += 1;
    const keys = Object.keys(meta).sort().join(',');
    keySets.set(keys, (keySets.get(keys) ?? 0) + 1);
    if (samples.length < 3) samples.push(line.slice(0, 300));
  } else {
    otherNoMd5 += 1;
    if (otherNoMd5 <= 2) console.log('OTHER-NO-MD5 SAMPLE:', line.slice(0, 300));
  }
  if (scanned >= MAX) break;
}
console.log(JSON.stringify({ scanned, ok, missing, otherNoMd5 }, null, 2));
console.log('missing-row key sets:', JSON.stringify([...keySets.entries()], null, 2));
console.log('samples:');
for (const s of samples) console.log(' ', s);
process.exit(0);

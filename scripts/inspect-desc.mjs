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
let le256 = 0;
let mid = 0;
let gt2k = 0;
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
  const d = obj?.metadata?.description;
  if (typeof d !== 'string' || d.trim() === '') continue;
  const trimmed = d.trim();
  const capped = trimmed.length <= 2000 ? trimmed : trimmed.slice(0, 2000);
  const len = Buffer.byteLength(capped);
  if (len <= 256) le256 += len;
  else if (len <= 2048) mid += len;
  else gt2k += len;
  if (scanned >= MAX) break;
}
const mb = (n) => (n / 1048576).toFixed(0);
console.log(JSON.stringify({ scanned, le256_MB: mb(le256), mid_256_2k_MB: mb(mid), gt2k_MB: mb(gt2k) }));
process.exit(0);

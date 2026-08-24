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

const file = process.argv[2];
const lines = createReadStream(file).pipe(new DecompressStream({ windowLogMax: 31 })).pipe(new LineSplitter());
let n = 0;
for await (const raw of lines) {
  n += 1;
  if (n % 20000 === 0) {
    await new Promise((r) => setTimeout(r, 300));
    console.log(`paused-at ${n}`);
  }
  if (n >= 300000) break;
}
console.log('done', n);
process.exit(0);

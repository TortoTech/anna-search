import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';

interface DCtxLike {
  setParameter(param: number, value: number): void;
  decompressStream(dstBuf: Uint8Array, srcBuf: Uint8Array): [ret: number, produced: number, consumed: number];
}

interface ZstdBinding {
  DCtx: new () => DCtxLike;
  DParameter: { windowLogMax: number };
  dStreamInSize(): number;
  dStreamOutSize(): number;
}

// zstd-napi has no package.json "exports", so TS NodeNext cannot resolve the
// 'zstd-napi/binding' subpath; require it instead (runtime resolution works).
const require = createRequire(import.meta.url);
const binding = require('zstd-napi/binding') as ZstdBinding;

/**
 * Pull-based zstd-compressed JSONL reader.
 *
 * Deliberately avoids Node streams: zstd-napi's DecompressStream ignores
 * push() backpressure, so piping it while the consumer stalls (e.g. during
 * DB flushes) makes its internal buffer grow without bound. Here nothing is
 * decompressed until the caller asks for the next line, so memory stays flat
 * no matter how long the consumer pauses.
 */
export async function* zstdJsonlLines(file: string): AsyncGenerator<string, void, unknown> {
  const dctx = new binding.DCtx();
  dctx.setParameter(binding.DParameter.windowLogMax, 31);
  const inBuf = Buffer.allocUnsafe(binding.dStreamInSize());
  const outBuf = Buffer.allocUnsafe(binding.dStreamOutSize());
  const decoder = new StringDecoder('utf8');
  const fh = await open(file, 'r');
  let pending = Buffer.alloc(0);
  let lineBuf = '';

  const emitLines = function* (text: string): Generator<string> {
    lineBuf += text;
    let nl = lineBuf.indexOf('\n');
    while (nl !== -1) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = lineBuf.indexOf('\n');
    }
  };

  try {
    for (;;) {
      const { bytesRead } = await fh.read(inBuf, 0, inBuf.length);
      const eof = bytesRead === 0;
      if (eof && pending.length === 0) break;

      let src: Buffer;
      if (eof) {
        src = pending;
      } else {
        const chunk = bytesRead === inBuf.length ? inBuf : inBuf.subarray(0, bytesRead);
        src = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      }
      pending = Buffer.alloc(0);

      let pos = 0;
      for (;;) {
        const [, produced, consumed] = dctx.decompressStream(outBuf, src.subarray(pos));
        pos += consumed;
        if (produced > 0) {
          yield* emitLines(decoder.write(outBuf.subarray(0, produced)));
        }
        if (pos >= src.length || (consumed === 0 && produced === 0)) break;
      }
      if (pos < src.length) pending = Buffer.from(src.subarray(pos));
      if (eof) break;
    }
    yield* emitLines(decoder.end());
    if (lineBuf.trim().length > 0) yield lineBuf;
  } finally {
    await fh.close();
  }
}

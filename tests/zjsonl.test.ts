import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compress } from 'zstd-napi';
import { zstdJsonlLines } from '../src/zjsonl.js';

describe('zstdJsonlLines', () => {
  it('yields every line of a zstd-compressed JSONL file', async () => {
    const lines = [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ title: '三体', author: '刘慈欣' }),
      JSON.stringify({ emoji: '📚🚀' }),
      JSON.stringify({ long: 'x'.repeat(200_000) }),
    ];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'zjsonl-test-'));
    const file = path.join(dir, 'sample.jsonl.zst');
    writeFileSync(file, compress(Buffer.from(`${lines.join('\n')}\n`)));

    const got: string[] = [];
    for await (const line of zstdJsonlLines(file)) {
      got.push(line);
    }
    expect(got).toEqual(lines);
    expect(JSON.parse(got[1]).title).toBe('三体');
    expect(JSON.parse(got[2]).emoji).toBe('📚🚀');
  });

  it('returns nothing for an empty stream', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'zjsonl-test-'));
    const file = path.join(dir, 'empty.jsonl.zst');
    writeFileSync(file, compress(Buffer.from('')));
    const got: string[] = [];
    for await (const line of zstdJsonlLines(file)) got.push(line);
    expect(got).toEqual([]);
  });
});

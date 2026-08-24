import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';
import { hasQueryText, searchBooks, type SearchFilters } from './search.js';

const searchParamsSchema = z.object({
  q: z.string().trim().max(500).optional(),
  author: z.string().trim().max(500).optional(),
  language: z.string().trim().max(100).optional(),
  extension: z.string().trim().max(20).optional(),
  isbn: z.string().trim().max(32).optional(),
  year_from: z.coerce.number().int().min(1000).max(2100).optional(),
  year_to: z.coerce.number().int().min(1000).max(2100).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.searchMaxLimit)
    .default(config.searchDefaultLimit),
});

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'anna-search',
      description: "Anna's Archive zlib3_records local metadata search MVP",
      endpoints: {
        search: 'GET /api/search?q=&author=&language=&extension=&isbn=&year_from=&year_to=&limit=',
        stats: 'GET /stats',
        health: 'GET /health',
      },
    });
  });

  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'error', message: String(err) });
    }
  });

  app.get('/stats', async (_req: Request, res: Response) => {
    const total = await pool.query('SELECT count(*)::bigint AS total FROM documents');
    const byExtension = await pool.query(
      `SELECT coalesce(extension, '(none)') AS extension, count(*)::bigint AS n
FROM documents GROUP BY 1 ORDER BY n DESC LIMIT 10`,
    );
    res.json({
      total: Number(total.rows[0]?.['total'] ?? 0),
      by_extension: byExtension.rows.map((r) => ({
        extension: r['extension'],
        count: Number(r['n']),
      })),
    });
  });

  app.get('/api/search', async (req: Request, res: Response) => {
    const parsed = searchParamsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid parameters', issues: parsed.error.issues });
      return;
    }
    const p = parsed.data;
    const filters: SearchFilters = {
      q: p.q,
      author: p.author,
      language: p.language,
      extension: p.extension,
      isbn: p.isbn,
      yearFrom: p.year_from,
      yearTo: p.year_to,
      limit: p.limit,
    };
    if (!hasQueryText(filters)) {
      res.status(400).json({ error: 'at least one query parameter is required' });
      return;
    }
    const outcome = await searchBooks(filters);
    res.json({
      query: p.q ?? null,
      mode: outcome.mode,
      count: outcome.results.length,
      results: outcome.results,
    });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const app = createApp();
  app.listen(config.apiPort, () => {
    console.log(`anna-search API listening on http://localhost:${config.apiPort}`);
    console.log(`detail URL domain: ${config.annaDomains[0]}`);
  });
}

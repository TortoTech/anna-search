import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export function createPool(databaseUrl: string, max = 4): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

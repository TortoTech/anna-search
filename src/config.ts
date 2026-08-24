import 'dotenv/config';

export interface AppConfig {
  databaseUrl: string;
  apiPort: number;
  annaDomains: string[];
  searchDefaultLimit: number;
  searchMaxLimit: number;
}

const DEFAULT_DOMAINS = ['annas-archive.gl', 'annas-archive.gd', 'annas-archive.pk'];

function parseDomains(raw: string | undefined): string[] {
  const domains = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return domains.length > 0 ? domains : DEFAULT_DOMAINS;
}

export const config: AppConfig = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://annas:annas@localhost:5432/annas',
  apiPort: Number(process.env.API_PORT ?? 3000),
  annaDomains: parseDomains(process.env.ANNAS_DOMAINS),
  searchDefaultLimit: 20,
  searchMaxLimit: 50,
};

export function annaDetailUrl(md5: string, domain: string = config.annaDomains[0]): string {
  return `https://${domain}/md5/${md5}`;
}

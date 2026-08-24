import { describe, expect, it } from 'vitest';
import { buildFilterQuery, buildFtsQuery, buildFuzzyQuery, escapeLike, hasQueryText } from '../src/search.js';

describe('escapeLike', () => {
  it('escapes %, _ and backslash', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b\\c')).toBe('a\\_b\\\\c');
  });
});

describe('hasQueryText', () => {
  it('detects empty vs non-empty filters', () => {
    expect(hasQueryText({})).toBe(false);
    expect(hasQueryText({ q: '  ' })).toBe(false);
    expect(hasQueryText({ q: 'dune' })).toBe(true);
    expect(hasQueryText({ yearFrom: 2000 })).toBe(true);
  });
});

describe('buildFtsQuery', () => {
  it('builds a weighted FTS query with filters and limit', () => {
    const built = buildFtsQuery({ author: 'tolkien', yearFrom: 1950, limit: 5 }, 'lord of the rings');
    expect(built.values).toEqual(['lord of the rings', '%tolkien%', 1950, 5]);
    expect(built.text).toContain("websearch_to_tsquery('english_unaccent', $1)");
    expect(built.text).toContain('author ILIKE $2');
    expect(built.text).toContain('year >= $3');
    expect(built.text).toContain('LIMIT $4');
    expect(built.text).toContain('ts_rank_cd');
  });
});

describe('buildFuzzyQuery', () => {
  it('escapes LIKE metacharacters in the pattern', () => {
    const built = buildFuzzyQuery({}, '50%');
    expect(built.values[0]).toBe('%50\\%%');
    expect(built.text).toContain('title ILIKE $1');
  });
});

describe('buildFilterQuery', () => {
  it('uses TRUE when no filters are given', () => {
    const built = buildFilterQuery({ limit: 3 });
    expect(built.text).toContain('WHERE TRUE');
    expect(built.values).toEqual([3]);
  });

  it('normalizes isbn by stripping hyphens', () => {
    const built = buildFilterQuery({ isbn: '978-7-5366-9293-0' });
    expect(built.text).toContain("replace(isbn, '-', '') = replace($1, '-', '')");
    expect(built.values[0]).toBe('978-7-5366-9293-0');
  });
});

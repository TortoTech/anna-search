-- v2 schema migration for an existing v1 database:
--   1. drop the stored tsvector column (replaced by an expression GIN index)
--   2. drop the aacid column (provenance kept via source + source_id)
-- Run: docker compose exec -i postgres psql -U annas -d annas < db/migrate-v2.sql

DROP INDEX IF EXISTS idx_documents_search;
ALTER TABLE documents DROP COLUMN IF EXISTS search_vector;
ALTER TABLE documents DROP COLUMN IF EXISTS aacid;

CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING GIN (
    (setweight(to_tsvector('english_unaccent', coalesce(title, '')), 'A') ||
     setweight(to_tsvector('english_unaccent', coalesce(author, '')), 'B') ||
     setweight(to_tsvector('english_unaccent', coalesce(publisher, '')), 'C'))
);

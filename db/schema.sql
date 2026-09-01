CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$ BEGIN
  CREATE TEXT SEARCH CONFIGURATION english_unaccent (COPY = english);
  ALTER TEXT SEARCH CONFIGURATION english_unaccent
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS documents (
    md5           CHAR(32) PRIMARY KEY,
    source        TEXT NOT NULL DEFAULT 'zlib3',
    source_id     TEXT,
    title         TEXT,
    author        TEXT,
    publisher     TEXT,
    language      TEXT,
    year          SMALLINT,
    extension     TEXT,
    filesize      BIGINT,
    pages         TEXT,
    series        TEXT,
    edition       TEXT,
    doi           TEXT,
    isbn          TEXT,
    description   TEXT,
    date_added    TEXT,
    completeness  SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_documents_search ON documents USING GIN (
    (setweight(to_tsvector('english_unaccent', coalesce(title, '')), 'A') ||
     setweight(to_tsvector('english_unaccent', coalesce(author, '')), 'B') ||
     setweight(to_tsvector('english_unaccent', coalesce(publisher, '')), 'C'))
);
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_author_trgm ON documents USING GIN (author gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_language ON documents (language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_extension ON documents (extension) WHERE extension IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_year ON documents (year) WHERE year IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_isbn ON documents (isbn) WHERE isbn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_doi ON documents (doi) WHERE doi IS NOT NULL;

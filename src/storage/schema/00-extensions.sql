CREATE EXTENSION IF NOT EXISTS vector;
-- Substring-robust trigram matching (issue #362) — the lexical fallback for
-- knowledge_search's semantic-miss path. Standard Postgres contrib, present
-- in the pgvector/pgvector:pg16 CI image.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

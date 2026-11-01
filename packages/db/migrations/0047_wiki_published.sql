-- 0047 — track what has been committed to git (BRAIN-5).
--
-- The compiler writes pages to `wiki_pages`; the publisher commits them. To
-- commit only what changed rather than the whole repository every run (AC3),
-- the publisher records the content hash it last committed for each page and
-- commits only the pages whose hash has moved since.

ALTER TABLE wiki_pages ADD COLUMN published_hash text;

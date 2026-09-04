-- 0022 — a chunk knows its repository (BRAIN-4 AC5).
--
-- Denormalised deliberately, and the reason is measurable. Filtering by
-- repository through a join to `code_files` forced the planner away from both
-- retrieval indexes: the vector search computed a distance for every row in the
-- table (252ms over 20k chunks, HNSW never touched) and the lexical search
-- scanned every chunk of every visible file, discarding 498 in 500.
--
-- With the column here, both searches filter on `code_chunks` directly and can
-- reach their indexes. The duplication is safe because a chunk's file never
-- moves between repositories: re-indexing replaces the chunk rather than
-- updating it, so there is no path by which the two could disagree.
ALTER TABLE code_chunks ADD COLUMN repository_id text REFERENCES repositories(id) ON DELETE CASCADE;

UPDATE code_chunks c
   SET repository_id = f.repository_id
  FROM code_files f
 WHERE f.id = c.file_id AND c.repository_id IS NULL;

ALTER TABLE code_chunks ALTER COLUMN repository_id SET NOT NULL;

-- The filter every retrieval applies, so it leads the index rather than
-- following the text match.
CREATE INDEX code_chunks_by_repository ON code_chunks (repository_id);

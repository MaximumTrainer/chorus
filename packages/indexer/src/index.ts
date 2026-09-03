export { createIndexer } from './index-run.js'
export type { Indexer, IndexRun, IndexStats, IndexFailure, Embedder, IndexerDeps } from './index-run.js'
export { walkRepository, ALWAYS_IGNORED } from './walk.js'
export type { WalkedFile } from './walk.js'
export { createParser, languageFor } from './parse.js'
export type { SourceParser, ParsedFile, ParsedSymbol } from './parse.js'
export { chunkFile, MAX_CHUNK_LINES, OVERLAP_LINES } from './chunk.js'
export type { Chunk } from './chunk.js'
export { detectRepository } from './detect.js'
export type {
  DetectedRepository,
  Framework,
  PackageManager,
  RouteEntry,
  Conventions,
  DesignSystem,
} from './detect.js'
export { generateCorpus } from './testing/generate-corpus.js'
export type { CorpusOptions, GeneratedCorpus } from './testing/generate-corpus.js'

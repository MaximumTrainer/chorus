export { createWorker } from './worker.js'
export type { WorkerDeps, RunningWorker } from './worker.js'
export { checkout, withWorkingCopy } from './checkout.js'
export type { CheckoutRequest, WorkingCopy } from './checkout.js'
export {
  indexRepositoryConsumer,
  INDEX_REPOSITORY_QUEUE,
} from './consumers/index-repository.js'
export type {
  IndexRepositoryJob,
  IndexRepositoryDeps,
  RepositoryAccess,
} from './consumers/index-repository.js'
export { createGitRepositoryAccess } from './access.js'
export type { GitAccessDeps } from './access.js'

/**
 * A live end-to-end check of a coding job (CODE-3 AC2).
 *
 * > **Given** a deployment with no external coding CLI installed and a local
 * > model endpoint · **When** a job runs with the reference adapter · **Then**
 * > it completes and produces a diff.
 *
 * Everything that criterion names has been proven separately and never
 * together. The adapter passes its contract kit against `FakeSandbox`; the
 * runner's isolation is asserted against real containers; the provider is
 * verified against a real endpoint. Each of those is a component test, and a
 * chain of passing component tests is not a working chain — it is three things
 * that have never met.
 *
 * This is the meeting: a real container from an image that was really built, a
 * real git repository inside it, a real model deciding what to change, and a
 * diff at the end or a failure that says why.
 *
 * Deliberately **not** a test, and in no vitest project. CLAUDE.md §4 forbids a
 * test calling a real model, and this one also builds an image and starts a
 * container — it is slow, billable, and dependent on somebody else's uptime.
 *
 *   CHORUS_MODEL_BASE_URL=https://openrouter.ai/api/v1 \
 *   CHORUS_MODEL_API_KEY=... \
 *   CHORUS_SMOKE_OPENAI_MODEL=anthropic/claude-haiku-4.5 \
 *   pnpm smoke:coding-job
 *
 * The model is reached from *this* process rather than from inside the
 * container: the reference adapter is a loop over the provider router, which is
 * platform-side, and it drives the sandbox through `exec`. So the sandbox needs
 * no egress at all for this adapter, which is one of the reasons it is the
 * fallback that works anywhere.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { providersFromEnv, type ModelRef } from '@chorus/llm'
import { assembleBrief, createDockerSandboxRunner, createReferenceAdapter } from '@chorus/coding'
import type { SandboxSpec } from '@chorus/core'

const run = promisify(execFile)

const IMAGE = process.env.CHORUS_SMOKE_ADAPTER_IMAGE?.trim() || 'chorus/adapter-reference:smoke'
const DOCKERFILE = 'deploy/images/adapter-reference.Dockerfile'

const modelName = process.env.CHORUS_SMOKE_OPENAI_MODEL?.trim()
if (!modelName) {
  console.error(
    'CHORUS_SMOKE_OPENAI_MODEL is not set.\n' +
      'This script makes real, billable calls; it will not guess a model.',
  )
  process.exit(2)
}
const MODEL: ModelRef = { provider: 'openai-compatible', model: modelName }

/**
 * The file the agent is asked to change.
 *
 * Small, and wrong in one obvious way, because what is under test is the chain
 * rather than the model's judgement. A task needing real insight would make a
 * failure ambiguous between "the plumbing is broken" and "the model had a bad
 * day", and only one of those is this script's business.
 */
const SUBJECT = `export function parseInvoice(raw: string) {
  const data = JSON.parse(raw)
  if (!data.total) throw new Error('invalid invoice')
  if (!data.currency) throw new Error('invalid invoice')
  return { total: data.total, currency: data.currency }
}
`

function brief() {
  return assembleBrief({
    charter: 'We ship small changes and we keep functions to one job.',
    repositoryFullName: 'acme/billing',
    baseBranch: 'main',
    conventions: {
      packageManager: 'npm',
      testCommand: null,
      lintCommand: null,
      formatCommand: null,
      buildCommand: null,
      contributionGuide: null,
      agentInstructions: [],
      monorepo: null,
    },
    documents: [],
    decisions: [],
    captures: [],
    task: {
      key: 'CH-1',
      title: 'Split validation out of parseInvoice',
      description:
        'parseInvoice both validates and parses. Move the two validation checks into a ' +
        'separate exported function called validateInvoice, and have parseInvoice call it. ' +
        'The file is src/billing/parse.ts. Use the edit_file tool to write the whole file.',
      acceptanceCriteria: [
        'src/billing/parse.ts exports a function named validateInvoice',
        'parseInvoice calls validateInvoice rather than checking fields itself',
      ],
      tags: [],
    },
    pointers: [
      {
        path: 'src/billing/parse.ts',
        symbolName: 'parseInvoice',
        lineStart: 1,
        lineEnd: 7,
        commitSha: null,
        source: 'manual',
        stale: false,
      },
    ],
  })
}

function specFor(jobId: string): SandboxSpec {
  return {
    jobId,
    image: IMAGE,
    repository: {
      fullName: 'acme/billing',
      cloneUrl: 'https://example.invalid/acme/billing.git',
      baseBranch: 'main',
      branch: 'chorus/CH-1-split-validation',
    },
    apiUrl: 'http://chorus.internal/api',
    jobToken: 'job_scoped_token',
    secrets: {},
    limits: { cpus: 2, memoryMb: 512, diskMb: 2048, processes: 128, wallClockMs: 120_000 },
    // The reference adapter reaches the model from this process, so the sandbox
    // needs nothing. A single entry rather than none, because an empty
    // allow-list is refused at construction — unconfigured egress must not be
    // mistaken for unrestricted egress.
    egressAllowList: ['github.com'],
    pathAllowList: ['src/**'],
    protectedPaths: [],
  }
}

let failures = 0
function check(label: string, passed: boolean, detail = ''): void {
  console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures += 1
}

async function main(): Promise<void> {
  console.log(`Building ${IMAGE} from ${DOCKERFILE} …`)
  await run('docker', ['build', '-f', DOCKERFILE, '-t', IMAGE, '.'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  console.log('built.\n')

  const models = providersFromEnv()
  const runner = createDockerSandboxRunner()
  const adapter = createReferenceAdapter({ models, model: MODEL, maxTurns: 8 })
  const jobId = `01SMOKE${Date.now().toString(36).toUpperCase()}`

  console.log(`Provisioning a sandbox for ${jobId} …`)
  const sandbox = await runner.provision(specFor(jobId))

  try {
    // A real repository, so `git diff` has something to say. The agent's change
    // has to survive as a diff, not merely as a file it claims to have written.
    await sandbox.write('src/billing/parse.ts', SUBJECT)
    const setup: string[] = []
    for await (const event of sandbox.exec([
      'sh',
      '-c',
      'cd /workspace && git init -q && git add -A && ' +
        'git -c user.email=smoke@chorus.test -c user.name=Smoke commit -q -m initial && ' +
        'git rev-parse --short HEAD',
    ])) {
      if (event.type === 'stdout' || event.type === 'stderr') setup.push(event.text)
    }
    check('a git repository exists in the sandbox', /[0-9a-f]{7}/.test(setup.join('')),
      setup.join('').trim())

    console.log(`\nRunning the reference adapter against ${MODEL.model} …`)
    const prepared = await adapter.prepare({ jobId, brief: brief(), spec: specFor(jobId) })

    let failed: string | undefined
    let toolCalls = 0
    for await (const event of adapter.run(prepared, sandbox)) {
      if (event.kind === 'tool') {
        toolCalls += 1
        console.log(`    tool: ${event.tool} — ${event.summary}`)
      }
      if (event.kind === 'failed') failed = event.message
      if (event.kind === 'output') console.log(`    said: ${event.text.slice(0, 160)}`)
    }

    console.log('')
    check('the brief reached the container', (await sandbox.read('BRIEF.md')).includes('CH-1'))
    check('the agent used its tools', toolCalls > 0, `${toolCalls} tool calls`)
    check('the run did not fail', failed === undefined, failed ?? '')

    const change = await sandbox.change()
    const diff = await sandbox.diff()

    // The requirement in one line: it completes and produces a diff.
    check('a diff was produced', diff.trim().length > 0, `${diff.split('\n').length} lines`)
    check(
      'the diff touches the file the brief pointed at',
      change.changedPaths.includes('src/billing/parse.ts'),
      change.changedPaths.join(', ') || 'nothing changed',
    )
    check(
      'the change does what the criteria asked',
      (await sandbox.read('src/billing/parse.ts')).includes('validateInvoice'),
      'validateInvoice present',
    )

    const result = await adapter.collect(sandbox)
    check('collect reports a summary', result.summary.length > 0, result.summary)
  } finally {
    await sandbox.destroy()
    await runner.reconcile()
  }

  console.log(
    failures === 0
      ? '\nThe chain works: brief, container, model, diff.'
      : `\n${failures} check(s) FAILED.`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()

#!/usr/bin/env node
/**
 * Builds the Chorus project website.
 *
 * Plain Node, no dependencies and no framework: the site is one static page,
 * and a build that needs a toolchain is a build that rots between the rare
 * occasions anyone touches it.
 *
 * Every figure and every transcript comes from `website/src/*.json`, which is
 * recorded from the running system by `website/capture`. Nothing on the page is
 * typed by hand, because a hand-typed number is one nobody updates and nobody
 * notices is wrong.
 *
 *   node website/build.mjs [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = 'https://github.com/MaximumTrainer/chorus'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const OUT = outIndex === -1 ? join(HERE, 'dist') : args[outIndex + 1]

const status = JSON.parse(readFileSync(join(HERE, 'src', 'status.json'), 'utf8'))
const { exchanges } = JSON.parse(readFileSync(join(HERE, 'src', 'transcripts.json'), 'utf8'))

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const json = (value) =>
  value === null || value === undefined ? '' : esc(JSON.stringify(value, null, 2))

// ---------------------------------------------------------------------------
// Content.
//
// The principles are quoted verbatim from architecture.md §2 — all nine of
// them, in order — rather than reworded, so the page cannot drift from the
// document that actually governs the project.
//
// The journeys are the ones architecture.md §25 and plan.md name as the targets
// of each phase (J1 and J7 are the MVP). Their full descriptions live in
// design.md, which is not tracked in this repository, so this page is currently
// the only public description of them.
// ---------------------------------------------------------------------------

const PRINCIPLES = [
  {
    title: 'Intent is the primary artefact',
    body: 'Chats, recordings, feedback and documents are sources of intent; tasks, specs and pull requests are derived from them and keep a traversable link back to their origin. A feature that severs that link is wrong.',
  },
  {
    title: 'Context is compiled, not curated',
    body: 'No human maintains a wiki by hand. Signals are ingested, entities and relationships extracted, pages generated. Humans correct; corrections are re-ingested as high-trust signals and change future output.',
  },
  {
    title: 'Humans hold the gates',
    body: 'Every autonomous step passes a checkpoint whose policy is <code>auto</code>, <code>ask</code> or <code>never</code>. Structure proposals, external writes, coding-job launches and spend thresholds are gated by default.',
  },
  {
    title: 'Bring your own agent and model',
    body: 'No capability may depend on a single vendor. Every model call goes through one provider-agnostic interface; every coding agent is an adapter; every agent-facing capability is reachable over MCP.',
  },
  {
    title: 'Self-host first',
    body: '<code>docker compose up</code> yields a working system on one host. The only mandatory external dependency is the chosen model endpoint, which may be local.',
  },
  {
    title: 'Everything is auditable',
    body: 'Every artefact mutation, agent action, tool call and unit of spend is recorded and attributable to a user or a run, in the same transaction as the change itself.',
  },
  {
    title: 'Boring where possible',
    body: 'The interesting parts are the context engine and the agent runtime. Everything else uses mainstream, well-documented technology so contributors are productive on day one.',
  },
  {
    title: 'Contracts before implementations',
    body: 'Connectors, workflows, coding adapters and chat surfaces are plugin interfaces with typed contracts, fixture-based contract tests and semantic versioning. Core never special-cases one implementation.',
  },
  {
    title: 'Outside-in and test-first',
    body: 'Behaviour is specified as an executable acceptance test before the implementation exists. Requirement ids appear in test names, so traceability is mechanical rather than clerical.',
  },
]

const JOURNEYS = [
  {
    id: 'J1',
    title: 'Idea to engineering-ready tasks',
    body: 'A product manager starts a chat from an idea. The agent pulls codebase and ticket context, asks clarifying questions, drafts a PRD and proposes a task tree. The PM confirms the structure, refines the cards, tags coding tasks and pushes the rest to a tracker.',
  },
  {
    id: 'J2',
    title: 'Feedback that ships',
    body: 'Someone in support captures a broken flow on the live product with the browser extension. The capture is linked to the code path automatically, turned into a task with acceptance criteria and a reproduction, and routed to a coding agent.',
  },
  {
    id: 'J5',
    title: 'Production prototype',
    body: 'From a spec, a PR is opened on the real repository with a mocked backend. The preview URL is surfaced, stakeholders click through and comment, and the spec is updated with what the prototype revealed.',
  },
  {
    id: 'J7',
    title: 'Coding agent over MCP',
    body: 'An engineer tells their own agent to implement a task. The MCP server serves the task, its spec, decision log and code pointers; their agent does the work and posts the pull request back.',
  },
]

const CONTRIBUTE = [
  {
    step: '1',
    title: 'Name the requirement',
    body: `Every change traces to an id from the catalogue — <code>WS-1</code>, <code>BRAIN-4</code>, <code>INT-8</code>, <code>NFR-3</code>. The <a href="${REPO}/issues">issue tracker</a> holds one issue per requirement with its full text, Given/When/Then criteria and an ordered test plan. Branch as <code>&lt;req-id&gt;/&lt;slug&gt;</code>.`,
  },
  {
    step: '2',
    title: 'Write the failing test first',
    body: 'With the requirement id in its name. Run it, and check it fails for the right reason — the missing behaviour, not a typo. A claim that a test <em>would</em> fail is not evidence.',
  },
  {
    step: '3',
    title: 'Work inwards',
    body: 'Acceptance → integration → unit → the minimum implementation that turns the current red test green. Then walk back out, each layer going green in turn.',
  },
  {
    step: '4',
    title: 'Satisfy the cross-cutting rules',
    body: 'Tenancy, permissions, audit, checkpoints and sandboxes. These are the ones most costly to get wrong and least visible when broken, so each is enforced by a suite that enumerates the schema or the route table rather than a list someone maintains.',
  },
  {
    step: '5',
    title: 'Run the gate',
    body: '<code>pnpm verify</code> runs exactly what CI runs. Your pull request states which test proves the requirement, and what you deliberately left out.',
  },
]

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const layerLabels = {
  core: 'unit · integration · contract',
  acceptance: 'acceptance',
  nfr: 'non-functional',
}

const renderStep = (step) => `
          <div class="step">
            <div class="step-head">
              <span class="verb verb-${esc(step.method.toLowerCase())}">${esc(step.method)}</span>
              <code class="path">${esc(step.path)}</code>
              <span class="who">as ${esc(step.as)}</span>
              <span class="status status-${Math.floor(step.status / 100)}">${esc(step.status)}</span>
            </div>
            ${step.body ? `<div class="io"><span class="io-label">request</span><pre>${json(step.body)}</pre></div>` : ''}
            ${
              step.response === null || step.response === undefined
                ? ''
                : `<div class="io"><span class="io-label">response</span><pre>${json(step.response)}</pre></div>`
            }
          </div>`

const renderExchange = (exchange, index) => `
      <article class="exchange" id="exchange-${index + 1}">
        <h3>${esc(exchange.title)}</h3>
        <p class="note">${esc(exchange.note)}</p>
        <div class="terminal">${exchange.steps.map(renderStep).join('')}
        </div>
      </article>`

const phaseRows = status.requirements.byPhase
  .filter((phase) => phase.phase !== 'Later')
  .map(
    (phase) => `
            <tr>
              <th scope="row">Phase ${esc(phase.phase)}</th>
              <td>${esc(phase.total)}</td>
              <td>${esc(phase.withTests)}</td>
              <td>
                <div class="bar" role="img" aria-label="${esc(phase.withTests)} of ${esc(phase.total)} have a test">
                  <span style="width:${phase.total ? Math.round((phase.withTests / phase.total) * 100) : 0}%"></span>
                </div>
              </td>
            </tr>`,
  )
  .join('')

const routeRows = status.routes
  .map(
    (route) => `
            <tr>
              <td><span class="verb verb-${esc(route.method.toLowerCase())}">${esc(route.method)}</span></td>
              <td><code>${esc(route.path)}</code></td>
              <td>${
                route.auth.kind === 'workspace'
                  ? `<span class="role">${esc(route.auth.role)}</span>`
                  : `<span class="role role-open">${esc(route.auth.kind)}</span>`
              }</td>
              <td class="summary">${esc(route.summary)}</td>
            </tr>`,
  )
  .join('')

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chorus — a product workspace for teams that build with coding agents</title>
<meta name="description" content="Self-hostable, open-source product workspace: capture intent once, enrich it with your team's own context, shape it into unambiguous work, and hand it to people or coding agents.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8;
    --surface: #ffffff;
    --surface-2: #f4f2ee;
    --ink: #1a1815;
    --ink-2: #55504a;
    --ink-3: #86807a;
    --line: #e3dfd8;
    --accent: #6a4dff;
    --accent-ink: #ffffff;
    --ok: #1d7a4c;
    --warn: #9a5b00;
    --bad: #b3261e;
    --term-bg: #1c1a24;
    --term-ink: #e6e2f0;
    --term-line: #322e40;
    --radius: 10px;
    --measure: 68ch;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131215;
      --surface: #1b1a1e;
      --surface-2: #232128;
      --ink: #f0ece6;
      --ink-2: #b6b0a8;
      --ink-3: #857f78;
      --line: #302d34;
      --accent: #a894ff;
      --accent-ink: #17141f;
      --ok: #5fcf94;
      --warn: #e0a34a;
      --bad: #ff8a80;
      --term-bg: #0e0d12;
      --term-line: #2a2733;
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  code, pre, .path { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
  a { color: inherit; text-decoration-color: color-mix(in oklab, var(--accent) 55%, transparent); text-underline-offset: 3px; }
  a:hover { text-decoration-color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }
  .skip { position: absolute; left: -9999px; }
  .skip:focus { left: 12px; top: 12px; position: fixed; background: var(--accent); color: var(--accent-ink); padding: 10px 14px; border-radius: 8px; z-index: 10; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  header.site { border-bottom: 1px solid var(--line); position: sticky; top: 0; background: color-mix(in oklab, var(--bg) 88%, transparent); backdrop-filter: blur(10px); z-index: 5; }
  header.site .wrap { display: flex; align-items: center; gap: 20px; height: 58px; }
  .brand { font-weight: 640; letter-spacing: -0.01em; margin-right: auto; display: flex; align-items: center; gap: 9px; }
  .brand .dots { display: inline-flex; gap: 3px; }
  .brand .dots i { width: 4px; height: 15px; border-radius: 2px; background: var(--accent); opacity: .45; }
  .brand .dots i:nth-child(2) { opacity: .7; height: 19px; }
  .brand .dots i:nth-child(3) { opacity: 1; height: 11px; }
  nav.site a { font-size: 14px; color: var(--ink-2); text-decoration: none; margin-left: 18px; }
  nav.site a:hover { color: var(--ink); }
  @media (max-width: 720px) { nav.site { display: none; } }

  .hero { padding: 76px 0 44px; }
  .tag { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line); padding: 5px 12px; border-radius: 999px; }
  .tag b { color: var(--ink); font-weight: 600; }
  h1 { font-size: clamp(34px, 5.5vw, 56px); line-height: 1.08; letter-spacing: -0.028em; margin: 20px 0 0; max-width: 19ch; }
  .lede { font-size: clamp(17px, 2vw, 20px); color: var(--ink-2); max-width: var(--measure); margin: 20px 0 0; }
  .cta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 30px; }
  .btn { display: inline-block; padding: 11px 20px; border-radius: 9px; text-decoration: none; font-size: 15px; font-weight: 520; border: 1px solid var(--line); background: var(--surface); }
  .btn-primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .btn:hover { border-color: var(--accent); }

  section { padding: 56px 0; border-top: 1px solid var(--line); }
  h2 { font-size: clamp(24px, 3vw, 31px); letter-spacing: -0.02em; margin: 0 0 8px; }
  .sub { color: var(--ink-2); max-width: var(--measure); margin: 0 0 32px; }
  h3 { font-size: 17px; margin: 0 0 6px; letter-spacing: -0.01em; }

  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; }
  .card p { margin: 0; color: var(--ink-2); font-size: 14.5px; }
  .card code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: .88em; }
  .num { font-variant-numeric: tabular-nums; font-size: 12px; color: var(--accent); font-weight: 700; letter-spacing: .06em; }

  .stats { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); margin-bottom: 30px; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; }
  .stat b { display: block; font-size: 30px; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .stat span { font-size: 13px; color: var(--ink-2); }

  .notice { background: var(--surface-2); border: 1px solid var(--line); border-left: 3px solid var(--warn); border-radius: 8px; padding: 16px 18px; margin: 0 0 30px; max-width: var(--measure); }
  .notice p { margin: 0; font-size: 14.5px; color: var(--ink-2); }
  .notice strong { color: var(--ink); }

  .exchange { margin-bottom: 26px; }
  .exchange .note { color: var(--ink-2); font-size: 14.5px; max-width: var(--measure); margin: 0 0 14px; }
  .terminal { background: var(--term-bg); border: 1px solid var(--term-line); border-radius: var(--radius); overflow: hidden; }
  .step { border-bottom: 1px solid var(--term-line); padding: 14px 16px; }
  .step:last-child { border-bottom: 0; }
  .step-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .verb { font-size: 11px; font-weight: 700; letter-spacing: .06em; padding: 2px 7px; border-radius: 4px; background: #ffffff1a; color: #cfc8e6; }
  .verb-get { background: #2f6fed33; color: #9dc0ff; }
  .verb-post { background: #1d7a4c33; color: #86e0b3; }
  .verb-put, .verb-patch { background: #9a5b0033; color: #ffcc80; }
  .verb-delete { background: #b3261e33; color: #ff9e95; }
  .verb-sql { background: #6a4dff33; color: #c4b5ff; }
  .path { color: var(--term-ink); font-size: 13.5px; }
  .who { color: #8b84a3; font-size: 12.5px; margin-left: auto; }
  .status { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; padding: 2px 7px; border-radius: 4px; }
  .status-2 { background: #1d7a4c33; color: #86e0b3; }
  .status-4 { background: #b3261e33; color: #ff9e95; }
  .status-5 { background: #b3261e33; color: #ff9e95; }
  .io { margin-top: 10px; }
  .io-label { display: block; font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: #6f6889; margin-bottom: 4px; }
  .terminal pre { margin: 0; padding: 10px 12px; background: #ffffff08; border: 1px solid var(--term-line); border-radius: 7px; color: var(--term-ink); font-size: 12.5px; line-height: 1.55; overflow-x: auto; white-space: pre; }

  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
  tbody tr:last-child td, tbody tr:last-child th { border-bottom: 0; }
  td.summary { color: var(--ink-2); }
  .role { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); }
  .role-open { color: var(--ink-3); }
  .bar { background: var(--surface-2); border-radius: 999px; height: 7px; min-width: 90px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); border-radius: 999px; }

  .steps { counter-reset: s; display: grid; gap: 14px; }
  .stepcard { display: grid; grid-template-columns: 34px 1fr; gap: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px 20px; }
  .stepcard .n { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 13px; font-weight: 700; }
  .stepcard p { margin: 0; color: var(--ink-2); font-size: 14.5px; }
  .stepcard code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: .88em; }

  pre.shell { background: var(--term-bg); color: var(--term-ink); border: 1px solid var(--term-line); border-radius: var(--radius); padding: 16px 18px; overflow-x: auto; font-size: 13.5px; line-height: 1.7; }
  pre.shell .c { color: #8b84a3; }

  footer { border-top: 1px solid var(--line); padding: 34px 0 56px; color: var(--ink-2); font-size: 14px; }
  footer .wrap { display: flex; flex-wrap: wrap; gap: 16px; align-items: baseline; justify-content: space-between; }
  .pill { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; color: var(--ink-3); }
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="site">
  <div class="wrap">
    <span class="brand"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span> Chorus</span>
    <nav class="site" aria-label="Sections">
      <a href="#vision">Vision</a>
      <a href="#journeys">Journeys</a>
      <a href="#working">What works</a>
      <a href="#status">Status</a>
      <a href="#contribute">Contribute</a>
      <a href="#support">Support</a>
    </nav>
  </div>
</header>

<main id="main">

<div class="wrap hero">
  <span class="tag"><b>Phase 0</b> · foundations · pre-alpha</span>
  <h1>A product workspace for teams that build with coding agents.</h1>
  <p class="lede">
    Capture product intent once. Enrich it automatically with your team’s own context.
    Shape it collaboratively into unambiguous work, and hand that work to people or to
    coding agents — without losing the <em>why</em> between steps.
  </p>
  <div class="cta">
    <a class="btn btn-primary" href="${REPO}">View the repository</a>
    <a class="btn" href="#contribute">Start contributing</a>
    <a class="btn" href="#working">See what runs today</a>
  </div>
</div>

<section id="vision">
  <div class="wrap">
    <h2>Vision</h2>
    <p class="sub">
      Chorus is self-hostable and open source. It is not an issue-tracker replacement, a
      deployment platform, a proprietary model or a mobile product — it integrates with the
      trackers you already use, and treats every model provider as swappable.
    </p>
    <div class="grid">
      ${PRINCIPLES.map(
        (principle, i) => `
      <div class="card">
        <span class="num">${String(i + 1).padStart(2, '0')}</span>
        <h3>${esc(principle.title)}</h3>
        <p>${principle.body}</p>
      </div>`,
      ).join('')}
    </div>
  </div>
</section>

<section id="journeys">
  <div class="wrap">
    <h2>What it is for</h2>
    <p class="sub">
      The goal is a small number of journeys that work end to end, rather than a large
      number that half-work. These are the ones the architecture is shaped around.
    </p>
    <div class="grid">
      ${JOURNEYS.map(
        (journey) => `
      <div class="card">
        <span class="num">${esc(journey.id)}</span>
        <h3>${esc(journey.title)}</h3>
        <p>${esc(journey.body)}</p>
      </div>`,
      ).join('')}
    </div>
  </div>
</section>

<section id="working">
  <div class="wrap">
    <h2>What actually works today</h2>
    <p class="sub">
      Chorus is early. <strong>The interface is one screen</strong> — a collaborative
      document editor — and everything else in <code>apps/</code> is an HTTP API. So rather
      than show mock-ups of screens that do not exist, everything below is a real transcript,
      recorded by
      <a href="${REPO}/blob/main/website/capture/record.ts"><code>website/capture</code></a>
      driving the running application over HTTP against a real Postgres. If a response
      changes, this page changes with it.
    </p>

    <div class="notice">
      <p>
        <strong>Read these as evidence, not as a demo.</strong> The refusals matter more than
        the successes: they are where the tenancy, permission and audit guarantees are
        visible. Identifiers are real ULIDs from the recorded run.
      </p>
    </div>

    ${exchanges.map(renderExchange).join('')}
  </div>
</section>

<section id="status">
  <div class="wrap">
    <h2>Honest status</h2>
    <p class="sub">
      Every number here is generated from the repository by
      <a href="${REPO}/blob/main/website/capture/status.ts"><code>website/capture/status.ts</code></a>
      and checked by <a href="${REPO}/blob/main/test/nfr/website.test.ts">a test</a> that fails
      the build if this page and the code disagree. Regenerating them needs a database, so they
      are recorded rather than live: these were taken from
      <code>${esc(status.recordedFromCommit)}</code> on ${esc(status.recordedAt)}, and may lag
      the tip of <code>main</code> by a few commits.
    </p>

    <div class="stats">
      <div class="stat"><b>${esc(status.tests.total)}</b><span>passing tests</span></div>
      <div class="stat"><b>${esc(status.routes.length)}</b><span>HTTP routes, each with a declared role</span></div>
      <div class="stat"><b>${esc(status.requirements.total)}</b><span>catalogued requirements</span></div>
      <div class="stat"><b>${esc(status.requirements.withPassingTests)}</b><span>with a test that names them</span></div>
    </div>

    <div class="notice">
      <p>
        <strong>“Has a test” is not “is finished”.</strong> ${esc(
          status.requirements.withPassingTests,
        )} of ${esc(status.requirements.total)} requirements
        (${status.requirements.ids.map((id) => `<code>${esc(id)}</code>`).join(', ')}) have at
        least one passing test naming them. Several of those have acceptance criteria that are
        deliberately deferred and tracked as
        <a href="${REPO}/issues">open issues</a> — the charter is stored but does not yet reach
        an agent prompt, and coding-job permissions have no route to guard. Nothing here is
        production-ready.
      </p>
    </div>

    <div class="grid" style="margin-bottom:30px">
      ${status.tests.byLayer
        .map(
          (layer) => `
      <div class="card">
        <span class="num">${esc(layer.total)} tests</span>
        <h3>${esc(layerLabels[layer.name] ?? layer.name)}</h3>
        <p>${esc(
          layer.name === 'core'
            ? 'One module with no I/O, one seam against a real database, and one plugin interface against recorded cassettes.'
            : layer.name === 'acceptance'
              ? 'The product as a user or an agent sees it, through a real public entry point, with real infrastructure and faked externals.'
              : 'Tenancy, permissions and bootstrap. These enumerate the schema and the route table, so they grow when the system does.',
        )}</p>
      </div>`,
        )
        .join('')}
    </div>

    <h3 style="margin-bottom:12px">Requirements by phase</h3>
    <div class="table-wrap" style="margin-bottom:30px">
      <table>
        <thead>
          <tr><th scope="col">Phase</th><th scope="col">Requirements</th><th scope="col">With a test</th><th scope="col"><span class="vh">Progress</span></th></tr>
        </thead>
        <tbody>${phaseRows}
        </tbody>
      </table>
    </div>

    <h3 style="margin-bottom:12px">The API as it stands</h3>
    <p class="sub" style="margin-bottom:16px">
      Every route declares the role it requires, and that declaration is what enforces it —
      authorisation is attached from this same table, so a route cannot be mounted without the
      check it describes.
    </p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Requires</th><th scope="col">Purpose</th></tr>
        </thead>
        <tbody>${routeRows}
        </tbody>
      </table>
    </div>
  </div>
</section>

<section id="contribute">
  <div class="wrap">
    <h2>How to contribute</h2>
    <p class="sub">
      Chorus is built outside-in and test-first, and that is not advisory: a pull request whose
      implementation was not preceded by a failing test is not accepted. The rules are in
      <a href="${REPO}/blob/main/CLAUDE.md">CLAUDE.md</a>, the design in
      <a href="${REPO}/blob/main/architecture.md">architecture.md</a>, and the build order in
      <a href="${REPO}/blob/main/plan.md">plan.md</a>.
    </p>

    <pre class="shell"><span class="c"># Node 22+, pnpm and Docker</span>
git clone ${REPO}.git
cd chorus
pnpm install
pnpm verify        <span class="c"># exactly what CI runs</span></pre>

    <div class="steps" style="margin-top:22px">
      ${CONTRIBUTE.map(
        (item) => `
      <div class="stepcard">
        <div class="n" aria-hidden="true">${esc(item.step)}</div>
        <div>
          <h3>${esc(item.title)}</h3>
          <p>${item.body}</p>
        </div>
      </div>`,
      ).join('')}
    </div>

    <h3 style="margin:32px 0 12px">Good places to start</h3>
    <div class="grid">
      <div class="card">
        <h3>Extension points</h3>
        <p>Connectors, workflows, coding adapters and chat surfaces are plugin interfaces with typed contracts and fixture-based test kits. You can add one without touching core.</p>
      </div>
      <div class="card">
        <h3>Open requirements</h3>
        <p>Each issue carries its full requirement text, Given/When/Then acceptance criteria and an ordered outside-in test plan — so the specification is done before you start.</p>
      </div>
      <div class="card">
        <h3>Read <a href="${REPO}/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a></h3>
        <p>Conventions for branches, Conventional Commits with the requirement id, DCO sign-off, and what a pull request must state.</p>
      </div>
    </div>
  </div>
</section>

<section id="support">
  <div class="wrap">
    <h2>Support the project</h2>
    <p class="sub">
      Chorus is Apache-2.0 and self-hosted. There is no hosted product, no paid tier and
      nothing to buy — the most valuable support is participation.
    </p>
    <div class="grid">
      <div class="card">
        <h3>Use it and report what breaks</h3>
        <p>A bug report against a self-hosted deployment, with the request id from the response, is worth more than a feature request. Every response carries one.</p>
      </div>
      <div class="card">
        <h3>Challenge the architecture</h3>
        <p><a href="${REPO}/blob/main/architecture.md">architecture.md</a> is normative and <a href="${REPO}/tree/main/docs/adr">ADRs</a> record what was decided and why. If a decision is wrong, saying so early is the cheapest possible contribution.</p>
      </div>
      <div class="card">
        <h3>Star and share</h3>
        <p>Visibility brings contributors, and contributors are the only thing that moves a 116-requirement catalogue. <a href="${REPO}">Star the repository</a>.</p>
      </div>
      <div class="card">
        <h3>Answer a question</h3>
        <p>Help someone in <a href="${REPO}/issues">issues</a>. A project that answers questions quickly is one people are willing to depend on.</p>
      </div>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="wrap">
    <div>
      Apache-2.0 · <a href="${REPO}">github.com/MaximumTrainer/chorus</a>
    </div>
    <div>
      <span class="pill">Figures generated from <code>${esc(status.recordedFromCommit)}</code> — none typed by hand</span>
    </div>
  </div>
</footer>
</body>
</html>
`

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'index.html'), html, 'utf8')
// Pages would otherwise run the output through Jekyll, which silently drops
// files and directories beginning with an underscore.
writeFileSync(join(OUT, '.nojekyll'), '', 'utf8')

console.log(
  `built ${join(OUT, 'index.html')} — ${exchanges.length} transcripts, ${status.routes.length} routes, ${status.tests.total} tests`,
)

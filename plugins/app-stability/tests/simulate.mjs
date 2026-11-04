// Runs workflows/monitor.js against stub agents, so its control flow can be checked
// without Firebase, GitHub or a model. Run: node plugins/app-stability/tests/simulate.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs
  .readFileSync(path.join(here, '..', 'workflows', 'monitor.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')

// Fixture: i1 new, i2 has an open PR, i3 fixed by a merged PR, i4 regressed after a merged PR,
// i5 already reported in an open GitHub issue. i1 is reported twice (fresh query + duplicate).
const STATUS = { i1: 'no_existing_work', i2: 'pr_open', i3: 'pr_merged', i4: 'pr_merged', i5: 'issue_open' }
const HIGH = new Set(['i1', 'i5'])

async function run(argv, { stack = 'flutter', mcpUnavailable = false } = {}) {
  const calls = []
  const prompts = {}
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || opts.phase
    calls.push(label)
    prompts[label] = prompt
    const id = label.split(':')[1]
    if (opts.phase === 'Discover') {
      if (mcpUnavailable) return { mcp_unavailable: true, stack: '', apps: [], issues: [], message: 'run firebase login' }
      return {
        mcp_unavailable: false,
        stack,
        stack_vars: { flutter_cmd: 'fvm flutter', package_name: 'my_app' },
        apps: [{ package_id: 'com.example', app_id: '1:1:android:x', platform: 'android' }],
        issues: ['i1', 'i2', 'i3', 'i4', 'i5', 'i1'].map(issueId => ({
          issue_id: issueId,
          app_id: '1:1:android:x',
          title: `title ${issueId}`,
          url: `https://console/${issueId}`,
          signals: issueId === 'i4' ? ['SIGNAL_REGRESSED'] : ['SIGNAL_FRESH'],
        })),
      }
    }
    if (label.startsWith('check-existing')) {
      return {
        issue_id: id,
        status: STATUS[id],
        existing_pr_url: `https://github/pr/${id}`,
        existing_issue_url: STATUS[id] === 'issue_open' ? 'https://github/issues/77' : '',
      }
    }
    if (label.startsWith('extract')) return { issue_id: id, issue_title: `T ${id}`, stack_trace: '#0 lib/a.dart:1', data_unavailable: false }
    if (label.startsWith('classify')) {
      return {
        issue_id: id,
        crash_type: 'null_safety',
        confidence: HIGH.has(id) ? 'high' : 'low',
        affected_file: 'lib/a.dart',
        fix_description: 'guard null',
        scope: 'app',
        title_summary: 'guard null in a',
      }
    }
    // Triage agents return a wrong issue_id on purpose: the workflow must keep its own.
    if (label.startsWith('fix')) return { issue_id: 'WRONG', action_taken: 'pr_opened', pr_url: `https://github/pr/new-${id}` }
    if (label.startsWith('issue')) return { issue_id: 'WRONG', action_taken: 'github_issue_filed', github_issue_url: `https://github/issues/new-${id}` }
    if (label.startsWith('comment')) return { issue_id: 'WRONG', action_taken: 'comment_added', github_issue_url: 'https://github/issues/77' }
    if (opts.phase === 'Annotate') return { noted: [], failed: [] }
    throw new Error(`unexpected agent ${label}`)
  }
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let r = item
      for (const stage of stages) r = await stage(r, item, i)
      return r
    }))
  const body = new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', `return (async () => {${source}})()`)
  const result = await body(agent, parallel, pipeline, () => {}, () => {}, argv)
  return { result, calls, prompts }
}

const tests = {
  async 'dry run plans actions and writes nothing'() {
    const { result, calls } = await run(['--dry-run', '--hours', '168', 'com.example'])
    assert.equal(result.dry_run, true)
    assert.equal(result.window_hours, 168)
    const actions = Object.fromEntries(result.planned.map(p => [p.issue_id, p.action]))
    assert.deepEqual(actions, { i1: 'fix_pr', i4: 'file_github_issue', i5: 'fix_pr_closing_existing_issue' })
    assert.equal(result.planned.find(p => p.issue_id === 'i4').regressed_after_pr, 'https://github/pr/i4')
    assert.deepEqual(result.already_fixed.map(r => r.issue_id), ['i3'])
    assert.deepEqual(result.skipped_pr_open.map(r => r.issue_id), ['i2'])
    assert.ok(!calls.some(c => /^(fix|issue|comment):/.test(c) || c === 'Annotate'))
  },

  async 'duplicate issues are checked once'() {
    const { calls } = await run(['--dry-run'])
    assert.equal(calls.filter(c => c === 'check-existing:i1').length, 1)
  },

  async 'full run triages, keeps issue ids and annotates'() {
    const { result, prompts } = await run(['--base', 'develop', '--label', 'crash'])
    assert.deepEqual(result.prs_opened.map(r => r.issue_id).sort(), ['i1', 'i5'])
    assert.deepEqual(result.github_issues_filed.map(r => r.issue_id), ['i4'])
    assert.deepEqual(result.regressed.map(r => r.issue_id), ['i4'])
    assert.match(prompts['fix:i1'], /--base develop/)
    assert.match(prompts['fix:i1'], /fvm flutter analyze/)
    assert.match(prompts['fix:i5'], /Closes #77/)
    assert.match(prompts['issue:i4'], /--label "crash"/)
    assert.match(prompts.Annotate, /issueId=i1 /)
    assert.match(prompts.Annotate, /issueId=i4 /)
    assert.doesNotMatch(prompts.Annotate, /WRONG/)
  },

  async 'unsupported stack never auto-fixes'() {
    const { result, calls, prompts } = await run([], { stack: 'cobol' })
    assert.equal(result.stack, '')
    assert.equal(result.prs_opened.length, 0)
    assert.ok(!calls.some(c => c.startsWith('fix:')))
    assert.match(prompts['classify:i1'], /always "low"/)
    // i1 and i4 get new issues; i5 already has one, so it gets a comment.
    assert.deepEqual(result.github_issues_filed.map(r => r.issue_id).sort(), ['i1', 'i4'])
    assert.deepEqual(result.comments_added.map(r => r.issue_id), ['i5'])
  },

  async 'stops when the Firebase MCP is unavailable'() {
    const { result, calls } = await run([], { mcpUnavailable: true })
    assert.equal(result.error, 'mcp_unavailable')
    assert.deepEqual(calls, ['Discover'])
  },

  async 'prompts never hard-code an MCP tool prefix'() {
    assert.doesNotMatch(source, /mcp__/)
  },
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`)
  }
}
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(tests).length} passed`)
process.exit(failed ? 1 : 0)

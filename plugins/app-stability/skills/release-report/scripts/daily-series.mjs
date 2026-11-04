#!/usr/bin/env node
// Daily crash-free metrics per app version from Firebase Crashlytics, through the same Firebase MCP
// server the plugin bundles (`firebase mcp`), in one session. Read-only.
//
// Usage:
//   node daily-series.mjs --app <firebase app id> --from YYYY-MM-DD --to YYYY-MM-DD \
//     --version "5.21.7 (5547)" --version "5.21.6 (5545)" [--out series.json]
//
// For each UTC day in [from, to] it calls crashlytics_get_top_versions twice (FATAL only, then
// unfiltered) and records, per requested version:
//   { day, version, users, sessions, crashedUsers, crashes, cfu, cfs, status }
// status: "ok"        fatal and unfiltered data present
//         "no_fatal"  the version had users but no fatal events that day → cfu/cfs = 100
//         "no_data"   the version reported nothing that day (a gap, not a zero)
//         "failed"    the calls kept failing after retries: never use these values
// Prints a one-line summary to stderr and the rows as JSON (stdout or --out).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

const argv = process.argv.slice(2)
const opt = { versions: [] }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--app') opt.app = argv[++i]
  else if (a === '--from') opt.from = argv[++i]
  else if (a === '--to') opt.to = argv[++i]
  else if (a === '--version') opt.versions.push(argv[++i])
  else if (a === '--out') opt.out = argv[++i]
}
if (!opt.app || !opt.from || !opt.to || !opt.versions.length) {
  console.error('usage: daily-series.mjs --app <id> --from YYYY-MM-DD --to YYYY-MM-DD --version "<display name>" [--version ...] [--out file]')
  process.exit(2)
}

const server = spawn('firebase', ['mcp', '--tools', 'crashlytics_get_top_versions'], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'] }) // tmpdir: keeps firebase-debug.log out of the report folder
server.on('error', e => { console.error(`cannot start "firebase mcp": ${e.message}`); process.exit(1) })
let buf = ''
let nextId = 1
const pending = new Map()
server.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    try {
      const msg = JSON.parse(line)
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    } catch {}
  }
})
const rpc = (method, params) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'app-stability-release-report', version: '1' } })
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

// Parses the YAML-ish text of a topVersions report into { displayName: metrics }.
function parse(text) {
  const out = {}
  for (const group of text.split(/\n  - metrics:/).slice(1)) {
    const name = (group.match(/displayName: (.+)/) || [])[1]?.trim()
    if (!name) continue
    const num = key => {
      const m = group.match(new RegExp(`${key}: '?([\\d.]+)`))
      return m ? Number(m[1]) : null
    }
    out[name] = {
      users: num('totalUsersCount'),
      sessions: num('totalSessionsCount'),
      crashedUsers: num('impactedUsersCount'),
      crashes: num('eventsCount'),
      cfu: num('crashFreeUsersPercentage'),
      cfs: num('crashFreeSessionsPercentage'),
    }
  }
  return out
}

async function report(start, end, filter) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await rpc('tools/call', {
      name: 'crashlytics_get_top_versions',
      arguments: { appId: opt.app, filter: { intervalStartTime: start, intervalEndTime: end, ...filter }, pageSize: 100 },
    })
    const text = (res.result?.content || []).map(c => c.text).join('')
    if (res.result && !res.result.isError) return parse(text)
    if (/auth|credential|login/i.test(text)) {
      console.error(`authentication failed: ${text.slice(0, 200)}`)
      process.exit(1)
    }
    await sleep(3000 * (attempt + 1)) // rate limits clear after a few seconds
  }
  return null
}

const rows = []
for (let day = new Date(`${opt.from}T00:00:00Z`); day <= new Date(`${opt.to}T00:00:00Z`); day = new Date(+day + 864e5)) {
  const start = day.toISOString()
  const end = new Date(+day + 864e5).toISOString()
  const fatal = await report(start, end, { issueErrorTypes: ['FATAL'] })
  await sleep(500)
  const all = await report(start, end, {})
  await sleep(500)
  for (const version of opt.versions) {
    const d = start.slice(0, 10)
    if (!fatal || !all) {
      rows.push({ day: d, version, status: 'failed' })
      continue
    }
    const f = fatal[version]
    const a = all[version]
    if (!a || !a.users) {
      rows.push({ day: d, version, status: 'no_data' })
    } else if (!f || f.cfu == null) {
      rows.push({ day: d, version, users: a.users, sessions: a.sessions, crashedUsers: 0, crashes: 0, cfu: 100, cfs: 100, status: 'no_fatal' })
    } else {
      rows.push({ day: d, version, users: f.users ?? a.users, sessions: f.sessions ?? a.sessions, crashedUsers: f.crashedUsers, crashes: f.crashes, cfu: f.cfu, cfs: f.cfs, status: 'ok' })
    }
  }
}
server.kill()

const failed = rows.filter(r => r.status === 'failed').length
console.error(`${rows.length} rows, ${failed} failed${failed ? ' (re-run those days; never use failed rows)' : ''}`)
const json = JSON.stringify(rows, null, 1)
if (opt.out) fs.writeFileSync(opt.out, json)
else process.stdout.write(json + '\n')
process.exit(0)

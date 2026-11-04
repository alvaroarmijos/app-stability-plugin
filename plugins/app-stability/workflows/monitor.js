export const meta = {
  name: 'monitor',
  description: 'Poll Firebase Crashlytics for fresh and regressed issues and triage each one into a fix PR or a GitHub issue',
  whenToUse: 'Run from the /app-stability:monitor command. args is an array of CLI-style strings: --base <branch>, --hours <n>, --label <name>, --dry-run, and app package / bundle IDs.',
  phases: [
    { title: 'Discover', detail: 'Detect the stack, resolve Firebase app IDs and list fresh/regressed Crashlytics issues' },
    { title: 'Check Existing', detail: 'Look for GitHub issues, PRs and commits that already reference each Crashlytics issue' },
    { title: 'Extract', detail: 'Fetch issue details, the latest stack trace and affected versions' },
    { title: 'Classify', detail: 'Classify crash type and auto-fix confidence per issue' },
    { title: 'Triage', detail: 'Open fix PRs (high confidence) or file / update GitHub issues (low confidence)' },
    { title: 'Annotate', detail: 'Add an app-stability note to each triaged Crashlytics issue' },
  ],
}

// Requires the Firebase MCP server bundled with this plugin (plugins/app-stability/.mcp.json),
// the Firebase CLI logged in (`firebase login`) and the GitHub CLI logged in (`gh auth login`).
// MCP tool names carry a client-specific prefix, so prompts name them by their short
// name (crashlytics_*) and load them with ToolSearch.

// ── Stacks ─────────────────────────────────────────────────────────────────
// Everything that depends on the project's language lives here. Discover picks one key
// by its `detect` rule (or none). With no stack, every issue is filed as a GitHub issue:
// the monitor still works, it just never auto-fixes. Add a stack by adding an entry.

const STACKS = {
  flutter: {
    label: 'Flutter / Dart',
    detect: 'pubspec.yaml exists at the repository root and lists `flutter:` under dependencies',
    vars: `flutter_cmd: "fvm flutter" if .fvmrc or a .fvm/ directory exists at the repository root, otherwise "flutter".
package_name: the top-level \`name:\` value in pubspec.yaml.`,
    projectFiles: '.dart files under lib/ or packages/*/lib/',
    sdkFrames: 'package:flutter/, dart:, .pub-cache paths, and package:<pkg>/ frames where packages/<pkg>/ does not exist in this repository',
    wrapperFrames: 'FirebaseCrashlytics.recordError, and any project function whose only job is to log or record the error (for example a Logger.exception / logError wrapper)',
    frameMapping: v => `package:${v.package_name || '<package_name>'}/<path> → lib/<path>; package:<pkg>/<path> → packages/<pkg>/lib/<path> when that folder exists`,
    scopeExample: 'lib/video/cubit/current_video_cubit.dart → "video", lib/deep_links/... → "deep-links", packages/downloads_manager/... → "downloads-manager"',
    fixRecipes: `   - null_safety / type_cast: add ?, ??, replace \`as Type\` with \`as Type?\`, or add a null guard
   - network: wrap the non-critical call in try/catch and log
   - platform_channel: catch PlatformException, log, and return null/empty
   - logic_error: add a default/fallback case`,
    analyze: v => `${v.flutter_cmd || 'flutter'} analyze`,
    test: v => `${v.flutter_cmd || 'flutter'} test <test file>`,
    testLocation: 'lib/<path>.dart → test/<path>_test.dart; packages/<pkg>/lib/<path>.dart → packages/<pkg>/test/<path>_test.dart',
    testConventions: 'Follow the test conventions in the repository\'s CLAUDE.md / README and the style of the existing tests next to the file (for example bloc_test for cubits and blocs, and the repo\'s mocking library and mock helpers).',
  },
}

const CRASH_TYPES = 'null_safety | type_cast | network | permission | logic_error | platform_channel | framework | unknown'

// ── Schemas ────────────────────────────────────────────────────────────────

const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    mcp_unavailable: { type: 'boolean' },
    message: { type: 'string' },
    stack: { type: 'string' }, // a STACKS key, or "" when none matches
    stack_vars: {
      type: 'object',
      properties: {
        flutter_cmd: { type: 'string' },
        package_name: { type: 'string' },
      },
    },
    apps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          package_id: { type: 'string' },
          app_id: { type: 'string' },
          platform: { type: 'string' },
        },
        required: ['package_id', 'app_id', 'platform'],
      },
    },
    skipped_noted: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue_id: { type: 'string' },
          app_id: { type: 'string' },
          platform: { type: 'string' },
          title: { type: 'string' },
          url: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
          error_type: { type: 'string' },
          event_count: { type: 'string' },
          user_count: { type: 'string' },
        },
        required: ['issue_id', 'app_id', 'title', 'url', 'signals'],
      },
    },
  },
  required: ['mcp_unavailable', 'stack', 'apps', 'issues'],
}

const ISSUE_EXTRACTION = {
  type: 'object',
  properties: {
    issue_id: { type: 'string' },
    issue_title: { type: 'string' },
    stack_trace: { type: 'string' },
    affected_versions: { type: 'string' },
    user_count: { type: 'string' },
    first_seen: { type: 'string' },
    last_seen: { type: 'string' },
    data_unavailable: { type: 'boolean' },
  },
  required: ['issue_id', 'issue_title', 'stack_trace', 'data_unavailable'],
}

const CLASSIFIED_SCHEMA = {
  type: 'object',
  properties: {
    issue_id: { type: 'string' },
    crash_type: { type: 'string' },
    confidence: { type: 'string' },
    affected_file: { type: 'string' },
    fix_description: { type: 'string' },
    scope: { type: 'string' },
    title_summary: { type: 'string' },
  },
  required: ['issue_id', 'crash_type', 'confidence', 'affected_file', 'fix_description', 'scope', 'title_summary'],
}

const TRIAGE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    issue_id: { type: 'string' },
    action_taken: { type: 'string' },
    pr_url: { type: 'string' },
    github_issue_url: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['issue_id', 'action_taken'],
}

const EXISTING_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    issue_id: { type: 'string' },
    status: { type: 'string' }, // no_existing_work | issue_open | pr_open | pr_merged
    existing_issue_url: { type: 'string' },
    existing_pr_url: { type: 'string' },
  },
  required: ['issue_id', 'status'],
}

const ANNOTATE_SCHEMA = {
  type: 'object',
  properties: {
    noted: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'string' } },
  },
  required: ['noted', 'failed'],
}

const NOTE_PREFIX = 'app-stability:'

// ── Args ───────────────────────────────────────────────────────────────────
// --base <branch>   PR target branch (default: the repository default branch)
// --hours <n>       look-back window (default 24, max 2160 = 90 days)
// --label <name>    label for filed GitHub issues (default needs-human-review)
// --dry-run         stop after Classify, write nothing
// remaining args    Android package names / iOS bundle IDs

let prBaseBranch = null
let hours = 24
let issueLabel = 'needs-human-review'
let dryRun = false
const packageArgs = []
const rawArgs = args ? (Array.isArray(args) ? args : String(args).split(/\s+/)) : []
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]
  if (a === '--base' && i + 1 < rawArgs.length) {
    prBaseBranch = rawArgs[++i]
  } else if (a === '--hours' && i + 1 < rawArgs.length) {
    const n = parseInt(rawArgs[++i], 10)
    if (n > 0) hours = Math.min(n, 90 * 24)
  } else if (a === '--label' && i + 1 < rawArgs.length) {
    issueLabel = rawArgs[++i]
  } else if (a === '--dry-run') {
    dryRun = true
  } else if (a) {
    packageArgs.push(a)
  }
}

// ── Phase: Discover ────────────────────────────────────────────────────────
phase('Discover')

const stackDetectLines = Object.entries(STACKS)
  .map(([key, s]) => `- "${key}" (${s.label}): ${s.detect}. Then fill stack_vars:\n${s.vars.split('\n').map(l => `    ${l}`).join('\n')}`)
  .join('\n')

const discovery = await agent(
  `You are the discovery agent for the app-stability monitor. Read Crashlytics only through the Firebase
MCP server's tools (crashlytics_* and firebase_*; load them with ToolSearch, query "crashlytics").
Never open a browser and never read email.

If those tools are not available, or a call fails with an authentication error, stop and return
mcp_unavailable=true, stack="", apps=[], issues=[], and a message with the fix: install the
Firebase CLI (npm i -g firebase-tools), run "firebase login", and restart Claude Code so the
app-stability plugin's MCP server starts.

## Step 0: Detect the stack (in the repository's working directory)
Pick the first that matches:
${stackDetectLines}
If none matches, return stack="" and stack_vars={}.

## Step 1: Resolve package IDs → Firebase app IDs
${packageArgs.length
  ? `PACKAGE_IDS = ${JSON.stringify(packageArgs)}.`
  : `No package IDs were given: use every app found in the config files below.`}
Find the Firebase config files, ignoring build/, .dart_tool/, Pods/, node_modules/ and .claude/:
  find . -name google-services.json -o -name 'GoogleService-Info*.plist'
- Android: in google-services.json, the client whose "package_name" matches has "mobilesdk_app_id".
- iOS: in the plist whose BUNDLE_ID matches, GOOGLE_APP_ID.
When several files match one ID (one per flavor), prefer a path containing "prod", "production" or
"release", then a file with no flavor in its path. If nothing matches, call firebase_list_apps.
platform = the segment after the project number in the app ID ("android" or "ios").

## Step 2: Time window
Run: date -u -v-${hours}H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "${hours} hours ago" +%Y-%m-%dT%H:%M:%SZ   (start)
and: date -u +%Y-%m-%dT%H:%M:%SZ   (end)

## Step 3: List candidate issues per app
Call crashlytics_get_top_issues with appId, pageSize 20 and filter:
  intervalStartTime=<start>, intervalEndTime=<end>,
  issueSignals=[<SIGNAL>], issueErrorTypes=["FATAL","NON_FATAL","ANR"]
TWICE per app: once with SIGNAL_FRESH, once with SIGNAL_REGRESSED. The response does not list an
issue's signals, so the query that returned it is the signal: merge both lists by issue.id and set
signals to the signal(s) whose query returned that issue. Drop "ANR" from issueErrorTypes for iOS apps
if the call rejects it.
For each issue: issue_id (issue.id), title (issue.title + " — " + issue.subtitle, max 200 chars),
error_type (issue.errorType), event_count (metrics[0].eventsCount), user_count (metrics[0].impactedUsersCount),
url = issue.uri with any "?..." query string removed.

## Step 4: Skip issues triaged by an earlier run
For each candidate call crashlytics_list_notes(appId, issueId). If any note body starts with
"${NOTE_PREFIX}", drop the issue and add its id to skipped_noted, UNLESS its signals include
SIGNAL_REGRESSED, in which case keep it.

Return stack, stack_vars, apps, issues (after Step 4), skipped_noted, mcp_unavailable=false, and a short message.`,
  { phase: 'Discover', schema: DISCOVERY_SCHEMA }
)

if (!discovery) {
  log('Discovery agent failed.')
  return { triaged: 0, error: 'discovery_failed' }
}
if (discovery.mcp_unavailable) {
  log(`Firebase MCP unavailable: ${discovery.message || ''}`)
  return { triaged: 0, error: 'mcp_unavailable', message: discovery.message }
}

const stackKey = STACKS[discovery.stack] ? discovery.stack : ''
const stack = stackKey ? STACKS[stackKey] : null
const vars = discovery.stack_vars || {}
log(stack ? `Stack: ${stack.label}.` : 'No supported stack detected: issues will be filed as GitHub issues, never auto-fixed.')

if ((discovery.skipped_noted || []).length) {
  log(`Skipped ${discovery.skipped_noted.length} issue(s) already triaged by an earlier run.`)
}
if (!discovery.issues.length) {
  log(discovery.message || `No fresh or regressed Crashlytics issues in the last ${hours}h.`)
  return { triaged: 0, stack: stackKey, apps: discovery.apps }
}

// ── Deduplicate by Crashlytics issue_id (plain JS) ─────────────────────────
const issueGroups = new Map()
for (const item of discovery.issues) {
  if (!item.issue_id) continue
  const seen = issueGroups.get(item.issue_id)
  if (seen) {
    seen.signals = [...new Set([...seen.signals, ...(item.signals || [])])]
  } else {
    issueGroups.set(item.issue_id, { ...item, signals: item.signals || [] })
  }
}
const dedupedIssues = [...issueGroups.values()]
const isRegressed = i => (i.signals || []).includes('SIGNAL_REGRESSED')

log(`Found ${dedupedIssues.length} issue(s) across ${discovery.apps.length} app(s) in the last ${hours}h.`)

// ── Check Existing → Extract → Classify, pipelined per issue ───────────────
const normalizeStatus = s =>
  ['no_existing_work', 'issue_open', 'pr_open', 'pr_merged'].includes(s) ? s : 'no_existing_work'

const checkExisting = issue =>
  agent(
    `Check whether this Crashlytics issue has already been addressed in this repository.

Crashlytics issue_id: ${issue.issue_id}

Run these commands in the repository's working directory (the issue_id is Crashlytics's own opaque
identifier, safe to search for literally):

1. gh issue list --search "${issue.issue_id}" --state all --json number,title,url,state
2. gh pr list --search "${issue.issue_id}" --state all --json number,title,url,state,mergedAt
3. Cross-check: git log --all --grep="crashlytics/${issue.issue_id}" --oneline

A match only counts if "${issue.issue_id}" appears literally in the PR/issue title, body, or a
commit message.

Decide status with this priority (most conclusive wins):
- "pr_merged": a PR from step 2 is MERGED (or mergedAt is non-null).
- "pr_open": a PR from step 2 is OPEN and none is merged.
- "issue_open": no matching PR, but an issue from step 1 is OPEN.
- "no_existing_work": none of the above.

Return issue_id, status, existing_issue_url (matched issue's url or ""), existing_pr_url (matched PR's url or "").`,
    { label: `check-existing:${issue.issue_id}`, phase: 'Check Existing', schema: EXISTING_CHECK_SCHEMA }
  ).then(r => {
    const merged = { ...issue, ...r, issue_id: issue.issue_id, status: normalizeStatus(r && r.status) }
    // A merged fix that regressed did not hold: triage it again instead of skipping.
    if (merged.status === 'pr_merged' && isRegressed(issue)) {
      return { ...merged, status: 'no_existing_work', regressed_after_pr: merged.existing_pr_url }
    }
    return merged
  })

const extract = issue =>
  agent(
    `Fetch the data for this Crashlytics issue with the Firebase MCP tools (crashlytics_*; load them with
ToolSearch, query "crashlytics"). Never open a browser.

appId: ${issue.app_id}
issueId: ${issue.issue_id}

1. crashlytics_get_issue(appId, issueId) → issue_title, first_seen, last_seen.
2. crashlytics_list_events(appId, filter={issueId}, pageSize=1) → stack_trace: copy the event's
   "exceptions" block verbatim (exception type and message, then every "at ... (file:line)" frame,
   including "Caused by:" sections). If there is no exceptions block, use the crashed/blamed "threads"
   block. Append customKeys that describe the error (for example flutter_error_reason) if present.
   Frames from crash-reporting or logging wrappers (${stack ? stack.wrapperFrames : 'FirebaseCrashlytics.recordError and project logging helpers'})
   are not the root cause: keep them, but mark the first frame after them with "(first app frame)".
3. crashlytics_get_top_versions(appId, filter={issueId}) → affected_versions: comma-separated displayNames.
   user_count: total impacted users from that report (fallback: "${issue.user_count || ''}").

If the tools fail or return no event, set data_unavailable=true and keep whatever stack_trace you got
("" if nothing). Otherwise data_unavailable=false.

Return issue_id, issue_title, stack_trace, affected_versions, user_count, first_seen, last_seen, data_unavailable.`,
    { label: `extract:${issue.issue_id}`, phase: 'Extract', schema: ISSUE_EXTRACTION }
  ).then(r => ({
    ...issue,
    ...(r || { stack_trace: '', data_unavailable: true }),
    issue_id: issue.issue_id,
    issue_title: (r && r.issue_title) || issue.title,
    user_count: (r && r.user_count) || issue.user_count,
  }))

const confidenceRules = stack
  ? `- confidence: "high" ONLY when ALL of these hold:
  1. crash_type is one of: null_safety, type_cast, network, platform_channel, logic_error
  2. affected_file is a project-owned file (${stack.projectFiles}), not a framework/SDK/third-party frame
     (${stack.sdkFrames})
  3. The trace points to a single root-cause location
  4. The fix is mechanical and matches one of these recipes:
${stack.fixRecipes}
  5. For network / platform_channel / logic_error only: the path is non-critical (notifications, media,
     analytics, image caching, optional prefetch, display helpers).
     NEVER high confidence for: authentication, payments, required data sync, core API calls.
  - Always "low": framework, unknown, a multi-root trace, a top frame inside the framework/SDK, data_unavailable=true.`
  : `- confidence: always "low" (this repository's stack is not supported for auto-fixes).`

const classify = extraction =>
  agent(
    `Classify this Crashlytics crash and decide the confidence level for an automatic fix.

Issue ID: ${extraction.issue_id}
Title: ${extraction.issue_title}
Error type: ${extraction.error_type || 'unknown'}
Signals: ${(extraction.signals || []).join(', ')}
Stack trace:
${extraction.stack_trace || '(unavailable)'}
Data unavailable: ${extraction.data_unavailable}

Determine:
- crash_type: ${CRASH_TYPES}
${confidenceRules}
- affected_file: the top project-owned frame as a repository path, skipping crash-reporting and logging
  wrappers (use the frame marked "(first app frame)" if present).${stack ? ` Map frames to paths: ${stack.frameMapping(vars)}.` : ''}
  Empty string if not found.
- fix_description: one sentence explaining the fix, or why it cannot be auto-fixed
- scope: short kebab-case feature area from affected_file's folder${stack ? ` (e.g. ${stack.scopeExample})` : ''}. Use "app" if unclear.
- title_summary: lowercase imperative phrase, max 60 chars, naming the concrete bug and where it happens
  (e.g. "guard null controller in VideoCubit.seek", "fall back when translation id is unknown").
  NEVER generic phrases like "fix crash". Do not include the issue ID.

Return issue_id, crash_type, confidence, affected_file, fix_description, scope, title_summary.`,
    { label: `classify:${extraction.issue_id}`, phase: 'Classify', schema: CLASSIFIED_SCHEMA }
  ).then(r =>
    r
      ? { ...extraction, ...r, issue_id: extraction.issue_id, confidence: stack ? r.confidence : 'low' }
      : null
  )

const processed = (
  await pipeline(
    dedupedIssues,
    issue => checkExisting(issue),
    checked =>
      checked.status === 'pr_merged' || checked.status === 'pr_open'
        ? checked // already handled: skip Extract/Classify
        : extract(checked).then(classify),
  )
).filter(Boolean)

const alreadyFixedResults = processed
  .filter(c => c.status === 'pr_merged')
  .map(issue => ({ ...issue, action_taken: 'already_fixed', reason: `Already fixed by merged PR: ${issue.existing_pr_url}` }))

const prOpenSkipped = processed
  .filter(c => c.status === 'pr_open')
  .map(issue => ({ ...issue, action_taken: 'skipped_pr_open', reason: `A PR is already open for this issue: ${issue.existing_pr_url}` }))

const classifiedIssues = processed.filter(c => c.status !== 'pr_merged' && c.status !== 'pr_open' && c.confidence)
const highConf = classifiedIssues.filter(c => c.confidence === 'high')
const lowConf = classifiedIssues.filter(c => c.confidence !== 'high')

log(`Check Existing: ${alreadyFixedResults.length} already fixed, ${prOpenSkipped.length} with an open PR (skipped).`)
if (classifiedIssues.length) {
  log(`Classified: ${highConf.length} high-confidence (auto-fix), ${lowConf.length} low-confidence (GitHub issue).`)
}

const plannedAction = i => {
  if (i.confidence === 'high') return i.status === 'issue_open' ? 'fix_pr_closing_existing_issue' : 'fix_pr'
  return i.status === 'issue_open' ? 'comment_on_existing_issue' : 'file_github_issue'
}

if (dryRun) {
  log('Dry run: stopping before Triage. Nothing was written to GitHub or Firebase.')
  return {
    dry_run: true,
    window_hours: hours,
    stack: stackKey,
    apps: discovery.apps,
    planned: classifiedIssues.map(i => ({
      issue_id: i.issue_id,
      title: i.issue_title,
      url: i.url,
      signals: i.signals,
      crash_type: i.crash_type,
      confidence: i.confidence,
      affected_file: i.affected_file,
      action: plannedAction(i),
      regressed_after_pr: i.regressed_after_pr || '',
      fix_description: i.fix_description,
    })),
    already_fixed: alreadyFixedResults.map(r => ({ issue_id: r.issue_id, pr_url: r.existing_pr_url })),
    skipped_pr_open: prOpenSkipped.map(r => ({ issue_id: r.issue_id, pr_url: r.existing_pr_url })),
  }
}

// ── Phase: Triage ──────────────────────────────────────────────────────────
const issueNumberRef = url => {
  const m = url && url.match(/\/issues\/(\d+)/)
  return m ? `#${m[1]}` : url
}

const evidenceLines = issue => `Crashlytics URL: ${issue.url}
Signals: ${(issue.signals || []).join(', ') || '(none)'}  |  Error type: ${issue.error_type || 'unknown'}  |  Events: ${issue.event_count || '?'}
Users affected: ${issue.user_count}  |  Affected versions: ${issue.affected_versions}
First seen: ${issue.first_seen}  |  Last seen: ${issue.last_seen}${issue.regressed_after_pr ? `
Regressed after merged PR: ${issue.regressed_after_pr} (that fix did not hold)` : ''}`

const regressionTestStep = issue => `2b. Add a regression test for the fix (required unless the code is genuinely untestable):
   - Find the mirrored test file (${stack.testLocation}) for ${issue.affected_file}. Extend it if it exists,
     otherwise create it.
   - Feed the exact input from the stack trace (null value, wrong type, thrown exception, unexpected
     case) and assert the new fallback behavior instead of a crash. Cover the new branch so the fix does
     not lower coverage.
   - ${stack.testConventions}
   - Run: ${stack.test(vars)}. Iterate until it passes. If you cannot get a meaningful test to pass, revert
     the test file, keep the fix, and explain why under a "Tests" heading in the PR body. Otherwise list
     the added test(s) under that heading.`

const fixPrompt = (issue, existingIssueUrl) => `Apply a minimal code fix for this high-confidence Crashlytics crash and open a PR.${existingIssueUrl ? `
This crash was already reported in GitHub issue ${existingIssueUrl}: your PR must close that issue,
not duplicate it.` : ''}

Issue ID: ${issue.issue_id}
Issue title: ${issue.issue_title}
Crash type: ${issue.crash_type}
Affected file: ${issue.affected_file}
Fix: ${issue.fix_description}
${evidenceLines(issue)}
Stack trace:
${issue.stack_trace}

Steps:
1. Check: git status --porcelain
   Branch name: fix/crashlytics-${issue.issue_id}  (append -2, -3 if it already exists).
2. Read ${issue.affected_file}, find the exact line from the stack trace, and apply the minimal fix:
${stack.fixRecipes}
${regressionTestStep(issue)}
3. Run: ${stack.analyze(vars)}
   If analysis fails: revert ${issue.affected_file} and any test file you touched, set
   action_taken="github_issue_filed", and file a GitHub issue with the analysis output in the body${existingIssueUrl ? ` (reference ${issueNumberRef(existingIssueUrl)})` : ''}.
4. If analysis passes, stage only the fixed source file and the test file(s) you added or changed
   (never git add -A or git add .), then commit and open a PR.
   Commit subject AND PR title (gh pr create --title): "fix(${issue.scope || 'app'}): ${issue.title_summary}"
   The commit body must end with the footer line: "Crashlytics: crashlytics/${issue.issue_id}"
   (used for deduplication; keep the issue ID out of the subject and PR title).
   ${prBaseBranch
     ? `PR target branch: "${prBaseBranch}": pass --base ${prBaseBranch} to gh pr create.`
     : `PR target branch: the repository default branch: omit --base.`}
   The PR body must include${existingIssueUrl ? `, on its own line, "Closes ${issueNumberRef(existingIssueUrl)}",` : ''} the line
   "Crashlytics issue: ${issue.issue_id}", every evidence line above, and the stack trace.

Follow the repository's own rules (CLAUDE.md, CONTRIBUTING) for commits and tooling. Use Conventional
Commits ("fix:"). Stage files individually.

Return action_taken ("pr_opened" or "github_issue_filed"), pr_url or github_issue_url, and reason.`

const noExistingHigh = highConf.filter(i => i.status !== 'issue_open')
const issueOpenHigh = highConf.filter(i => i.status === 'issue_open')
const noExistingLow = lowConf.filter(i => i.status !== 'issue_open')
const issueOpenLow = lowConf.filter(i => i.status === 'issue_open')
const keepId = issue => r => (r ? { ...issue, ...r, issue_id: issue.issue_id } : null)

let triageResults = []

if (classifiedIssues.length) {
  phase('Triage')

  triageResults = await parallel([
    // High confidence: apply the fix and open a PR (each in its own worktree and branch)
    ...[...noExistingHigh, ...issueOpenHigh].map(issue => () =>
      agent(fixPrompt(issue, issue.status === 'issue_open' ? issue.existing_issue_url : ''), {
        label: `fix:${issue.issue_id}`,
        phase: 'Triage',
        isolation: 'worktree',
        schema: TRIAGE_RESULT_SCHEMA,
      }).then(keepId(issue))
    ),

    // Low confidence, no existing work: file a GitHub issue
    ...noExistingLow.map(issue => () =>
      agent(
        `File a GitHub issue for this low-confidence Crashlytics crash that will not be auto-fixed.

1. Make sure the label exists: gh label create "${issueLabel}" --color D93F0B --description "Crash triaged by app-stability; needs a human" 2>/dev/null || true
2. gh issue create with:
     --title "Crashlytics (${issue.crash_type}): ${issue.title_summary || issue.issue_title}"
     --label "${issueLabel}"
   The body must include:
- Issue ID: ${issue.issue_id}
- Crash type: ${issue.crash_type}
- Confidence: ${issue.confidence}
- Affected file: ${issue.affected_file || '(not identified)'}
- Why not auto-fixed: ${issue.fix_description}
${evidenceLines(issue).split('\n').map(l => `- ${l}`).join('\n')}
${issue.data_unavailable ? '- Note: Crashlytics returned no sample event, so the stack trace may be incomplete.' : ''}
- Full stack trace:
${issue.stack_trace || '(unavailable)'}
   Pass the multiline body with a heredoc (--body-file -).

Return action_taken="github_issue_filed", github_issue_url from the command output, and reason.`,
        { label: `issue:${issue.issue_id}`, phase: 'Triage', schema: TRIAGE_RESULT_SCHEMA }
      ).then(keepId(issue))
    ),

    // Low confidence, existing open issue: comment instead of filing a duplicate
    ...issueOpenLow.map(issue => () =>
      agent(
        `This low-confidence Crashlytics crash is already reported in GitHub issue ${issue.existing_issue_url}.
Do NOT create a new issue: add a comment to the existing one.

Run: gh issue comment ${issueNumberRef(issue.existing_issue_url)} --body-file - (heredoc)

The comment says the crash was seen again (signals: ${(issue.signals || []).join(', ')}) and includes:
${evidenceLines(issue).split('\n').map(l => `- ${l}`).join('\n')}
- Crash type: ${issue.crash_type}

Return action_taken="comment_added", github_issue_url="${issue.existing_issue_url}", and reason.`,
        { label: `comment:${issue.issue_id}`, phase: 'Triage', schema: TRIAGE_RESULT_SCHEMA }
      ).then(keepId(issue))
    ),
  ])
}

// ── Phase: Annotate ────────────────────────────────────────────────────────
const allResults = [...triageResults.filter(Boolean), ...prOpenSkipped, ...alreadyFixedResults]
const toNote = allResults.filter(r => ['pr_opened', 'github_issue_filed', 'comment_added'].includes(r.action_taken))

let annotate = { noted: [], failed: [] }
if (toNote.length) {
  phase('Annotate')
  const lines = toNote
    .map(r => `- appId=${r.app_id} issueId=${r.issue_id} action=${r.action_taken} url=${r.pr_url || r.github_issue_url || ''}`)
    .join('\n')
  annotate =
    (await agent(
      `Add a Crashlytics note to each issue below with the Firebase MCP tool crashlytics_create_note
(load it with ToolSearch, query "crashlytics").

Get today's date with: date -u +%Y-%m-%d
Note body, exactly: "${NOTE_PREFIX} <action> <url> (<date>)"
These notes mark the issue as triaged so later runs skip it.

${lines}

Return noted (issue IDs that got a note) and failed (issue IDs whose note failed).`,
      { phase: 'Annotate', schema: ANNOTATE_SCHEMA }
    )) || { noted: [], failed: toNote.map(r => r.issue_id) }
  if (annotate.failed.length) log(`Could not add notes to ${annotate.failed.length} issue(s): they may be triaged again next run.`)
}

const prs = allResults.filter(r => r.action_taken === 'pr_opened')
const ghIssues = allResults.filter(r => r.action_taken === 'github_issue_filed')
const comments = allResults.filter(r => r.action_taken === 'comment_added')
const regressed = allResults.filter(r => r.regressed_after_pr)

log(`Done. ${prs.length} PR(s) opened, ${ghIssues.length} GitHub issue(s) filed, ${comments.length} comment(s) added, ${alreadyFixedResults.length} already fixed, ${prOpenSkipped.length} with an open PR, ${regressed.length} regressed after a merged PR.`)

return {
  dry_run: false,
  window_hours: hours,
  stack: stackKey,
  triaged: allResults.length,
  prs_opened: prs.map(r => ({ issue_id: r.issue_id, pr_url: r.pr_url })),
  github_issues_filed: ghIssues.map(r => ({ issue_id: r.issue_id, url: r.github_issue_url })),
  comments_added: comments.map(r => ({ issue_id: r.issue_id, url: r.github_issue_url })),
  already_fixed: alreadyFixedResults.map(r => ({ issue_id: r.issue_id, pr_url: r.existing_pr_url })),
  skipped_pr_open: prOpenSkipped.map(r => ({ issue_id: r.issue_id, pr_url: r.existing_pr_url })),
  regressed: regressed.map(r => ({ issue_id: r.issue_id, previous_pr: r.regressed_after_pr })),
  notes_failed: annotate.failed,
}

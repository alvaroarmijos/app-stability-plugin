# app-stability

A [Claude Code](https://claude.com/claude-code) plugin for app stability. It reads Firebase Crashlytics through the Firebase MCP server and gives you two tools:

| Command | What it does |
|---|---|
| `/app-stability:monitor` | Finds fresh, regressed and trending crashes and triages each one. Mechanical fixes become a PR with a regression test; everything else becomes a GitHub issue, or a comment on the existing one. |
| `/app-stability:release-report [version]` | Compares a release against the previous version and delivers an HTML or PDF report. Both include the first-7-days stability charts. The default short report is two plain pages: a verdict card per platform (first-week crash-free users, the change in words, the top crash to fix), then the daily charts only. The full report adds the same-week numbers, the method, the issue analysis, and gone and new issues. |

Auto-fixes are available for **Flutter** projects in this version. On any other stack the monitor still works: it files every crash as a GitHub issue and never edits code.

## Install

```text
/plugin marketplace add alvaroarmijos/app-stability-plugin
/plugin install app-stability@app-stability-plugin
```

Then restart Claude Code, so the plugin's MCP server starts.

### Prerequisites

- **Firebase CLI:** `npm install -g firebase-tools`, version 15 or newer, which includes `firebase mcp`. Then run `firebase login` with an account that can read the project's Crashlytics.
- **GitHub CLI:** run `gh auth login` with access to the repository. You need it for the monitor's PRs, issues and comments.
- **Firebase config files** in the repository (`google-services.json` and `GoogleService-Info*.plist`). The plugin maps package and bundle IDs to Firebase app IDs from them. Without them it falls back to `firebase_list_apps`.

To check the setup, `claude mcp list` should show the plugin's `firebase` server as connected.

The Firebase login expires from time to time. When it does, the monitor and the report stop and tell you to run `firebase login --reauth` and restart Claude Code.

## Monitor

```text
/app-stability:monitor --dry-run --hours 168 com.example.app com.example.ios
/app-stability:monitor --base develop com.example.app com.example.ios
```

| Argument | Default | |
|---|---|---|
| `--base <branch>` | repository default branch | Target branch for fix PRs |
| `--hours <n>` | `24` | Look-back window, up to 90 days |
| `--label <name>` | `needs-human-review` | Label for filed issues, created if missing |
| `--trend-factor <n>` | `3` | How many times its usual hourly rate a version's events must reach to count as trending |
| `--trend-min-events <n>` | `10` | Minimum events on one version in the window to count as trending |
| `--no-trending` | off | Only look for fresh and regressed issues |
| `--dry-run` | off | Plan only: nothing is written to GitHub or Firebase |
| `<package-id>...` | every app in the config files | Android package names or iOS bundle IDs |

How it works:

1. **Discover.** It detects the stack and resolves the app IDs. Then it lists the issues Crashlytics flags as **fresh** or **regressed** in the window, counting fatal, non-fatal and ANR events. It also finds **trending** issues: old issues whose events spike on one app version (see below). It skips issues an earlier run already noted.
2. **Check existing.** It searches GitHub issues, PRs and commits for the Crashlytics issue ID.
   - An issue fixed by a merged PR is skipped, unless it regressed after that PR.
   - An issue with an open PR is skipped.
3. **Extract.** It takes the stack trace of the latest event and the affected versions from Crashlytics.
4. **Classify.** It decides the crash type and whether the fix is mechanical and safe. Auth, payments and core data sync never count as safe.
5. **Triage.** Each issue gets one of three outcomes:
   - **A high-confidence crash** gets a minimal fix plus a regression test, in its own worktree. It is analyzed and opened as a PR whose commit carries a `Crashlytics: crashlytics/<id>` footer.
   - **A low-confidence crash** becomes a GitHub issue.
   - **A crash that already has an open GitHub issue** gets a comment on that issue instead.
6. **Annotate.** It adds an `app-stability: <action> <url>` note to each triaged Crashlytics issue, so the next run doesn't repeat the work.

### Run it on a schedule

We recommend a **local** [Claude Code Desktop scheduled task](https://code.claude.com/docs/en/desktop-scheduled-tasks), run daily in the repository, for example `/app-stability:monitor --base develop com.example.app`. The 24-hour default matches a daily run.

A local task runs on your machine with your own Claude Code session, `firebase login` and `gh auth login`. That means:
- no cloud environment to pay for or maintain;
- no separate API key;
- no service-account credentials to store.

A [cloud scheduled task](https://code.claude.com/docs/en/routines) works too, but you would have to install the Firebase CLI and provide its credentials in that environment.

### Trade-offs

- **Trending is computed, not read.** Crashlytics's API has no "trending" signal: its trending email works it out itself. The monitor does the same, per app version. It takes the issues with at least `--trend-min-events` events in the window and compares each version's hourly event rate with its rate over the previous 7 days. A version at `--trend-factor` times its usual rate or more makes the issue trending. Comparing per version catches a spike on one old version that the issue's total would hide. The result won't match Firebase's email exactly.
- **The window decides what it sees.** Daily runs with the 24-hour default cover the timeline with no gaps. A spike is missed only when a run is skipped, for example because the machine was asleep. Then run once by hand with `--hours 48`. A small overlap such as `--hours 30` also catches events that reach Crashlytics late. Overlap creates no duplicates, because the notes stop an issue from being triaged twice. Don't make a wide window the default: a longer window dilutes a one-day spike in the trending check.
- **The notes live in Crashlytics.** If you delete an `app-stability:` note, the issue is triaged again on the next run.

## Release report

```text
/app-stability:release-report
/app-stability:release-report 5.21.7
/app-stability:release-report 5.21.7 --detail full --format pdf
```

| Argument | Default | |
|---|---|---|
| `[version]` | the latest version with Crashlytics data | The release to judge, e.g. `5.21.7` |
| `--detail short\|full` | `short` | A two-page report anyone can read at a glance, or the complete report |
| `--format html\|pdf` | `html` | Deliver a self-contained HTML report or a PDF. PDF needs Playwright's Chromium, or falls back to an installed Chrome or Chromium run headless |
| `<package-id>...` | every app in the config files | Android package names or iOS bundle IDs |

It finds each platform's build and the previous version, then compares them over the same week. It never tilts the verdict toward good news.

| | Short (default) | Full |
|---|---|---|
| Verdict in plain words | ✓ | ✓ |
| First-week crash-free users per platform, previous value, change | ✓ (cards) | ✓ |
| Same-week crash-free users and sessions, active users | | ✓ |
| Top crash to fix | top 1 per platform | top 8, previous vs target, with concentration |
| Main caveat and re-check date | one line | ✓ |
| First-7-days stability charts | ✓ (charts only) | ✓ (with data table and notes) |
| Method page, gone and new issues, conclusions | | ✓ |
| Length | 2 pages | about 9 pages |

- **Output:** `<app>-release-<target>-vs-<previous>/` (or `…-full/`), with the report in the chosen format.
- **Style:** always the same plain, neutral style, with no dependency on other skills or plugins.

Crash-free figures use fatal events only, which matches the Firebase console.

## Adding a stack

Everything language-specific lives in the `STACKS` object at the top of [`workflows/monitor.js`](plugins/app-stability/workflows/monitor.js). Each entry holds:
- the detect rule;
- the source, SDK and wrapper frames;
- the frame-to-path mapping;
- the fix recipes;
- the analyze and test commands;
- the test conventions.

To support Kotlin, Swift or React Native, add an entry and a test case.

## Development

```bash
node plugins/app-stability/tests/simulate.mjs
```

It runs the monitor workflow against stub agents and checks the triage paths, the dry run, deduplication, unsupported stacks and the MCP-unavailable exit. To try local changes, run `/plugin marketplace add /path/to/app-stability-plugin`.

## License

[MIT](LICENSE). Firebase and Crashlytics are trademarks of Google LLC. This project is not affiliated with or endorsed by Google.

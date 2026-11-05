# app-stability

A [Claude Code](https://claude.com/claude-code) plugin for app stability. It reads Firebase Crashlytics through the Firebase MCP server and gives you two tools:

| Command | What it does |
|---|---|
| `/app-stability:monitor` | Finds fresh and regressed crashes and triages each one. Mechanical fixes become a PR with a regression test; everything else becomes a GitHub issue, or a comment on the existing one. |
| `/app-stability:release-report <version>` | Compares a release against the previous version and delivers an HTML or PDF report. Both include a first-7-days stability chart. The default short report opens with the chart, then gives the verdict, crash-free users and sessions, and the top issues. The full report adds the method, the issue analysis, and gone and new issues. |

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
| `--dry-run` | off | Plan only: nothing is written to GitHub or Firebase |
| `<package-id>...` | every app in the config files | Android package names or iOS bundle IDs |

How it works:

1. **Discover.** It detects the stack and resolves the app IDs. Then it lists the issues Crashlytics flags as **fresh** or **regressed** in the window, counting fatal, non-fatal and ANR events. It skips issues an earlier run already noted.
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

Use a [Claude Code Desktop scheduled task](https://code.claude.com/docs/en/desktop-scheduled-tasks) to run it daily in the repository, for example `/app-stability:monitor --base develop com.example.app`. The 24-hour default matches a daily run. A desktop task runs on your machine, so it reuses your `firebase login` and `gh auth login`. A [cloud scheduled task](https://code.claude.com/docs/en/routines) would need the Firebase CLI and its credentials set up in that environment.

### Trade-offs

- **The signals decide what it sees.** Only issues Crashlytics flags as fresh or regressed are triaged. Old issues that are simply growing are not. Widen the window with `--hours` to catch more.
- **The notes live in Crashlytics.** If you delete an `app-stability:` note, the issue is triaged again on the next run.

## Release report

```text
/app-stability:release-report 5.21.7
/app-stability:release-report 5.21.7 --detail full --format pdf
```

| Argument | Default | |
|---|---|---|
| `<version>` | required | The release to judge, e.g. `5.21.7` |
| `--detail short\|full` | `short` | A two-page report with only what's needed to judge stability, or the complete report |
| `--format html\|pdf` | `html` | Deliver a self-contained HTML report or a PDF. PDF needs Playwright with Chromium |
| `<package-id>...` | every app in the config files | Android package names or iOS bundle IDs |

It finds each platform's build and the previous version, then compares them over the same week. It never tilts the verdict toward good news.

| | Short (default) | Full |
|---|---|---|
| Verdict with its number | ✓ | ✓ |
| Same-week crash-free users and sessions, active users, change | ✓ | ✓ |
| Target's top issues and crash concentration | top 3 | top 8, previous vs target |
| Caveats and re-check date | ✓ | ✓ |
| First-7-days stability chart, with its data table | ✓ | ✓ |
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

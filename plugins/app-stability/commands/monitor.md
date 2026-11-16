---
description: Triage fresh, regressed and trending Crashlytics issues into fix PRs or GitHub issues
argument-hint: "[--base <branch>] [--hours <n>] [--label <name>] [--trend-factor <n>] [--trend-min-events <n>] [--no-trending] [--dry-run] [package-id ...]"
---

Run the app-stability monitor workflow. This command authorizes the Workflow tool.

Split `$ARGUMENTS` on spaces into an array and pass it as `args` (pass no `args` when `$ARGUMENTS` is empty).
Call it by name; if the Workflow tool does not know the name, pass `scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/monitor.js"` instead:

```
Workflow({
  name: "app-stability:monitor",
  args: ["--base", "develop", "com.example.app"]
})
```

Arguments:

- `--base <branch>`: target branch for the PRs it opens. Default: the repository default branch.
- `--hours <n>`: look-back window for fresh, regressed and trending issues. Default 24, max 2160 (90 days).
- `--label <name>`: label for the GitHub issues it files. Default `needs-human-review`; created if missing.
- `--trend-factor <n>`: a version's hourly event rate must reach n times its rate over the previous 7 days for the issue to count as trending. Default 3.
- `--trend-min-events <n>`: minimum events on one version in the window for the issue to count as trending. Default 10.
- `--no-trending`: only look for fresh and regressed issues.
- `--dry-run`: stop after classifying and return the planned action per issue. Nothing is written to GitHub or Firebase.
- `<package-id>...`: Android package names or iOS bundle IDs to monitor. Default: every app in the repository's Firebase config files.

When the workflow finishes, summarize its result for the user: PRs opened, issues filed, comments added, issues skipped and why, any issue that regressed after a merged fix, and each trending issue with its `trend_detail` (the version that spiked and its event counts). If it returns `mcp_unavailable`, lead with its `message` word for word, including the command to run (for example `firebase login --reauth` when `firebase_auth` is `reauth_required`), then say that nothing was triaged or created. Don't replace it with a generic install-and-login hint.

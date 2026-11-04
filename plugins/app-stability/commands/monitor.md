---
description: Triage fresh and regressed Crashlytics issues into fix PRs or GitHub issues
argument-hint: "[--base <branch>] [--hours <n>] [--label <name>] [--dry-run] [package-id ...]"
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
- `--hours <n>`: look-back window for fresh and regressed issues. Default 24, max 2160 (90 days).
- `--label <name>`: label for the GitHub issues it files. Default `needs-human-review`; created if missing.
- `--dry-run`: stop after classifying and return the planned action per issue. Nothing is written to GitHub or Firebase.
- `<package-id>...`: Android package names or iOS bundle IDs to monitor. Default: every app in the repository's Firebase config files.

When the workflow finishes, summarize its result for the user: PRs opened, issues filed, comments added, issues skipped and why, and any issue that regressed after a merged fix. If it returns `mcp_unavailable`, show its message: the Firebase CLI must be installed and logged in, and Claude Code restarted.

# Changelog

## 0.2.0

- `/app-stability:release-report` takes `--detail short|full`. The new default, `short`, is a one-page report: the verdict, the same-week crash-free numbers, the target's top 3 issues and the caveats. It needs far fewer Crashlytics calls, because it pulls the daily series only when the same-week comparison isn't meaningful. `full` is the previous complete report.

## 0.1.0

- `/app-stability:monitor` workflow: fresh and regressed Crashlytics issues → fix PRs (Flutter) or GitHub issues, deduplicated against GitHub and Crashlytics notes, with `--dry-run`, `--hours`, `--base` and `--label`.
- `/app-stability:release-report` skill: release vs previous version stability report as HTML or PDF (`--format`), from the Firebase MCP, with no dependency on other plugins.
- Bundled Firebase MCP server limited to the tools the plugin uses.

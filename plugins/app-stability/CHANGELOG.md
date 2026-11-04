# Changelog

## 0.1.0

- `/app-stability:monitor` workflow: fresh and regressed Crashlytics issues → fix PRs (Flutter) or GitHub issues, deduplicated against GitHub and Crashlytics notes, with `--dry-run`, `--hours`, `--base` and `--label`.
- `/app-stability:release-report` skill: release vs previous version stability report as HTML or PDF (`--format`), from the Firebase MCP, with no dependency on other plugins.
- Bundled Firebase MCP server limited to the tools the plugin uses.

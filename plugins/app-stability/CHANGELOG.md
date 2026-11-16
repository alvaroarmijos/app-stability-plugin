# Changelog

## 0.5.0

- `/app-stability:monitor` now also finds trending issues: old issues whose events spike on one app version, like the ones in Firebase's "Trending stability issues" email. Crashlytics's API has no trending signal, so the monitor compares each version's event rate in the window with its rate over the previous 7 days. Tune it with `--trend-factor` (default 3) and `--trend-min-events` (default 10), or turn it off with `--no-trending`. Trending issues are triaged like the rest and returned as `trending`, with the version that spiked.

## 0.4.1

- When the Firebase tools are missing or fail, `/app-stability:monitor` and `/app-stability:release-report` now check the Firebase CLI and say exactly what to do: `firebase login --reauth` when the login expired, `firebase login` when not logged in, installing the CLI when it's missing, or just restarting Claude Code when the login works. The monitor returns the reason as `firebase_auth`.

## 0.4.0

- `/app-stability:release-report` no longer needs a version. Without one, it judges the latest version with Crashlytics data, and says which version it chose.

## 0.3.0

- `/app-stability:release-report` always includes the first-7-days stability chart, in both the short and the full report: a line per version, the daily table with its average, and notes on small samples, gaps and outside events. The short report is now two pages: the chart first, then the data.
- New `scripts/daily-series.mjs` pulls the daily series in one Firebase MCP session, with retries, and marks gaps and failed days, so a failed call never ends up in the chart.
- Day 1 is the first day of an unbroken run of reported days; the crash-free denominator is the FATAL report's user count.

## 0.2.0

- `/app-stability:release-report` takes `--detail short|full`. The new default, `short`, is a one-page report: the verdict, the same-week crash-free numbers, the target's top 3 issues and the caveats. It needs far fewer Crashlytics calls, because it pulls the daily series only when the same-week comparison isn't meaningful. `full` is the previous complete report.

## 0.1.0

- `/app-stability:monitor` workflow: fresh and regressed Crashlytics issues → fix PRs (Flutter) or GitHub issues, deduplicated against GitHub and Crashlytics notes, with `--dry-run`, `--hours`, `--base` and `--label`.
- `/app-stability:release-report` skill: release vs previous version stability report as HTML or PDF (`--format`), from the Firebase MCP, with no dependency on other plugins.
- Bundled Firebase MCP server limited to the tools the plugin uses.

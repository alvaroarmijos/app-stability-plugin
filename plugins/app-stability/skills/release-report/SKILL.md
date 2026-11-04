---
name: release-report
description: Compare a mobile app release against the previous version in Firebase Crashlytics and deliver a short stability report as HTML or PDF. Use when the user names a version to judge ("compare 5.21.7", "is the new release more stable?") or asks how a release is doing in Crashlytics.
argument-hint: "<version> [--format html|pdf] [package-id ...]"
---

# Release stability report

The user names the release to judge, for example `5.21.7`. Pull crash data for that release and for the version shipped right before it, on every platform the app has, and deliver a short report that answers one question: **did this release make the app more or less stable?**

The answer can be "no". A release that got worse is a useful finding. Report what the data shows and never bend the headline toward good news.

All data comes from the Firebase MCP server bundled with this plugin. Its tools are named `crashlytics_*` and `firebase_*`; load them with ToolSearch (query `crashlytics`). Never open the Firebase console in a browser.

## Inputs

1. **Target version**: a marketing version such as `5.21.7`. Build numbers differ per platform; you find them yourself.
2. **Format** (optional): `--format html` or `--format pdf`. The default is `html`. Accept the same choice in plain words too ("as a PDF").
3. **Apps** (optional): Android package names or iOS bundle IDs. Without them, use every app in the repository's Firebase config files.
4. **Exclusions** (optional): crashes the user says are external and already fixed, such as an SDK bug. Exclude them only when the user says so, and link the upstream issue.

If the version is missing, ask for it once. For everything else, pick sensible defaults and state them in the report.

If the tools are missing or a call fails with an authentication error, stop and tell the user to install the Firebase CLI (`npm i -g firebase-tools`), run `firebase login`, and restart Claude Code.

## Step 1: Resolve the apps

Find the Firebase config files, ignoring `build/`, `Pods/`, `node_modules/` and `.claude/`:

```bash
find . -name google-services.json -o -name 'GoogleService-Info*.plist'
```

- **Android:** in `google-services.json`, the client whose `package_name` matches has `mobilesdk_app_id`.
- **iOS:** in the plist whose `BUNDLE_ID` matches, `GOOGLE_APP_ID`.
- **Several flavors:** when several files match, prefer a path containing `prod`, `production` or `release`.
- **Fallback:** if nothing is found, call `firebase_list_apps`.

The app ID decides the project, so the repository's default Firebase project doesn't matter.

## Step 2: Pull the numbers

Get timestamps with `date -u +%Y-%m-%dT%H:%M:%SZ` (and `date -u -v-<n>d …`, or `date -u -d "<n> days ago" …` on Linux). Every call takes `appId` and a `filter` with `intervalStartTime` and `intervalEndTime`. Crashlytics keeps 90 days: if the target is older than that, say so and stop.

### Find builds and the previous version

Call `crashlytics_get_top_versions` over the last 30 days (90 if needed), `pageSize` 50. It returns one group per `version.displayName`, such as `5.21.7 (5547)`.
- **Target build:** the target's display name gives the build number.
- **Previous version:** the highest version below the target that has events. It's often the same marketing version on every platform, with different builds.
- **Several builds:** if the target has two or more, compare the latest one and mention the others.
- **Newer releases:** check that no version above the target has events. A newer hotfix changes the question.

### Know how the metrics behave

Each group's `metrics[0]` holds these fields:
- `eventsCount` and `impactedUsersCount`;
- `sessionsCount` and `impactedSessionsCount`;
- `totalUsersCount` and `totalSessionsCount`;
- `crashFreeUsersPercentage` and `crashFreeSessionsPercentage`.

How to read them:
- **The error-type filter changes the crash-free numbers.**
  - With `issueErrorTypes: ["FATAL"]` they match the console's crash-free users and sessions. Use this for every crash-free figure.
  - Without the filter, non-fatal errors count too, and the numbers are much lower.
  - In Flutter apps, uncaught errors reported as fatal count as crashes. Explain this in the method section.
- **Totals and percentages can be missing.** `totalUsersCount` and `totalSessionsCount` come only from SDK versions that support crash-free metrics. When the percentages are missing, write "—". Never compute them from other fields.
- **A version with no fatal events doesn't appear in the FATAL-filtered report.**
  - Get its totals from the unfiltered call for the same window.
  - Then report it as 100% crash-free with 0 crashes, and say how many users that's based on.
- **`get_top_versions` can't filter by version.** Its `versionDisplayNames` filter returns HTTP 400. Call it once per window and pick the groups you need.
- **`get_top_issues` accepts `versionDisplayNames`.** Use it for each version's issue list.

### What to collect, per platform

| Pull | Call | Why |
|---|---|---|
| Same week, both versions | `get_top_versions`, last 7 days, FATAL, and again unfiltered | The headline: both versions face the same backend and the same days |
| Daily crash-free users, first 7 reported days of each version | `get_top_versions`, FATAL, one call per day (1-day windows) | Supporting evidence: each version at the same age |
| Issues per version | `get_top_issues` with `versionDisplayNames: [<display name>]`, FATAL, 30 days, `pageSize` 20 | Concentration, plus gone and new issues |

The first reported day is the first day a version has events: that's its effective release date. Days with no data are gaps, not zeros. List the dates so the gaps are visible.

If the previous version has almost no users left in the same week, the same-week comparison means little. That shows up as a tiny `totalUsersCount`, or 100% with zero crashes. Say so and lean on the first-7-days view for that platform. Users who stay on an old version may also be a different population.

When a daily dip shows up on the same day in both versions' series, it's an outside event (backend, data or SDK), not something the release caused. Name it as such.

## Step 3: Analyze

Work the numbers in a small script; don't do the math by eye.

- **Change in points** for rates ("−9.6 pts"), and percent change for counts ("−81%").
- **Share of users hit, per issue:** the issue's impacted users divided by the version's `totalUsersCount`. It shows whether an old issue grew or shrank; raw counts mislead when adoption differs.
- **Concentration:** what share of the target's crashes come from its top three issues, and from the top one alone. This is usually the most actionable number. If one of them is a single user crashing many times, say so, and rank the fixes by users hit.
- **Gone issues:** in the previous version but not in the target. **New issues:** in the target only, or first seen in the target version. With only a few days of data, "gone" can still mean "not seen yet".
- **Exclusions:** recompute crash-free users without the excluded issue by subtracting its users from the crashed users. Apply the same exclusion to both versions.
- **First-week averages** of the daily series for each version, computed from the raw series. Use the same rounded value everywhere.

Carry these caveats into the report:
- **Small samples**, for example a few hundred users per version.
- **Early adopters** of a new build tend to use the app more, which can inflate its crash rate.
- **Young releases:** a release younger than two weeks deserves a re-check. Put the re-check date on the conclusions.
- **Don't overclaim.** For example, don't say that two platforms' crashes share a cause because they share a frame.
- **Check every headline against the data.** "Every issue shrank" is wrong if one row grew.
- **Benchmark:** healthy apps reach at least 99% crash-free users and 99.95% crash-free sessions ([Luciq benchmarks](https://www.luciq.ai/blog/benchmarking-crash-free-sessions-for-mobile-apps-whats-a-good-crash-free-rate)). Mention it when the gap to it is the story.

## Step 4: Plan the report

Write the plan as Markdown before any HTML: one section per page, each headline a finding with its number, not a topic label. Write it in English unless the user asks otherwise. Default outline:

1. **Cover:** "Release X vs Y" and the date.
2. **The answer:**
   - a one-line verdict and a short paragraph;
   - four big numbers: the target's crash-free users per platform with the change, the first-week number of the platform that moved most, and the concentration number.
3. **Method:**
   - the builds and the two windows;
   - the samples (`totalUsersCount`);
   - the fatal-only definition and any exclusions.
4. **Same week:** a table with crash-free users, crash-free sessions, crashes, users with a crash and active users. It has a column per platform and version, and a Change column per platform.
5. **First 7 days:** a line chart of daily crash-free users for the platform that moved most, plus both first-week averages and the gap.
6. **Issues:** the share of users hit, previous vs target, for the target's top issues (at most eight).
7. **Gone vs new issues**, with the "gone can mean not seen yet" caveat.
8. **Conclusions:** one line per platform, the fixes ranked by users hit, and the re-check date.
9. **Closing:** questions, the next check date and the owner.

Drop sections with nothing to say. If there is one platform, merge into a single-platform view. Every number must appear in a table, a chart or a footnote with its source.

## Step 5: Build

This skill has no dependency on other skills or plugins: always build the report with the style below, whatever else is installed.

Write one self-contained `index.html`, with no external fonts, scripts or stylesheets:
- One `<section>` per page, at 1920 × 1080.
- A neutral palette: near-black text on white, and one accent color for the target version.
- A system sans-serif for text and a monospace font for numbers.
- Arrow-key navigation, and a print stylesheet that puts one section per page (`@page { size: 1920px 1080px; margin: 0 }`).
- Draw the chart as inline SVG from the data, with alt text and a data table.

Style rules:
- The target version is the accent and the previous version is neutral.
- Don't use red or green for "worse" or "better": put the change in text instead.
- Numbers are tabular, and right-aligned in tables.
- Write "—" for missing values, never a blank cell.
- Take the owner's name from `git config user.name`.

Generate `index.html` from a small script that holds the numbers, so each value is fixed in one place.

**Check:** if headless Chromium (Playwright) is available, open `index.html` at 1920 × 1080 and screenshot each section. Fix overflow and colliding labels.

**PDF format only:** print `index.html` to `<app>-release-<target>-vs-<previous>.pdf` with headless Chromium, using `print_background=True` and `prefer_css_page_size=True`. The page count must equal the section count. The HTML is only the source of the PDF here. If Playwright isn't available, say so, offer the HTML instead, and don't claim a PDF exists.

## Step 6: Deliver

Name the folder `<app>-release-<target>-vs-<previous>/`. It holds:
- **the report:** `index.html` for the HTML format, or the PDF for the PDF format (keep `index.html` next to it as its source);
- the plan `.md` from Step 4;
- the script that generated the report, with its data.

Give the user the path of the file in the format they asked for.

In the chat:
- lead with the verdict in one sentence;
- then give a small table of the key numbers, the biggest driver and the main caveat;
- keep it short, since the report carries the detail.

---
name: release-report
description: Compare a mobile app release against the previous version in Firebase Crashlytics and deliver a stability report as HTML or PDF, either short (the verdict, the numbers behind it and the stability chart; the default) or full (adds the method, the issue analysis, and gone and new issues). Use when the user names a version to judge ("compare 5.21.7", "is the new release more stable?") or asks how a release is doing in Crashlytics.
argument-hint: "<version> [--detail short|full] [--format html|pdf] [package-id ...]"
---

# Release stability report

The user names the release to judge, for example `5.21.7`. Pull crash data for that release and for the version shipped right before it, on every platform the app has, and deliver a report that answers one question: **did this release make the app more or less stable?**

The answer can be "no". A release that got worse is a useful finding. Report what the data shows and never bend the headline toward good news.

All data comes from the Firebase MCP server bundled with this plugin. Its tools are named `crashlytics_*` and `firebase_*`; load them with ToolSearch (query `crashlytics`). Never open the Firebase console in a browser.

## Inputs

1. **Target version**: a marketing version such as `5.21.7`. Build numbers differ per platform; you find them yourself.
2. **Detail** (optional): `--detail short` or `--detail full`. The default is `short`.
   - **short:** two pages with only what's needed to judge stability. Page 1 has the verdict, the crash-free numbers behind it, what drives the crashes, and the caveats. Page 2 has the stability chart.
   - **full:** the complete report: the method, the same-week table, the stability chart, the issue analysis, gone and new issues, and the conclusions.

   Both reports always include the stability chart (see "The stability chart" in Step 5).

   Accept plain words too: "full", "complete" or "detailed" mean full; "short", "summary" or "brief" mean short.
3. **Format** (optional): `--format html` or `--format pdf`. The default is `html`. Accept the same choice in plain words too ("as a PDF").
4. **Apps** (optional): Android package names or iOS bundle IDs. Without them, use every app in the repository's Firebase config files.
5. **Exclusions** (optional): crashes the user says are external and already fixed, such as an SDK bug. Exclude them only when the user says so, and link the upstream issue.

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
  - In Flutter apps, uncaught errors reported as fatal count as crashes. Explain this in the method section (full) or the footer (short).
- **Totals and percentages can be missing.** `totalUsersCount` and `totalSessionsCount` come only from SDK versions that support crash-free metrics. When the percentages are missing, write "—". Never compute them from other fields.
- **A version with no fatal events doesn't appear in the FATAL-filtered report.**
  - Get its totals from the unfiltered call for the same window.
  - Then report it as 100% crash-free with 0 crashes, and say how many users that's based on.
- **`get_top_versions` can't filter by version.** Its `versionDisplayNames` filter returns HTTP 400. Call it once per window and pick the groups you need.
- **`get_top_issues` accepts `versionDisplayNames`.** Use it for each version's issue list.

### What to collect, per platform

| Pull | Call | Why | Short | Full |
|---|---|---|---|---|
| Same week, both versions | `get_top_versions`, last 7 days, FATAL, and again unfiltered | The headline: both versions face the same backend and the same days | yes | yes |
| Top issues of the target | `get_top_issues` with `versionDisplayNames: [<target display name>]`, FATAL, 30 days, `pageSize` 5 (short) or 20 (full) | Concentration: what drives the crashes | yes | yes |
| Issues of the previous version | the same call for the previous display name, `pageSize` 20 | Share per issue over time, plus gone and new issues | no | yes |
| Daily crash-free users, first 7 reported days of each version | `scripts/daily-series.mjs` (below) | The stability chart: each version at the same age | yes | yes |

### Pull the daily series

The daily series takes two calls per day and version, which is too many to make one at a time. Run the bundled script instead. It talks to the same Firebase MCP server in one session, retries rate-limited calls, and marks each day `ok`, `no_fatal` (users but no fatal events, so 100%), `no_data` (a gap) or `failed`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/release-report/scripts/daily-series.mjs" \
  --app <app id> --from <YYYY-MM-DD> --to <YYYY-MM-DD> \
  --version "<target display name>" --version "<previous display name>" --out <platform>-daily.json
```

1. **Find each version's release date first.**
   - Call `get_top_versions` unfiltered with 7-day windows, going back from today, at most 90 days.
   - Stop at the first window where the version has no users.
   - Then run the script over that week and the 7 days after it.
2. **Day 1 is the first day of an unbroken run of reported days.**
   - An isolated earlier day followed by gaps, such as testers or a paused rollout, is not Day 1. List it in the notes, but don't count it.
   - After Day 1, days with no data are gaps, not zeros. Skip them, take the next reported day, and show the dates so the gaps are visible.
3. **Never use a `failed` row.** Re-run the script for those days. If they still fail, say which days are missing.
4. **Crash-free users is `cfu`.** Its denominator is the FATAL report's `totalUsersCount` for that day, which the script stores as `users`. The unfiltered report's user count is different, so don't mix the two.

If the previous version has almost no users left in the same week, the same-week comparison means little. That shows up as a tiny `totalUsersCount`, or 100% with zero crashes. Say so and lean on the first-7-days view for that platform. Users who stay on an old version may also be a different population.

When a daily dip shows up on the same day in both versions' series, it's an outside event (backend, data or SDK), not something the release caused. Name it as such.

## Step 3: Analyze

Work the numbers in a small script; don't do the math by eye.

Both reports:
- **Change in points** for rates ("−9.6 pts"), and percent change for counts ("−81%").
- **Concentration:** what share of the target's crashes come from its top three issues, and from the top one alone. This is usually the most actionable number. If one of them is a single user crashing many times, say so, and rank the fixes by users hit.
- **Share of users hit** for the target's top issues: the issue's impacted users divided by the target's `totalUsersCount`.
- **Exclusions:** recompute crash-free users without the excluded issue by subtracting its users from the crashed users. Apply the same exclusion to both versions.

- **First-week averages** of the daily series for each version, computed from the raw series. Use the same rounded value everywhere.
- **The gap** between the two averages, in points, per platform.

Full report only:
- **Share of users hit, previous vs target, per issue.** It shows whether an old issue grew or shrank; raw counts mislead when adoption differs.
- **Gone and new issues.** Gone issues are in the previous version but not in the target. New issues are in the target only, or first seen in the target version. With only a few days of data, "gone" can still mean "not seen yet".

Carry these caveats into the report:
- **Small samples**, for example a few hundred users per version.
- **Early adopters** of a new build tend to use the app more, which can inflate its crash rate.
- **Young releases:** a release younger than two weeks deserves a re-check. Put the re-check date on the conclusions.
- **Don't overclaim.** For example, don't say that two platforms' crashes share a cause because they share a frame.
- **Check every headline against the data.** "Every issue shrank" is wrong if one row grew.
- **Benchmark:** healthy apps reach at least 99% crash-free users and 99.95% crash-free sessions ([Luciq benchmarks](https://www.luciq.ai/blog/benchmarking-crash-free-sessions-for-mobile-apps-whats-a-good-crash-free-rate)). Mention it when the gap to it is the story.

## Step 4: Plan the report

Write the plan as Markdown before any HTML: one section per page, each headline a finding with its number, not a topic label. Write it in English unless the user asks otherwise.

### Short report

Two pages. Page 1 covers sections 1–5, in this order; page 2 is the stability chart.

1. **Verdict:** a one-sentence headline with its number, for example "5.21.7 is more stable on Android (+4.1 pts), unchanged on iOS".
2. **KPI table:** one column per platform and version, plus a Change column per platform. Rows: crash-free users over the first 7 days (the average), then same-week crash-free users, crash-free sessions and active users (`totalUsersCount`).
3. **What drives the crashes:** the target's top 3 issues by users hit, each with its title, users and share of users. Then the concentration in one line.
4. **Caveats and next check:** at most 3 bullets, using only the ones that apply.
   - The sample is small.
   - The release is young: give the re-check date.
   - The same-week comparison isn't meaningful: say the verdict rests on the first-7-days averages.
   - Crashes were excluded.
5. **Footer:** builds, windows, "crash-free = fatal events only", the source and the date.
6. **Page 2, first 7 days:** the stability chart.

### Full report

1. **Cover:** "Release X vs Y" and the date.
2. **The answer:**
   - a one-line verdict and a short paragraph;
   - four big numbers: the target's crash-free users per platform with the change, the first-week number of the platform that moved most, and the concentration number.
3. **Method:**
   - the builds and the two windows;
   - the samples (`totalUsersCount`);
   - the fatal-only definition and any exclusions.
4. **Same week:** a table with crash-free users, crash-free sessions, crashes, users with a crash and active users. It has a column per platform and version, and a Change column per platform.
5. **First 7 days:** the stability chart.
6. **Issues:** the share of users hit, previous vs target, for the target's top issues (at most eight).
7. **Gone vs new issues**, with the "gone can mean not seen yet" caveat.
8. **Conclusions:** one line per platform, the fixes ranked by users hit, and the re-check date.
9. **Closing:** questions, the next check date and the owner.

In both reports, drop sections with nothing to say. If there is one platform, merge into a single-platform view. Every number must appear in a table, a chart or a footnote with its source.

## Step 5: Build

This skill has no dependency on other skills or plugins: always build the report with the style below, whatever else is installed.

Write one self-contained `index.html`, with no external fonts, scripts or stylesheets:
- One `<section>` per page, at 1920 × 1080.
- A neutral palette: near-black text on white, and one accent color for the target version.
- A system sans-serif for text and a monospace font for numbers.
- A print stylesheet that puts one section per page (`@page { size: 1920px 1080px; margin: 0 }`). Add arrow-key navigation when there is more than one page.
- Draw the chart as inline SVG from the data, with alt text.

Both reports use the same style, and the same chart page.

### The stability chart

It's one page, in both reports, for the platform whose first-week gap is largest. Lay it out like this:

- **Eyebrow:** the section number and "First 7 days".
- **Headline:** the finding with both numbers, for example "At the same age, Android 5.21.7 averaged 97.6% crash-free users, vs 71.0% for 5.21.6."
- **Left, about two thirds of the width:** a line chart of daily crash-free users.
  - **X axis:** `Day 1` … `Day 7`, using each version's own first 7 reported days.
  - **Y axis:** percentages, with gridlines every 10 points.
    - Start the axis at a round 10 below the lowest value, or at 50% if that's lower. The axis may start above zero because these are rates, not counts.
    - End it at 100%.
  - **One line per version,** with a dot on each day and the version name as a label at the end of the line, not in a legend.
    - The target is the accent color and drawn thicker. The previous version is neutral gray.
- **Right, about one third:** the data table.
  - Columns: Day, then the date and crash-free users for the previous version, then the date and crash-free users for the target.
  - Show dates as `MM-DD`.
  - The last row is **Average**, in bold.
  - The target's values are in the accent color.
- **Under the table:** two short notes.
  - **The other platform:** its first-week averages and gap, in one line, for example "iOS first-week averages: 5.21.6 94.9%, 5.21.7 98.7% (+3.8 pts)".
  - **What to read with care:** small Day 1 samples, with their user counts. Days without data. A dip that hit other versions on the same day, named as an outside event; check it with `get_top_versions` for that day. Or, when the two series cover different dates, say that a dip can't be checked against the other version, and name the low day.
- **Alt text:** put a one-sentence description of the trend in the SVG's `<title>` and `aria-label`.

If the platforms moved by similar amounts, within 2 points, chart both platforms side by side on the same page with smaller tables. If there is only one platform, chart that one.

Style rules:
- The target version is the accent and the previous version is neutral.
- Don't use red or green for "worse" or "better": put the change in text instead.
- Numbers are tabular, and right-aligned in tables.
- Write "—" for missing values, never a blank cell.
- Take the owner's name from `git config user.name`.

Generate `index.html` from a small script that holds the numbers, so each value is fixed in one place.

**Check:** if headless Chromium (Playwright) is available, open `index.html` at 1920 × 1080 and screenshot each section. Fix overflow and colliding labels.

**PDF format only:** print `index.html` to a PDF named after the folder (`<folder name>.pdf`) with headless Chromium, using `print_background=True` and `prefer_css_page_size=True`. The page count must equal the section count. The HTML is only the source of the PDF here. If Playwright isn't available, say so, offer the HTML instead, and don't claim a PDF exists.

## Step 6: Deliver

Name the folder `<app>-release-<target>-vs-<previous>/` for the short report, and `<app>-release-<target>-vs-<previous>-full/` for the full one, so both can sit side by side. It holds:
- **the report:** `index.html` for the HTML format, or the PDF for the PDF format (keep `index.html` next to it as its source);
- the plan `.md` from Step 4;
- the script that generated the report, with its data.

Give the user the path of the file in the format they asked for.

In the chat:
- lead with the verdict in one sentence;
- then give a small table of the key numbers, the biggest driver and the main caveat;
- keep it short, since the report carries the detail;
- after a short report, offer the full one in one line (`--detail full`).

---
name: release-report
description: Compare a mobile app release against the previous version in Firebase Crashlytics and deliver a stability report as HTML or PDF, either short (a plain-language verdict card per platform and the daily stability charts; the default) or full (adds the method, the issue analysis, and gone and new issues). Use when the user names a version to judge ("compare 5.21.7", "is the new release more stable?") or asks how a release is doing in Crashlytics.
argument-hint: "[version] [--detail short|full] [--format html|pdf] [package-id ...]"
---

# Release stability report

The user names the release to judge, for example `5.21.7`, or leaves it out and the skill finds it. Pull crash data for that release and for the version shipped right before it, on every platform the app has, and deliver a report that answers one question: **did this release make the app more or less stable?**

The answer can be "no". A release that got worse is a useful finding. Report what the data shows and never bend the headline toward good news.

All data comes from the Firebase MCP server bundled with this plugin. Its tools are named `crashlytics_*` and `firebase_*`; load them with ToolSearch (query `crashlytics`). Never open the Firebase console in a browser.

### When the Firebase tools fail

If ToolSearch finds no `crashlytics_*` tools, or a call (or `daily-series.mjs`) fails, find out why before giving up:

```bash
command -v firebase || echo CLI_MISSING
firebase projects:list --json --non-interactive 2>&1 | head -c 1500
```

Then stop and tell the user exactly what to do, quoting the CLI's error line:

- **Login expired** (the output mentions `--reauth`, "credentials are no longer valid" or `invalid_grant`): "Your Firebase login expired. Run `firebase login --reauth`, then restart Claude Code."
- **Not logged in** ("No authorized accounts", "not logged in"): "Run `firebase login`, then restart Claude Code."
- **CLI missing** (`CLI_MISSING`): "Run `npm i -g firebase-tools`, then `firebase login`, then restart Claude Code."
- **Login works** (`"status": "success"`) but the tools are missing: "The Firebase connection didn't start or timed out. Restart Claude Code." If only one call failed, retry it once first.

## Inputs

1. **Target version** (optional): a marketing version such as `5.21.7`. Build numbers differ per platform; you find them yourself. Without it, resolve it as in "Find the target version" below.
2. **Detail** (optional): `--detail short` or `--detail full`. The default is `short`.
   - **short:** two pages that anyone can read at a glance. Page 1 is the verdict: one card per platform with the first-week crash-free users, the previous value, the change in words and the top crash to fix. Page 2 has only the daily stability charts, one per platform, with no tables.
   - **full:** the complete report: the method, the same-week table, the stability chart, the issue analysis, gone and new issues, and the conclusions.

   Both reports always include the stability chart (see "The stability chart" in Step 5).

   Accept plain words too: "full", "complete" or "detailed" mean full; "short", "summary" or "brief" mean short.
3. **Format** (optional): `--format html` or `--format pdf`. The default is `html`. Accept the same choice in plain words too ("as a PDF").
4. **Apps** (optional): Android package names or iOS bundle IDs. Without them, use every app in the repository's Firebase config files.
5. **Exclusions** (optional): crashes the user says are external and already fixed, such as an SDK bug. Exclude them only when the user says so, and link the upstream issue.

Don't ask for anything: pick sensible defaults, and state them in the report and in the chat.

### Find the target version

When no version is given, use the highest version with events in Crashlytics, on any platform. Take it from the 30-day `get_top_versions` call in "Find builds and the previous version". Ignore the project's manifest: it often holds a version that hasn't shipped yet, such as a bump on a release-prep branch.

Name the resolved version in the chat before the verdict, and in the report footer, for example "5.21.7: the latest version with Crashlytics data".

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
  - In Flutter apps, uncaught errors reported as fatal count as crashes. Explain this in the method section (full report only; the short report's footer just says "no fatal crash").
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

Two pages, written for someone who is not a developer. Less is more: no KPI table, no issue list, no daily tables and no long notes. The data the skill pulls still decides the verdict and the caveat; it just doesn't all go on the page.

**Page 1: the verdict.**
1. **Eyebrow:** "Release <target> vs <previous>".
2. **Headline:** the verdict in plain words, as short as possible, for example "5.21.8 is as stable as 5.21.7" or "5.21.8 is less stable than 5.21.7 on Android". The numbers go in the cards, not the headline.
3. **Lead line:** what the number means, for example "Share of users who did not crash during each version's first 7 days".
4. **One card per platform,** side by side, each with:
   - the platform name;
   - one big number in the accent color: the target's first-7-days average crash-free users;
   - "was <x>% in <previous>" in gray;
   - the change in words, then the points in gray: "No real change (+0.1 pts)", "Slightly better (+0.7 pts)", "Better (+4.1 pts)", "Slightly worse (−0.8 pts)" or "Worse (−3.2 pts)". Use "no real change" under 0.5 pts and "slightly" under 2 pts;
   - **Top crash to fix:** the target's top issue by users hit, named in plain words (what it does, not the stack frame), with its user count. Add one fact that changes what to do about it, when there is one: a fix already merged after the target was cut (check `git log` for the issue ID or a matching fix), or the same issue being top on the other platform too.
5. **One line under the cards:** the most important caveat with the next check date, for example "Next check: 2026-12-02. 5.21.8 is only 9 days old and samples are small, so moves under 1 pt are noise." When the same-week view disagrees with the verdict, or crashes were excluded, say that here instead, in one sentence.
6. **Footer, one line:** the builds, "crash-free = users with no fatal crash, over each version's first 7 days", the source, the date and the owner.

**Page 2: the daily stability charts.** See "The stability chart" in Step 5, short layout.

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

Both reports use the same style. The chart page differs: the short report shows only the charts, the full report adds the data table and notes.

### The stability chart

The lines themselves are the same in both reports:
- **X axis:** `Day 1` … `Day 7`, using each version's own first 7 reported days.
- **Y axis:** percentages, with gridlines every 10 points.
  - Start the axis at a round 10 below the lowest value, or at 50% if that's lower. The axis may start above zero because these are rates, not counts.
  - End it at 100%.
- **One line per version,** with a dot on each day and the version name as a label at the end of the line, not in a legend.
  - The target is the accent color and drawn thicker. The previous version is neutral gray.
- **Alt text:** put a one-sentence description of the trend in the SVG's `<title>` and `aria-label`.

#### Short layout

One page with one chart per platform, side by side and large, always (one platform: one chart, full width).
- **Eyebrow:** "Daily stability · first 7 days".
- **Headline:** the finding in plain words, for example "Day by day, 5.21.8 tracks 5.21.7 on both platforms".
- **Over each chart:** the platform name, then "Average: <previous> <x>% · <target> <y>%", the target in the accent color.
- **No data table.**
- **One line at the bottom:** what each line shows ("Each line is the share of users without a crash that day"), plus the single most misleading point, if any, explained in a few words, for example "Android 5.21.7's Day 1 dip (92.9%) is one user out of 14."

#### Full layout

It's one page for the platform whose first-week gap is largest. Lay it out like this:

- **Eyebrow:** the section number and "First 7 days".
- **Headline:** the finding with both numbers, for example "At the same age, Android 5.21.7 averaged 97.6% crash-free users, vs 71.0% for 5.21.6."
- **Left, about two thirds of the width:** the line chart of daily crash-free users.
- **Right, about one third:** the data table.
  - Columns: Day, then the date and crash-free users for the previous version, then the date and crash-free users for the target.
  - Show dates as `MM-DD`.
  - The last row is **Average**, in bold.
  - The target's values are in the accent color.
- **Under the table:** two short notes.
  - **The other platform:** its first-week averages and gap, in one line, for example "iOS first-week averages: 5.21.6 94.9%, 5.21.7 98.7% (+3.8 pts)".
  - **What to read with care:** small Day 1 samples, with their user counts. Days without data. A dip that hit other versions on the same day, named as an outside event; check it with `get_top_versions` for that day. Or, when the two series cover different dates, say that a dip can't be checked against the other version, and name the low day.

If the platforms moved by similar amounts, within 2 points, chart both platforms side by side on the same page with smaller tables. If there is only one platform, chart that one.

Style rules:
- The target version is the accent and the previous version is neutral.
- Don't use red or green for "worse" or "better": put the change in text instead.
- Numbers are tabular, and right-aligned in tables.
- Write "—" for missing values, never a blank cell.
- Keep "iOS" in its own casing inside uppercase headings and table headers (wrap it in a span with `text-transform: none`), so it never reads "IOS".
- Keep headlines to one or two lines, with no word alone on the last line; shorten the headline rather than shrinking the type.
- Take the owner's name from `git config user.name`.

Generate `index.html` from a small script that holds the numbers, so each value is fixed in one place.

**Headless browser:** use Playwright's Chromium when it's installed. Otherwise fall back to an installed Chrome or Chromium binary, run headless. Find one with:

```bash
for b in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" google-chrome google-chrome-stable chromium chromium-browser; do
  { [ -x "$b" ] || command -v "$b" >/dev/null 2>&1; } && { echo "$b"; break; }
done
```

**Check:** open `index.html` at 1920 × 1080 and screenshot each section, then look at every screenshot. Fix overflow (a section's content cut off at the bottom) and colliding labels.
- **Playwright:** set the viewport to 1920 × 1080 and screenshot each `<section>`.
- **Chrome fallback:** `"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1920,<1080 × section count> --screenshot=<out>.png "file://<abs path>/index.html"`, then crop the image into 1080-pixel-tall pages (`sips -c 1080 1920 --cropOffset <n × 1080> 0` on macOS). If the page adds screen-only spacing between sections, remove it in a temporary copy first, or the crops drift. Keep the screenshots in the scratchpad, not the report folder.

**PDF format only:** print `index.html` to a PDF named after the folder (`<folder name>.pdf`). The page count must equal the section count; check it (for example, count `/Type /Page` objects in the file). The HTML is only the source of the PDF here.
- **Playwright:** `page.pdf(...)` with `print_background=True` and `prefer_css_page_size=True`.
- **Chrome fallback:** `"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="<abs path>/<folder name>.pdf" "file://<abs path>/index.html"`. Chrome uses the CSS `@page` size on its own; for backgrounds to print, the stylesheet needs `-webkit-print-color-adjust: exact; print-color-adjust: exact` under `@media print`. Say in the chat that the PDF was printed with headless Chrome.
- **Neither available:** say so, offer the HTML instead, and don't claim a PDF exists.

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

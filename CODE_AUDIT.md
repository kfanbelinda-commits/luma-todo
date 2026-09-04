# Luma Todo Code Audit — 2026-09-05

Baseline: `main` / v1.1.0  
Audit branch: `maintenance/codebase-cleanup-20260905`

This document records findings before functional refactoring. Items marked **do not change yet** are intentionally left in place.

## 1. Repository and package size

- Git-tracked repository content is about 1.82 MB.
- The Windows installer is about 112.8 MB because Electron packages Chromium, Node.js, and the Electron runtime.
- `assets/Lumatodo.png` is about 1.3 MB. It is used by README but not by the application. The maintenance branch already excludes it from the packaged app.
- Large local working directories are expected to come primarily from `node_modules` and `dist`, not from Luma business source.

## 2. Confirmed isolated dead code

Static reference scanning found these functions defined but never referenced anywhere else:

- `isTodayTask`
- `parseQuickInput`

These are safe candidates for the first code-removal pass because they have no callers and do not own UI state.

## 3. Dormant/dead feature cluster — do not remove in the first pass

The following code appears to belong to an older upcoming/date-filter UI:

- `renderUpcoming`
- `openTaskInCalendar`
- `stepTaskDateFilter`
- `toggleTodayOrAll`
- `setTaskDateFilter` is only referenced by the two dormant date-filter functions.
- `taskDateFilter` still participates in several render paths, so removing the whole cluster should be a separate reviewed change.

Evidence:

- There is no `#upcomingList` element in current `index.html`.
- `render()` does not call `renderUpcoming()`.
- Upcoming UI selectors remain in both CSS files even though the current HTML has no upcoming card.

Associated likely-dead CSS includes:

- `.upcoming-card`
- `.upcoming-list`
- `.upcoming-item`
- `.upcoming-date`
- `.upcoming-title`
- `.upcoming-project`
- `.upcoming-time`

These selectors should not be deleted until the dormant JS cluster is handled in a separate commit.

## 4. CSS maintainability

`src/theme-graphite.css` is about 4,100 lines and contains many repeated selectors. Examples:

- `html[data-theme="light"] .modal` — 5 declarations
- `.calendar-panel` — 4 declarations in the theme file, 5 across both CSS files
- `.completed-toggle` — 4 declarations in the theme file, 5 across both CSS files
- `.calendar-create-fields` — 4 declarations
- `.day-event` — multiple declarations across the cascade
- several light-theme calendar selectors are declared 3–4 times

This is a maintenance risk, but **not an automatic deletion target**. Many later rules intentionally override earlier rules. CSS consolidation needs visual regression testing and should be done selector group by selector group.

## 5. Large source files

Current rough size:

- `src/app.js`: ~2,660 lines, ~105 named functions
- `main.cjs`: ~2,100 lines, ~88 named functions
- `src/theme-graphite.css`: ~4,100 lines

Potential future module boundaries:

Renderer:
- calendar
- todo/projects
- settings
- time/date parsing
- sync UI

Main process:
- storage/backups
- Windows window/desktop host
- Google sync
- iCloud/CalDAV sync
- updater

**Do not split these yet.** Module extraction changes dependency boundaries and is much higher risk than dead-code removal.

## 6. Electron security review

Existing good practices:

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer access is routed through preload
- Apple/iCloud credentials are encrypted with Electron `safeStorage`
- saved iCloud password is not returned by `publicIcloudStatus`
- iCloud sync only accepts a calendar URL that matches the discovered saved calendar list
- user data and encrypted credential files are Git-ignored

Hardening opportunities for later, one at a time:

- no explicit Content Security Policy is present
- no explicit `setWindowOpenHandler` restriction
- no explicit `will-navigate` restriction
- no explicit `sandbox: true` in BrowserWindow options
- IPC handlers do not consistently validate the sender frame

These are security-hardening tasks, not cleanup tasks. They should be tested in a packaged build because aggressive Electron hardening can break preload or external-auth flows if applied incorrectly.

## 7. Quality tooling

Current `npm run check` performs JavaScript syntax checks only.

Missing:

- unit tests
- renderer smoke tests
- sync fixture tests
- lint rules
- formatting rules
- CSS regression checks

Before large refactors, tests have higher value than splitting files.

## 8. Documentation drift

README still says v1.0.0 although the released version is v1.1.0. This is documentation-only and can be corrected independently.

## Recommended sequence

1. Keep current packaging exclusion and repository rules.
2. Remove only confirmed isolated dead functions.
3. Re-scan references.
4. Remove the dormant upcoming UI cluster only if the second scan confirms no live callers.
5. Remove the associated dead CSS in a separate commit.
6. Add lightweight tests before CSS consolidation or module splitting.
7. Apply Electron security hardening one item at a time with packaged smoke tests.
8. Split large files only after tests exist.

# Luma Todo Code Audit — 2026-09-05

Baseline: `main` / v1.1.0  
Audit branch: `maintenance/codebase-cleanup-20260905`

This audit separates low-risk cleanup from later refactoring/security work. The cleanup branch must not change Luma product semantics.

## 1. Size findings

- The Git-tracked application source is small; the hundreds of MB seen in a local checkout come primarily from Electron, `node_modules`, and build output.
- The released v1.1.0 Windows installer was about 112.8 MB.
- `assets/Lumatodo.png` is a README/promotional image (~1.3 MB), not a runtime asset.
- The cleanup branch packages only the runtime icons/helper resources needed by the app. CI currently produces an installer around 111.47 MB.
- A large reduction beyond this would require changing the Electron runtime architecture, not deleting ordinary Luma JavaScript.

## 2. Dead code cleanup completed

Confirmed no-caller renderer helpers removed:

- `isTodayTask`
- `parseQuickInput`
- `renderUpcoming`
- `openTaskInCalendar`
- `stepTaskDateFilter`
- `toggleTodayOrAll`
- `setTaskDateFilter`

The old upcoming/date-filter UI was verified absent from current HTML before removal.

Associated unused CSS removed:

- `.upcoming-card`
- `.upcoming-list`
- `.upcoming-item`
- `.upcoming-date`
- `.upcoming-title`
- `.upcoming-project`
- `.upcoming-time`
- old `.text-button` / `.empty-note` rules that existed only for that UI

A post-cleanup reference scan currently finds no named functions in `src/app.js` or `main.cjs` that are defined only once and never referenced.

## 3. CSS cleanup completed in the low-risk area

Only declarations proven to be superseded by a later rule with the same selector were removed.

Completed areas:

- settings modal duplicate sizing/scroll declarations
- Apple/iCloud settings duplicate grid/input/select declarations
- obsolete light-mode new-project button rules
- obsolete light modal backdrop/label rules
- superseded light-theme token values

Calendar/Todo-sensitive selector families such as `.calendar-*`, `.day-*`, completion-state selectors, and calendar cell sizing rules were intentionally not consolidated.

Each CSS batch was followed by:

- Windows Electron startup
- dark/light screenshots
- behavior smoke tests
- full Windows packaging
- before/after pixel comparison

Light settings and expanded screenshots remained pixel-identical across the safe CSS cleanup batches.

## 4. Current source size

Approximate current branch sizes:

- `src/app.js`: 2,531 lines
- `main.cjs`: 2,146 lines
- `src/theme-graphite.css`: 4,032 lines

QA test implementations live under `qa/` rather than being embedded in `main.cjs`. The `qa/` directory is excluded from the production package.

Potential future module boundaries remain:

Renderer:
- calendar
- todo/projects
- settings
- time/date utilities
- sync UI

Main process:
- storage/backups
- Windows window/desktop host
- Google sync
- iCloud/CalDAV sync
- updater

Do not split these modules until the relevant tests cover the behavior being moved.

## 5. Automated protection now present

`npm run check` now performs syntax checks plus repository invariants.

Invariant checks protect:

- real-data default startup
- package/lock version consistency
- production package file allowlist
- exclusion of demo and QA files
- credential/user-data ignore rules
- `contextIsolation: true`
- `nodeIntegration: false`
- use of `safeStorage`
- no saved iCloud password exposure through public status
- no direct filesystem/child-process preload exposure
- QA execution remaining dev-only

Windows PR verification now runs:

- `npm ci`
- source/invariant checks
- actual Electron startup
- dark compact/expanded UI smoke
- light settings compact/expanded UI smoke
- custom window resize QA
- Todo/Calendar behavior smoke
- offline Apple/iCloud and Google sync protocol smoke
- full Windows installer build and output validation

Behavior smoke currently verifies:

- quick-add Todo
- timed Todo remains Todo
- 1.5s completion grace period
- completion undo during grace period
- completed Todo remains on its calendar date
- completed Todo can be restored
- expand/collapse path

Offline sync protocol smoke currently verifies:

- iCloud timed Todo round-trip
- iCloud completed Todo metadata
- iCloud all-day Event round-trip
- iCloud overnight Event round-trip
- native Apple Event parsing
- Google timed Todo mirror semantics
- Google Event round-trip

No real Apple/Google credentials are used in CI.

## 6. Electron security review

Existing good practices:

- `contextIsolation: true`
- `nodeIntegration: false`
- renderer capabilities exposed through preload
- Apple/iCloud credentials encrypted with Electron `safeStorage`
- saved iCloud password not returned to renderer status APIs
- iCloud sync target restricted to the discovered saved calendar list
- user data and encrypted credentials excluded from Git

Hardening still deferred to a separate branch:

- add an explicit Content Security Policy
- restrict new-window creation with `setWindowOpenHandler`
- restrict unexpected navigation with `will-navigate`
- evaluate explicit `sandbox: true`
- add consistent IPC sender/frame validation

These must be introduced one at a time and tested in a packaged Windows build because they can affect preload, OAuth, and external browser flows.

## 7. Remaining maintainability risks

- `src/theme-graphite.css` still has many intentional historical overrides, especially Calendar/light-theme rules.
- `src/app.js` and `main.cjs` are still large single files.
- There is no general unit-test framework or lint/format enforcement yet.
- Real authenticated Apple/Google end-to-end tests are intentionally absent from CI.
- Screenshot comparison is currently performed during cleanup review rather than enforced as a permanent pixel-baseline test.

## 8. Next sequence

1. Merge this low-risk cleanup only after the final Windows verification passes.
2. Start Electron security hardening on a new branch.
3. Add pure utility/unit tests before extracting production modules.
4. Extract low-coupling pure modules before touching Calendar renderer or Windows Pin/WorkerW code.
5. Consolidate Calendar CSS only after a dedicated visual regression baseline exists.

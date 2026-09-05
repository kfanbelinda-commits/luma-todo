# Luma Todo Repository Rules

These rules apply to all code changes in this repository.

## Stability first

- Treat `main` as release-only. Do feature and maintenance work on a branch.
- Prefer the smallest change that solves the issue. Do not refactor unrelated code in the same change.
- Do not change Todo/Event semantics while doing UI or maintenance work.
- Do not change Windows desktop-host/Pin behavior while working on calendar, sync, settings, or styling.
- Do not change Google/iCloud sync behavior during cleanup unless the task explicitly targets sync.
- Do not rewrite working code only for style consistency.

## Data and credentials

- Production data lives under the normal Luma user-data directory. Demo data must remain isolated.
- Never make demo mode the default startup mode.
- Never commit or package user data, backups, Google tokens, Apple/iCloud credentials, passwords, or local window state.
- Keep `credentials.json`, `google-token.enc`, `icloud-calendar.enc`, `luma-data.json`, window state, backups, logs, and build output out of Git.
- Apple/iCloud credentials must remain in local encrypted storage; renderer code must never receive the saved password.

## Electron security

- Keep `contextIsolation: true`.
- Keep `nodeIntegration: false`.
- Expose renderer capabilities only through the preload bridge.
- New IPC handlers should validate inputs and should not expose arbitrary filesystem or shell access.
- Do not enable remote content or navigation without an explicit security review.

## UI and CSS

- Before adding a CSS rule, search for existing selectors and later overrides.
- Do not fix visual issues by appending another duplicate override when an existing rule can be corrected safely.
- Preserve established sizing, Pin behavior, calendar interactions, completed-task behavior, and light/dark themes unless the task asks to change them.
- Cleanup must not alter layout or appearance unless explicitly requested.

## Calendar and Todo invariants

- Todo and Event are distinct item types.
- A Todo with a time remains a Todo.
- Completed Todo items remain visible on their calendar date and can be restored with the checkbox.
- System calendar projects are not normal Todo categories.
- Google external events remain read-only unless their integration explicitly changes.
- Apple/iCloud Event edits must preserve their source/link metadata.

## Change discipline

- For maintenance-only work, prefer documentation, packaging exclusions, dead-file removal, and tests before module extraction.
- Large-file/module splits require a dedicated branch and behavior checks before merge.
- Avoid changes spanning `main.cjs`, `src/app.js`, and `src/theme-graphite.css` at once unless necessary.
- Do not rename persisted state fields without a migration.
- Do not delete compatibility fields without checking existing user data.

## Required checks

Before proposing a merge:

```powershell
npm run check
```

Also verify the diff contains only intended files. For changes affecting packaging, run a Windows build before release. For changes affecting calendar/Todo UI, manually smoke-test compact and expanded modes with real-looking non-sensitive test data.

## Release rules

- Version changes follow semantic versioning.
- Release commits must come from reviewed/tested branch state.
- Do not publish from a cleanup branch unless the cleanup has been separately validated.

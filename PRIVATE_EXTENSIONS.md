# Private extension API 2

The public app owns installation, a Shadow DOM panel host, date context, date badges,
and credential-backed calendar transport. Extension files are installed under user data
and are never bundled with the app.

An encrypted format-1 package can declare `apiVersion: 2` and `contributions`:

```json
{
  "panel": {"label": "E", "title": "Open extension"},
  "settings": true,
  "dayMarks": true,
  "calendar": {"legacySetting": "exampleCalendarUrl"}
}
```

The CommonJS entry supports these methods:

- `getPanel({dateKey, firstTime, ...state})`: `{html, css, title, width, state}`.
- `getSettings({calendar, result, error})`: `{html, css}`. Calendar status contains
  connection state, calendar names/URLs and the selected URL; no saved password.
- `getDayMarks({startDate, endDate})`: `{marks:[{dateKey,label,short,appearance}]}`.
  Appearance accepts hex `color`, `background`, `lightColor`, `lightBackground`.
- `getCalendarRange()`: `{startDate,endDate}`.
- `getCalendarEvents(range)`: `{events:[{uid,dateKey,title,ics}]}`.
- `identifyCalendarEvent(event)`: `{uid,dateKey}` for owned events, otherwise `null`.

Panel HTML uses declarative `data-extension-action` buttons: `render` (JSON
`data-extension-args`), `shift-date` (`data-extension-offset` of -1 or 1), and `close`.
Settings use `sync-calendar` with a `data-extension-field="calendarUrl"` select.
The host runs no extension renderer script and strips active embedded elements,
inline handlers and navigation attributes. Existing CSP, context isolation and
disabled Node integration remain in place. The CommonJS entry remains trusted local
code, as in API 1; this is not a sandbox for untrusted plugins.

Calendar events keep stable UIDs. The ICS parser preserves unknown `X-LUMA-*`
properties, excluding the app's ordinary item metadata. An unknown boolean marker
set to `TRUE` identifies an extension event, which stays out of ordinary import even
when its extension is uninstalled. Reconciliation deletes only events identified
by that extension inside its requested range. Malformed payloads stop before writes.

A legacy selected-calendar field ending in `CalendarUrl` can be declared by the
extension. The host returns only a URL in the discovered calendar list and migrates
the selection to `extensionCalendars[id]` after a successful sync. It does not change
remote event identifiers. Uninstall preserves authorization, calendar selection and
remote events; local files move outside the installed directory.

API-1 extensions remain listed with an upgrade message and can be replaced or
uninstalled. They do not expose panel, badge or sync capabilities in this host.

## Verification

Run `npm run check`, then the existing Windows demo smoke and build. Isolated demo
data can be directed with `LUMA_DEMO_DATA_DIR`. Development-only plugin smoke can
use `LUMA_EXTENSION_TEST_FIXTURE` (JSON with `code` and `packagePath`) and
`LUMA_EXTENSION_SMOKE_SCRIPT`; both are ignored in packaged/normal mode.
Private fixtures and their UI checks belong to the extension project.

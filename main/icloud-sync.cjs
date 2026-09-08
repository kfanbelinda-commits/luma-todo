'use strict';

// Only fields represented by the Apple mirror belong in the sync baseline.
// Todo duration/color and Event completion remain local presentation details.
const FIELDS = ['title', 'dueDate', 'time', 'endDate', 'endTime', 'completed', 'eventColor'];
const SCHEDULE = ['dueDate', 'time', 'endDate', 'endTime'];
const DEFAULT_COLOR = '#91a9c7';

function snapshot(item, itemType = item.itemType, remote = false) {
  const todo = itemType !== 'event';
  let title = String(item.title || '').trim();
  let completed = Boolean(remote ? item.lumaCompleted : item.completed);
  if (todo && remote) {
    if (/^[✓✔]/u.test(title)) completed = true;
    else if (/^[□☐]/u.test(title)) completed = false;
    title = title.replace(/^[✓✔□☐]\s*/u, '').trim();
  }
  const dueDate = String(item.dueDate || '');
  const time = String(item.time || '');
  return {
    title: title || (todo ? '未命名待办' : '未命名日程'),
    dueDate, time,
    endDate: todo ? '' : String(item.endDate || dueDate),
    endTime: todo || !time ? '' : String(item.endTime || time),
    completed: todo && completed,
    eventColor: todo ? '' : (/^#[0-9a-f]{6}$/i.test(item.eventColor || '') ? item.eventColor.toLowerCase() : DEFAULT_COLOR),
  };
}

function same(a, b) {
  return Boolean(a && b && FIELDS.every((field) => a[field] === b[field]));
}

function validSchedule(value, itemType) {
  const validDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date)
    && !Number.isNaN(Date.parse(date + 'T12:00:00Z'))
    && new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) === date;
  const validTime = (time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!validDate(value.dueDate) || (value.time && !validTime(value.time))) return false;
  if (itemType !== 'event') return true;
  if (!validDate(value.endDate) || value.endDate < value.dueDate) return false;
  if (!value.time) return !value.endTime;
  return validTime(value.endTime)
    && value.endDate + 'T' + value.endTime >= value.dueDate + 'T' + value.time;
}

function mergeSnapshots(base, local, remote, itemType) {
  if (!base && !same(local, remote)) return { type: 'missing-baseline', fields: FIELDS.filter((key) => local[key] !== remote[key]) };
  const merged = { ...local };
  const fields = [];
  for (const key of FIELDS) {
    if (local[key] === remote[key]) continue;
    if (base && local[key] === base[key]) merged[key] = remote[key];
    else if (!base || remote[key] !== base[key]) fields.push(key);
  }
  if (fields.length) return { type: 'both-modified', fields };
  // Switching all-day/timed and changing the other end are coupled edits.
  if (base && Boolean(local.time) !== Boolean(remote.time)
    && SCHEDULE.some((key) => local[key] !== base[key])
    && SCHEDULE.some((key) => remote[key] !== base[key])) {
    return { type: 'schedule-conflict', fields: SCHEDULE };
  }
  if (!validSchedule(merged, itemType)) return { type: 'invalid-schedule', fields: SCHEDULE };
  return { merged };
}

function applySnapshot(task, value) {
  const keys = task.itemType === 'event'
    ? FIELDS.filter((key) => key !== 'completed')
    : ['title', 'dueDate', 'time', 'completed'];
  for (const key of keys) task[key] = value[key];
}

function markConflict(target, type, local, remote, remoteEtag, fields = []) {
  target.icloudConflict = {
    type, fields, detectedAt: Date.now(),
    base: target.lastIcloudSnapshot || null,
    local, remote, remoteEtag: remoteEtag || '',
  };
  delete target.icloudResolution;
}

function resolutionFor(target, local, remote, remoteEtag) {
  const choice = target.icloudResolution;
  const conflict = target.icloudConflict;
  if (!choice || !conflict || !['local', 'remote'].includes(choice.choice)) return '';
  const equalNullable = (a, b) => a === null && b === null || same(a, b);
  if (choice.detectedAt !== conflict.detectedAt
    || !equalNullable(conflict.local, local) || !equalNullable(conflict.remote, remote)
    || conflict.remoteEtag !== (remoteEtag || '')) return '';
  return choice.choice;
}

function finish(task, value, remote, calendar) {
  const changed = !same(snapshot(task), value);
  applySnapshot(task, value);
  task.icloudHref = remote.href;
  task.icloudUid = remote.uid;
  task.icloudEtag = remote.etag || '';
  task.lastIcloudEtag = remote.etag || '';
  task.icloudCalendarUrl = calendar.url;
  task.icloudCalendarName = calendar.name;
  task.lastIcloudSnapshot = { ...value };
  task.lastIcloudSyncAt = Date.now();
  if (changed) task.updatedAt = task.lastIcloudSyncAt;
  delete task.icloudConflict;
  delete task.icloudResolution;
  delete task.icloudSyncError;
  delete task.icloudPendingHref;
  delete task.icloudPendingUid;
}

// The transport is injected so full sync sequences can be tested without Apple
// credentials, Electron, or production data. Retries are bounded per resource.
async function syncCalendar(state, calendar, io) {
  state.tasks ??= [];
  state.projects ??= [];
  state.icloudDeletedItems = Array.isArray(state.icloudDeletedItems) ? state.icloudDeletedItems : [];
  const summary = { created: 0, updated: 0, unchanged: 0, downloaded: 0, deleted: 0, remoteDeleted: 0, conflicts: 0, failed: 0, calendarName: calendar.name };
  // A failed/incomplete listing must never be interpreted as remote deletion.
  const remotes = await io.list();
  const byHref = new Map(remotes.map((item) => [item.href, item]));
  const byUid = new Map(remotes.map((item) => [item.uid, item]));
  const byId = new Map(remotes.filter((item) => item.lumaTaskId).map((item) => [item.lumaTaskId, item]));
  const consumed = new Set();
  const fail = (target, error) => {
    target.icloudSyncError = String(error.message || 'iCloud 单条同步失败');
    summary.failed += 1;
  };
  const consume = (remote) => { if (remote) consumed.add(remote.href); };
  const eligible = (task) => task && ['todo', 'event'].includes(task.itemType)
    && !task.googleCalendarExternal && task.syncTarget !== 'external-calendar'
    && (!task.icloudCalendarUrl || task.icloudCalendarUrl === calendar.url);

  const pending = [];
  for (const entry of state.icloudDeletedItems) {
    if (!entry || entry.calendarUrl !== calendar.url) { pending.push(entry); continue; }
    delete entry.icloudSyncError;
    let remote = byHref.get(entry.href) || byUid.get(entry.uid) || null;
    consume(remote);
    let removed = false;
    let restoredFromApple = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!remote) { removed = true; break; }
        const remoteValue = snapshot(remote, entry.itemType, true);
        const choice = resolutionFor(entry, null, remoteValue, remote.etag);
        if (choice === 'remote' && entry.task) {
          const restored = structuredClone(entry.task);
          if (state.tasks.some((task) => task.id === restored.id)) throw new Error('恢复事项时发现相同 ID，请保留冲突并检查本地事项');
          finish(restored, remoteValue, remote, calendar);
          state.tasks.push(restored);
          summary.downloaded += 1;
          restoredFromApple = true;
          removed = true;
          break;
        }
        const unchanged = entry.lastIcloudSnapshot
          ? same(entry.lastIcloudSnapshot, remoteValue)
          : Boolean(entry.etag && entry.etag === remote.etag && !entry.icloudConflict);
        if (choice !== 'local' && !unchanged) {
          markConflict(entry, 'local-deleted-remote-modified', null, remoteValue, remote.etag);
          break;
        }
        if (!remote.etag) {
          markConflict(entry, 'missing-etag', null, remoteValue, '');
          break;
        }
        try {
          await io.remove(remote.href, remote.etag);
          removed = true;
          break;
        } catch (error) {
          if (error.status !== 412) throw error;
          remote = await io.get(remote.href);
          consume(remote);
          if (attempt === 1 && remote) markConflict(entry, 'remote-changing', null, snapshot(remote, entry.itemType, true), remote.etag);
          if (!remote) removed = true;
        }
      }
    } catch (error) { fail(entry, error); }
    if (removed && !restoredFromApple) summary.remoteDeleted += 1;
    if (!removed) pending.push(entry);
  }
  state.icloudDeletedItems = pending;

  const retained = [];
  for (const task of state.tasks) {
    if (!eligible(task)) { retained.push(task); continue; }
    delete task.icloudSyncError;
    let remote = byHref.get(task.icloudHref) || byUid.get(task.icloudUid) || byId.get(task.id) || null;
    consume(remote);
    const linked = Boolean(task.icloudHref || task.icloudUid);
    if (!linked && !remote && !task.dueDate) { retained.push(task); continue; }
    task.icloudCalendarUrl = calendar.url;
    task.icloudCalendarName = calendar.name;
    const local = snapshot(task);
    let removeLocal = false;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remoteValue = remote ? snapshot(remote, task.itemType, true) : null;
        const choice = resolutionFor(task, local, remoteValue, remote?.etag);
        let value = local;
        if (!remote && linked) {
          if (choice === 'remote' || (choice !== 'local' && same(task.lastIcloudSnapshot, local))) {
            removeLocal = true;
            summary.deleted += 1;
            break;
          }
          if (choice !== 'local') {
            markConflict(task, 'remote-deleted-local-modified', local, null, '');
            break;
          }
        } else if (remote) {
          if (choice === 'remote') value = remoteValue;
          else if (choice !== 'local') {
            const result = mergeSnapshots(task.lastIcloudSnapshot, local, remoteValue, task.itemType);
            if (!result.merged) {
              markConflict(task, result.type, local, remoteValue, remote.etag, result.fields);
              break;
            }
            value = result.merged;
          }
          if (same(value, remoteValue)) {
            finish(task, value, remote, calendar);
            if (!same(local, value)) summary.downloaded += 1;
            else summary.unchanged += 1;
            break;
          }
        }
        if (!validSchedule(value, task.itemType)) {
          markConflict(task, 'invalid-schedule', local, remoteValue, remote?.etag, SCHEDULE);
          break;
        }
        if (remote && !remote.etag) {
          markConflict(task, 'missing-etag', local, remoteValue, '');
          break;
        }
        const uid = remote?.uid || task.icloudUid || io.uid(task.id);
        const href = remote?.href || task.icloudHref || calendar.url.replace(/\/?$/, '/') + encodeURIComponent(uid) + '.ics';
        const upload = { ...task };
        applySnapshot(upload, value);
        // Retain the attempted resource if a response is lost after Apple saves
        // it, so a concurrent local deletion can still queue reconciliation.
        task.icloudPendingHref = href;
        task.icloudPendingUid = uid;
        try {
          const etag = await io.put(href, upload, uid, remote?.etag || '');
          let saved = { href, uid, etag };
          if (!etag) {
            saved = await io.get(href);
            if (!saved || !same(value, snapshot(saved, task.itemType, true))) {
              markConflict(task, 'write-unconfirmed', local, saved ? snapshot(saved, task.itemType, true) : null, saved?.etag);
              break;
            }
          }
          finish(task, value, saved, calendar);
          if (remote) summary.updated += 1;
          else summary.created += 1;
          break;
        } catch (error) {
          if (error.status !== 412) throw error;
          remote = await io.get(href);
          consume(remote);
          if (attempt === 1) markConflict(task, 'remote-changing', local, remote ? snapshot(remote, task.itemType, true) : null, remote?.etag);
        }
      }
    } catch (error) { fail(task, error); }
    if (!removeLocal) retained.push(task);
  }
  state.tasks = retained;

  for (const remote of remotes) {
    if (consumed.has(remote.href) || remote.lumaItemType === 'todo') continue;
    if (remote.lumaTaskId && state.tasks.some((task) => task.id === remote.lumaTaskId)) continue;
    const id = 'icloud-' + io.safeId(remote.uid);
    if (state.tasks.some((task) => task.id === id)) continue;
    io.ensureProject(state);
    const task = { id, itemType: 'event', projectId: 'apple-calendar', syncTarget: 'calendar', completed: false,
      createdAt: Date.now(), updatedAt: Date.now(), order: Date.now(), reminder: null, icloudExternal: true };
    finish(task, snapshot(remote, 'event', true), remote, calendar);
    state.tasks.push(task);
    summary.downloaded += 1;
  }
  summary.conflicts = state.tasks.filter((task) => eligible(task) && task.icloudConflict).length
    + pending.filter((item) => item?.calendarUrl === calendar.url && item.icloudConflict).length;
  summary.mirroredTodos = state.tasks.filter((task) => eligible(task) && task.itemType === 'todo' && task.dueDate).length;
  summary.syncedEvents = state.tasks.filter((task) => eligible(task) && task.itemType === 'event' && task.dueDate).length;
  return { state, summary };
}

module.exports = { snapshot, same, validSchedule, mergeSnapshots, syncCalendar };

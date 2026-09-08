const NATIVE_FIELDS = ['title', 'dueDate', 'completed'];

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function googleTaskLocalSnapshot(task) {
  return {
    title: String(task?.title || '未命名任务'),
    dueDate: String(task?.dueDate || ''),
    completed: Boolean(task?.completed),
  };
}

function googleTaskRemoteSnapshot(remoteTask) {
  return {
    title: String(remoteTask?.title || '未命名任务'),
    dueDate: remoteTask?.due ? String(remoteTask.due).slice(0, 10) : '',
    completed: remoteTask?.status === 'completed',
  };
}

function normalizeSnapshot(value) {
  if (!value) return null;
  return {
    title: String(value.title || '未命名任务'),
    dueDate: String(value.dueDate || ''),
    completed: Boolean(value.completed),
  };
}

function reconcileGoogleTaskNative({ base, local, remote, localChangedHint = false, remoteChangedHint = false }) {
  const normalizedBase = normalizeSnapshot(base);
  const normalizedLocal = normalizeSnapshot(local);
  const normalizedRemote = normalizeSnapshot(remote);
  if (!normalizedLocal || !normalizedRemote) throw new Error('Google Task reconciliation requires local and remote snapshots');

  if (!normalizedBase) {
    if (equal(normalizedLocal, normalizedRemote)) {
      return { action: 'unchanged', merged: normalizedLocal, conflictFields: [] };
    }
    if (localChangedHint && !remoteChangedHint) {
      return { action: 'local', merged: normalizedLocal, conflictFields: [] };
    }
    if (remoteChangedHint && !localChangedHint) {
      return { action: 'remote', merged: normalizedRemote, conflictFields: [] };
    }
    return {
      action: 'conflict',
      type: 'missing-baseline',
      merged: null,
      conflictFields: NATIVE_FIELDS.filter((field) => !equal(normalizedLocal[field], normalizedRemote[field])),
    };
  }

  const merged = { ...normalizedBase };
  const localFields = [];
  const remoteFields = [];
  const conflictFields = [];

  for (const field of NATIVE_FIELDS) {
    const localChanged = !equal(normalizedLocal[field], normalizedBase[field]);
    const remoteChanged = !equal(normalizedRemote[field], normalizedBase[field]);
    if (localChanged) localFields.push(field);
    if (remoteChanged) remoteFields.push(field);

    if (localChanged && remoteChanged && !equal(normalizedLocal[field], normalizedRemote[field])) {
      conflictFields.push(field);
      continue;
    }
    if (localChanged) merged[field] = normalizedLocal[field];
    else if (remoteChanged) merged[field] = normalizedRemote[field];
  }

  if (conflictFields.length) {
    return { action: 'conflict', type: 'both-modified', merged: null, conflictFields };
  }
  if (!localFields.length && !remoteFields.length) return { action: 'unchanged', merged, conflictFields: [] };
  if (localFields.length && remoteFields.length) return { action: 'merge', merged, conflictFields: [] };
  if (localFields.length) return { action: 'local', merged, conflictFields: [] };
  return { action: 'remote', merged, conflictFields: [] };
}

function googleTaskSnapshotEqual(a, b) {
  return equal(normalizeSnapshot(a), normalizeSnapshot(b));
}


const CALENDAR_FIELDS = [
  'title', 'dueDate', 'time', 'endDate', 'endTime',
  'itemType', 'eventColor', 'projectId', 'completed', 'reminder', 'order',
];
const CALENDAR_SCHEDULE_FIELDS = ['dueDate', 'time', 'endDate', 'endTime'];
const DEFAULT_EVENT_COLOR = '#91a9c7';

function normalizeGoogleCalendarSnapshot(value) {
  if (!value) return null;
  const itemType = value.itemType === 'event' ? 'event' : 'todo';
  const dueDate = String(value.dueDate || '');
  const time = String(value.time || '');
  return {
    title: String(value.title || (itemType === 'event' ? '未命名日程' : '未命名待办')),
    dueDate,
    time,
    endDate: itemType === 'event' ? String(value.endDate || dueDate) : '',
    endTime: itemType === 'event' && time ? String(value.endTime || time) : '',
    itemType,
    eventColor: itemType === 'event' && /^#[0-9a-f]{6}$/i.test(value.eventColor || '')
      ? String(value.eventColor).toLowerCase()
      : '',
    projectId: String(value.projectId || 'inbox'),
    completed: itemType === 'todo' && Boolean(value.completed),
    reminder: value.reminder == null ? null : Number(value.reminder),
    order: Number(value.order || 0),
  };
}

function validCalendarSchedule(value) {
  const date = (input) => /^\d{4}-\d{2}-\d{2}$/.test(input)
    && !Number.isNaN(Date.parse(input + 'T12:00:00Z'));
  const time = (input) => /^([01]\d|2[0-3]):[0-5]\d$/.test(input);
  if (!date(value.dueDate) || (value.time && !time(value.time))) return false;
  if (value.itemType !== 'event') return true;
  if (!date(value.endDate) || value.endDate < value.dueDate) return false;
  if (!value.time) return value.endTime === '';
  return time(value.endTime)
    && value.endDate + 'T' + value.endTime >= value.dueDate + 'T' + value.time;
}

function reconcileGoogleCalendar({ base, local, remote, localChangedHint = false, remoteChangedHint = false }) {
  const b = normalizeGoogleCalendarSnapshot(base);
  const l = normalizeGoogleCalendarSnapshot(local);
  const r = normalizeGoogleCalendarSnapshot(remote);
  if (!l || !r) throw new Error('Google Calendar reconciliation requires local and remote snapshots');

  if (!b) {
    if (equal(l, r)) return { action: 'unchanged', merged: l, conflictFields: [] };
    if (localChangedHint && !remoteChangedHint) return { action: 'local', merged: l, conflictFields: [] };
    if (remoteChangedHint && !localChangedHint) return { action: 'remote', merged: r, conflictFields: [] };
    return {
      action: 'conflict',
      type: 'missing-baseline',
      merged: null,
      conflictFields: CALENDAR_FIELDS.filter((field) => !equal(l[field], r[field])),
    };
  }

  const merged = { ...b };
  const localFields = [];
  const remoteFields = [];
  const conflictFields = [];
  for (const field of CALENDAR_FIELDS) {
    const localChanged = !equal(l[field], b[field]);
    const remoteChanged = !equal(r[field], b[field]);
    if (localChanged) localFields.push(field);
    if (remoteChanged) remoteFields.push(field);
    if (localChanged && remoteChanged && !equal(l[field], r[field])) {
      conflictFields.push(field);
      continue;
    }
    if (localChanged) merged[field] = l[field];
    else if (remoteChanged) merged[field] = r[field];
  }

  if (conflictFields.length) return { action: 'conflict', type: 'both-modified', merged: null, conflictFields };

  if (Boolean(l.time) !== Boolean(r.time)
    && CALENDAR_SCHEDULE_FIELDS.some((field) => !equal(l[field], b[field]))
    && CALENDAR_SCHEDULE_FIELDS.some((field) => !equal(r[field], b[field]))) {
    return {
      action: 'conflict',
      type: 'schedule-conflict',
      merged: null,
      conflictFields: CALENDAR_SCHEDULE_FIELDS,
    };
  }

  if (!validCalendarSchedule(merged)) {
    return {
      action: 'conflict',
      type: 'invalid-schedule',
      merged: null,
      conflictFields: CALENDAR_SCHEDULE_FIELDS,
    };
  }

  if (!localFields.length && !remoteFields.length) return { action: 'unchanged', merged, conflictFields: [] };
  if (localFields.length && remoteFields.length) return { action: 'merge', merged, conflictFields: [] };
  if (localFields.length) return { action: 'local', merged, conflictFields: [] };
  return { action: 'remote', merged, conflictFields: [] };
}

function googleCalendarSnapshotEqual(a, b) {
  return equal(normalizeGoogleCalendarSnapshot(a), normalizeGoogleCalendarSnapshot(b));
}


function remoteChangedSinceGoogleSnapshot({
  base,
  remote,
  previousRemoteUpdatedAt = 0,
  remoteUpdatedAt = 0,
  equalSnapshot,
}) {
  if (!remote) return false;
  if (base) return !equalSnapshot(base, remote);
  const previous = Number(previousRemoteUpdatedAt || 0);
  if (!previous) return true;
  return Number(remoteUpdatedAt || 0) > previous;
}

module.exports = {
  NATIVE_FIELDS,
  googleTaskLocalSnapshot,
  googleTaskRemoteSnapshot,
  reconcileGoogleTaskNative,
  googleTaskSnapshotEqual,
  CALENDAR_FIELDS,
  normalizeGoogleCalendarSnapshot,
  reconcileGoogleCalendar,
  googleCalendarSnapshotEqual,
  remoteChangedSinceGoogleSnapshot,
};

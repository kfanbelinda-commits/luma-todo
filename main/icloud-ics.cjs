'use strict';

const DEFAULT_EVENT_COLOR = '#91a9c7';

function icsEscapeText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function compactDateKey(dateKey) {
  return String(dateKey || '').replaceAll('-', '');
}

function nextDateKeyLocal(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function utcIcsDateTime(dateKey, time) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const [hour, minute] = String(time).split(':').map(Number);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return date.getUTCFullYear()
    + String(date.getUTCMonth() + 1).padStart(2, '0')
    + String(date.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(date.getUTCHours()).padStart(2, '0')
    + String(date.getUTCMinutes()).padStart(2, '0')
    + '00Z';
}

function icsStamp(updatedAt) {
  const stamp = new Date(Number(updatedAt || Date.now()));
  return stamp.getUTCFullYear()
    + String(stamp.getUTCMonth() + 1).padStart(2, '0')
    + String(stamp.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(stamp.getUTCHours()).padStart(2, '0')
    + String(stamp.getUTCMinutes()).padStart(2, '0')
    + String(stamp.getUTCSeconds()).padStart(2, '0')
    + 'Z';
}

function summaryLine(task) {
  const title = task.itemType === 'event'
    ? (task.title || '未命名日程')
    : ((task.completed ? '✓ ' : '□ ') + (task.title || '未命名待办'));
  return 'SUMMARY:' + icsEscapeText(title);
}

function scheduleLines(task) {
  if (task.time) {
    const endDate = task.itemType === 'event' ? (task.endDate || task.dueDate) : task.dueDate;
    const endTime = task.itemType === 'event'
      ? (task.endTime || task.time)
      : (() => {
          const [hour, minute] = String(task.time).split(':').map(Number);
          const end = new Date(2000, 0, 1, hour, minute + 30, 0, 0);
          return String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0');
        })();
    return {
      DTSTART: 'DTSTART:' + utcIcsDateTime(task.dueDate, task.time),
      DTEND: 'DTEND:' + utcIcsDateTime(endDate, endTime),
    };
  }
  const endDateInclusive = task.endDate || task.dueDate;
  return {
    DTSTART: 'DTSTART;VALUE=DATE:' + compactDateKey(task.dueDate),
    DTEND: 'DTEND;VALUE=DATE:' + compactDateKey(nextDateKeyLocal(endDateInclusive)),
  };
}

function buildIcloudIcs(task, uid) {
  const updatedAt = Number(task.updatedAt || Date.now());
  const dtstamp = icsStamp(updatedAt);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Luma Todo//iCloud Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + dtstamp,
    'LAST-MODIFIED:' + dtstamp,
    summaryLine(task),
    'X-LUMA-TODO:TRUE',
    'X-LUMA-TASK-ID:' + icsEscapeText(task.id),
    'X-LUMA-ITEM-TYPE:' + (task.itemType === 'event' ? 'event' : 'todo'),
    'X-LUMA-COMPLETED:' + (task.completed ? 'true' : 'false'),
    'X-LUMA-UPDATED-AT:' + updatedAt,
  ];

  if (/^#[0-9a-f]{6}$/i.test(task.eventColor || '')) {
    lines.push('X-LUMA-EVENT-COLOR:' + task.eventColor);
  }
  const schedule = scheduleLines(task);
  lines.push(schedule.DTSTART, schedule.DTEND, 'END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function unfoldIcsLines(ics) {
  return String(ics || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function unescapeIcsText(value) {
  return String(value || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function icsProperty(lines, name) {
  const upper = String(name).toUpperCase();
  const line = lines.find((item) => {
    const head = String(item || '').split(':', 1)[0].toUpperCase();
    return head === upper || head.startsWith(upper + ';');
  });
  if (!line) return null;
  const colon = line.indexOf(':');
  return {
    head: line.slice(0, colon),
    value: line.slice(colon + 1),
  };
}

function localDateKeyFromDate(date) {
  return date.getFullYear()
    + '-' + String(date.getMonth() + 1).padStart(2, '0')
    + '-' + String(date.getDate()).padStart(2, '0');
}

function localTimeFromDate(date) {
  return String(date.getHours()).padStart(2, '0')
    + ':' + String(date.getMinutes()).padStart(2, '0');
}

function parseIcsDateProperty(prop) {
  if (!prop || !prop.value) return null;
  const raw = prop.value.trim();
  const allDay = /(?:^|;)VALUE=DATE(?:;|$)/i.test(prop.head) || /^\d{8}$/.test(raw);
  if (allDay) {
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return null;
    return { allDay: true, dateKey: match[1] + '-' + match[2] + '-' + match[3], time: '' };
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, sec = '00', z] = match;
  const date = z
    ? new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)))
    : new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  return { allDay: false, dateKey: localDateKeyFromDate(date), time: localTimeFromDate(date) };
}

function parseIcloudEventIdentity(ics) {
  const lines = unfoldIcsLines(ics);
  if (!lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VEVENT')) return null;
  return {
    uid: unescapeIcsText(icsProperty(lines, 'UID')?.value || ''),
    title: unescapeIcsText(icsProperty(lines, 'SUMMARY')?.value || ''),
    lumaTaskId: unescapeIcsText(icsProperty(lines, 'X-LUMA-TASK-ID')?.value || ''),
    lumaItemType: String(icsProperty(lines, 'X-LUMA-ITEM-TYPE')?.value || '').toLowerCase(),
    extensionProperties: Object.fromEntries(lines.filter(line => /^X-LUMA-/i.test(line) && !/^X-LUMA-(TASK-ID|ITEM-TYPE|COMPLETED|EVENT-COLOR):/i.test(line)).map(line => {const i=line.indexOf(':'); return [line.slice(0,i).toUpperCase(),line.slice(i+1)];})),
  };
}

function parseIcloudEvent(ics, href, etag, calendar) {
  const lines = unfoldIcsLines(ics);
  const identity = parseIcloudEventIdentity(ics);
  if (!identity) return null;

  const uid = identity.uid;
  const summary = identity.title || '未命名日程';
  const start = parseIcsDateProperty(icsProperty(lines, 'DTSTART'));
  const end = parseIcsDateProperty(icsProperty(lines, 'DTEND'));
  if (!uid || !start) return null;

  const lumaTaskId = unescapeIcsText(icsProperty(lines, 'X-LUMA-TASK-ID')?.value || '');
  const lumaItemType = String(icsProperty(lines, 'X-LUMA-ITEM-TYPE')?.value || '').toLowerCase();
  const lumaCompleted = String(icsProperty(lines, 'X-LUMA-COMPLETED')?.value || '').toLowerCase() === 'true';
  const color = String(icsProperty(lines, 'X-LUMA-EVENT-COLOR')?.value || '');
  const lastModifiedRaw = icsProperty(lines, 'LAST-MODIFIED') || icsProperty(lines, 'DTSTAMP');
  const lastModified = parseIcsDateProperty(lastModifiedRaw);
  const remoteUpdatedAt = lastModified
    ? new Date((lastModified.dateKey || '') + 'T' + (lastModified.time || '00:00') + ':00').getTime()
    : Date.now();

  let endDate = start.dateKey;
  let endTime = '';
  if (start.allDay) {
    if (end?.dateKey) {
      const endExclusive = new Date(end.dateKey + 'T12:00:00');
      endExclusive.setDate(endExclusive.getDate() - 1);
      endDate = localDateKeyFromDate(endExclusive);
    }
  } else if (end) {
    endDate = end.dateKey || start.dateKey;
    endTime = end.time || '';
  }

  return {
    uid,
    href,
    etag,
    title: summary,
    dueDate: start.dateKey,
    time: start.allDay ? '' : start.time,
    endDate,
    endTime,
    lumaTaskId,
    lumaItemType,
    lumaCompleted,
    extensionProperties: identity.extensionProperties || {},
    eventColor: /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_EVENT_COLOR,
    remoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : Date.now(),
    calendarUrl: calendar.url,
    calendarName: calendar.name,
    rawIcs: String(ics || ''),
  };
}

function foldIcsLine(line) {
  const text = String(line || '');
  const result = [];
  let chunk = '';
  let bytes = 0;
  let first = true;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    const limit = first ? 75 : 74;
    if (chunk && bytes + charBytes > limit) {
      result.push((first ? '' : ' ') + chunk);
      first = false;
      chunk = char;
      bytes = charBytes;
    } else {
      chunk += char;
      bytes += charBytes;
    }
  }
  result.push((first ? '' : ' ') + chunk);
  return result;
}

function rawGroups(raw) {
  const source = String(raw || '');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const trailing = source.endsWith(newline);
  const physical = source.split(/\r\n|\n/);
  if (trailing && physical.at(-1) === '') physical.pop();
  const groups = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line) && groups.length) groups.at(-1).lines.push(line);
    else groups.push({ lines: [line] });
  }
  for (const group of groups) {
    group.logical = group.lines[0] + group.lines.slice(1).map((line) => line.slice(1)).join('');
  }
  return { groups, newline, trailing };
}

function propertyName(logical) {
  const colon = String(logical || '').indexOf(':');
  if (colon < 0) return '';
  return String(logical).slice(0, colon).split(';', 1)[0].trim().toUpperCase();
}

function analyzeRawEvent(raw) {
  const parsed = rawGroups(raw);
  const groups = parsed.groups;
  const eventCount = groups.filter((group) => group.logical.trim().toUpperCase() === 'BEGIN:VEVENT').length;
  let primary = false;
  let seenPrimary = false;
  let nested = 0;
  let primaryEnd = -1;
  const rootProperties = new Map();

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const upper = group.logical.trim().toUpperCase();
    if (!primary && upper === 'BEGIN:VEVENT' && !seenPrimary) {
      primary = true;
      seenPrimary = true;
      group.primaryBegin = true;
      continue;
    }
    if (!primary) continue;
    if (upper === 'END:VEVENT' && nested === 0) {
      group.primaryEnd = true;
      primaryEnd = index;
      primary = false;
      continue;
    }
    if (upper.startsWith('BEGIN:')) {
      nested += 1;
      continue;
    }
    if (upper.startsWith('END:')) {
      if (nested > 0) nested -= 1;
      continue;
    }
    if (nested !== 0) continue;
    const name = propertyName(group.logical);
    if (!name) continue;
    group.primaryProperty = name;
    if (!rootProperties.has(name)) rootProperties.set(name, []);
    rootProperties.get(name).push(index);
  }

  return { ...parsed, eventCount, primaryEnd, rootProperties };
}

function taskScheduleSnapshot(task) {
  if (task.itemType === 'event') {
    return {
      dueDate: String(task.dueDate || ''),
      time: String(task.time || ''),
      endDate: String(task.endDate || task.dueDate || ''),
      endTime: task.time ? String(task.endTime || task.time || '') : '',
    };
  }
  return { dueDate: String(task.dueDate || ''), time: String(task.time || '') };
}

function remoteScheduleSnapshot(remote, itemType) {
  if (itemType === 'event') {
    return {
      dueDate: String(remote?.dueDate || ''),
      time: String(remote?.time || ''),
      endDate: String(remote?.endDate || remote?.dueDate || ''),
      endTime: remote?.time ? String(remote?.endTime || remote?.time || '') : '',
    };
  }
  return { dueDate: String(remote?.dueDate || ''), time: String(remote?.time || '') };
}

function samePlain(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function complexScheduleResource(analysis) {
  if (analysis.eventCount !== 1) return true;
  for (const name of ['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID']) {
    if (analysis.rootProperties.has(name)) return true;
  }
  for (const name of ['DTSTART', 'DTEND']) {
    for (const index of analysis.rootProperties.get(name) || []) {
      const head = analysis.groups[index].logical.split(':', 1)[0];
      if (/(?:^|;)TZID=/i.test(head)) return true;
    }
  }
  return false;
}

function patchRawIcs(raw, replacements) {
  const analysis = analyzeRawEvent(raw);
  if (analysis.primaryEnd < 0) {
    const error = new Error('Apple 原始日历内容缺少完整 VEVENT，已停止覆盖');
    error.code = 'ICLOUD_RAW_ICS_INVALID';
    throw error;
  }

  const emitted = new Set();
  const output = [];
  for (const group of analysis.groups) {
    if (group.primaryEnd) {
      for (const [name, line] of replacements) {
        if (emitted.has(name) || line == null) continue;
        output.push(...foldIcsLine(line));
        emitted.add(name);
      }
      output.push(...group.lines);
      continue;
    }

    const name = group.primaryProperty;
    if (name && replacements.has(name)) {
      if (!emitted.has(name)) {
        const line = replacements.get(name);
        if (line != null) output.push(...foldIcsLine(line));
        emitted.add(name);
      }
      continue;
    }
    output.push(...group.lines);
  }

  return output.join(analysis.newline) + (analysis.trailing ? analysis.newline : '');
}

function preserveAppleIcs(task, uid, raw) {
  const identity = parseIcloudEventIdentity(raw);
  if (!identity?.uid) {
    const error = new Error('Apple 原始日历内容缺少 UID，已停止覆盖');
    error.code = 'ICLOUD_RAW_ICS_INVALID';
    throw error;
  }
  if (uid && identity.uid !== uid) {
    const error = new Error('Apple 原始日历 UID 与当前事项不一致，已停止覆盖');
    error.code = 'ICLOUD_RAW_ICS_IDENTITY_MISMATCH';
    throw error;
  }

  const baseline = parseIcloudEvent(raw, '', '', { url: '', name: '' });
  if (!baseline) {
    const error = new Error('Apple 原始日历内容无法建立安全编辑基线，已停止覆盖');
    error.code = 'ICLOUD_RAW_ICS_INVALID';
    throw error;
  }
  const analysis = analyzeRawEvent(raw);
  const scheduleChanged = !samePlain(taskScheduleSnapshot(task), remoteScheduleSnapshot(baseline, task.itemType));
  if (scheduleChanged && complexScheduleResource(analysis)) {
    const error = new Error('Apple 事项包含重复规则、时区或多个 VEVENT；Luma 已停止重写日期时间以保留原始日历结构');
    error.code = 'ICLOUD_COMPLEX_SCHEDULE_EDIT';
    throw error;
  }

  const updatedAt = Number(task.updatedAt || Date.now());
  const replacements = new Map([
    ['SUMMARY', summaryLine(task)],
    ['DTSTAMP', 'DTSTAMP:' + icsStamp(updatedAt)],
    ['LAST-MODIFIED', 'LAST-MODIFIED:' + icsStamp(updatedAt)],
    ['X-LUMA-TODO', 'X-LUMA-TODO:TRUE'],
    ['X-LUMA-TASK-ID', 'X-LUMA-TASK-ID:' + icsEscapeText(task.id)],
    ['X-LUMA-ITEM-TYPE', 'X-LUMA-ITEM-TYPE:' + (task.itemType === 'event' ? 'event' : 'todo')],
    ['X-LUMA-COMPLETED', 'X-LUMA-COMPLETED:' + (task.completed ? 'true' : 'false')],
    ['X-LUMA-UPDATED-AT', 'X-LUMA-UPDATED-AT:' + updatedAt],
    ['X-LUMA-EVENT-COLOR', /^#[0-9a-f]{6}$/i.test(task.eventColor || '') ? 'X-LUMA-EVENT-COLOR:' + task.eventColor : null],
  ]);

  if (!analysis.rootProperties.has('UID')) replacements.set('UID', 'UID:' + uid);
  if (scheduleChanged) {
    const schedule = scheduleLines(task);
    replacements.set('DTSTART', schedule.DTSTART);
    replacements.set('DTEND', schedule.DTEND);
  }
  return patchRawIcs(raw, replacements);
}

function taskToIcloudIcs(task, uid) {
  const raw = String(task?.icloudRawIcs || '');
  return raw ? preserveAppleIcs(task, uid, raw) : buildIcloudIcs(task, uid);
}

module.exports = {
  taskToIcloudIcs,
  parseIcloudEvent,
  parseIcloudEventIdentity,
};

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

function taskToIcloudIcs(task, uid) {
  const updatedAt = Number(task.updatedAt || Date.now());
  const stamp = new Date(updatedAt);
  const dtstamp = stamp.getUTCFullYear()
    + String(stamp.getUTCMonth() + 1).padStart(2, '0')
    + String(stamp.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(stamp.getUTCHours()).padStart(2, '0')
    + String(stamp.getUTCMinutes()).padStart(2, '0')
    + String(stamp.getUTCSeconds()).padStart(2, '0')
    + 'Z';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Luma Todo//iCloud Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + dtstamp,
    'LAST-MODIFIED:' + dtstamp,
    'SUMMARY:' + icsEscapeText(task.itemType === 'event' ? (task.title || '未命名日程') : ((task.completed ? '✓ ' : '□ ') + (task.title || '未命名待办'))),
    'X-LUMA-TODO:TRUE',
    'X-LUMA-TASK-ID:' + icsEscapeText(task.id),
    'X-LUMA-ITEM-TYPE:' + (task.itemType === 'event' ? 'event' : 'todo'),
    'X-LUMA-COMPLETED:' + (task.completed ? 'true' : 'false'),
    'X-LUMA-UPDATED-AT:' + updatedAt
  ];

  if (/^#[0-9a-f]{6}$/i.test(task.eventColor || '')) {
    lines.push('X-LUMA-EVENT-COLOR:' + task.eventColor);
  }

  if (task.time) {
    const endDate = task.itemType === 'event' ? (task.endDate || task.dueDate) : task.dueDate;
    const endTime = task.itemType === 'event'
      ? (task.endTime || task.time)
      : (() => {
          const [hour, minute] = String(task.time).split(':').map(Number);
          const end = new Date(2000, 0, 1, hour, minute + 30, 0, 0);
          return String(end.getHours()).padStart(2, '0') + ':' + String(end.getMinutes()).padStart(2, '0');
        })();
    lines.push('DTSTART:' + utcIcsDateTime(task.dueDate, task.time));
    lines.push('DTEND:' + utcIcsDateTime(endDate, endTime));
  } else {
    const endDateInclusive = task.endDate || task.dueDate;
    lines.push('DTSTART;VALUE=DATE:' + compactDateKey(task.dueDate));
    lines.push('DTEND;VALUE=DATE:' + compactDateKey(nextDateKeyLocal(endDateInclusive)));
  }

  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function lifelogExcerpt(note) {
  const compact = String(note || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '日记';
  return compact.length > 24 ? compact.slice(0, 24) + '…' : compact;
}

function lifelogHasContent(entry) {
  return Boolean(entry && (
    String(entry.note || '').trim()
    || entry.mood
    || entry.weather
    || (Array.isArray(entry.photos) && entry.photos.length)
  ));
}

function lifelogToIcloudIcs(entry, dateKey, uid) {
  const updatedAt = Number(entry && entry.updatedAt || Date.now());
  const stamp = new Date(updatedAt);
  const dtstamp = stamp.getUTCFullYear()
    + String(stamp.getUTCMonth() + 1).padStart(2, '0')
    + String(stamp.getUTCDate()).padStart(2, '0')
    + 'T'
    + String(stamp.getUTCHours()).padStart(2, '0')
    + String(stamp.getUTCMinutes()).padStart(2, '0')
    + String(stamp.getUTCSeconds()).padStart(2, '0')
    + 'Z';
  const note = String(entry && entry.note || '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Luma Todo//iCloud Calendar//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + dtstamp,
    'LAST-MODIFIED:' + dtstamp,
    'SUMMARY:' + icsEscapeText(lifelogExcerpt(note)),
    'DESCRIPTION:' + icsEscapeText(note),
    'X-LUMA-TODO:TRUE',
    'X-LUMA-ITEM-TYPE:lifelog',
    'X-LUMA-DATE:' + String(dateKey || ''),
    'X-LUMA-UPDATED-AT:' + updatedAt,
    'DTSTART;VALUE=DATE:' + compactDateKey(dateKey),
    'DTEND;VALUE=DATE:' + compactDateKey(nextDateKeyLocal(dateKey))
  ];
  if (entry && entry.mood) lines.push('X-LUMA-LIFELOG-MOOD:' + icsEscapeText(entry.mood));
  if (entry && entry.weather) lines.push('X-LUMA-LIFELOG-WEATHER:' + icsEscapeText(entry.weather));
  lines.push('END:VEVENT', 'END:VCALENDAR', '');
  return lines.join('\r\n');
}

function mergeLifelogFromRemote(local, remote) {
  const current = local && typeof local === 'object' ? local : {};
  const photos = Array.isArray(current.photos) ? current.photos.slice() : [];
  const localNote = String(current.note || '');
  return {
    weather: current.weather || remote.weather || '',
    mood: current.mood || remote.mood || '',
    note: localNote.trim() ? current.note : String(remote.note || ''),
    photos,
    coverPhotoId: current.coverPhotoId || null,
    updatedAt: Number(current.updatedAt || 0) || Number(remote.remoteUpdatedAt || Date.now()),
    icloudHref: remote.href || current.icloudHref || '',
    icloudUid: remote.uid || current.icloudUid || '',
    icloudEtag: remote.etag || current.icloudEtag || '',
    lastIcloudEtag: remote.etag || current.lastIcloudEtag || ''
  };
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

function parseIcloudEvent(ics, href, etag, calendar) {
  const lines = unfoldIcsLines(ics);
  if (!lines.some((line) => line.trim().toUpperCase() === 'BEGIN:VEVENT')) return null;

  const uid = unescapeIcsText(icsProperty(lines, 'UID')?.value || '');
  const summary = unescapeIcsText(icsProperty(lines, 'SUMMARY')?.value || '未命名日程');
  const start = parseIcsDateProperty(icsProperty(lines, 'DTSTART'));
  const end = parseIcsDateProperty(icsProperty(lines, 'DTEND'));
  if (!uid || !start) return null;

  const lumaTaskId = unescapeIcsText(icsProperty(lines, 'X-LUMA-TASK-ID')?.value || '');
  const lumaItemType = String(icsProperty(lines, 'X-LUMA-ITEM-TYPE')?.value || '').toLowerCase();
  const lumaCompleted = String(icsProperty(lines, 'X-LUMA-COMPLETED')?.value || '').toLowerCase() === 'true';
  const lumaDate = unescapeIcsText(icsProperty(lines, 'X-LUMA-DATE')?.value || '');
  const lifelogMood = unescapeIcsText(icsProperty(lines, 'X-LUMA-LIFELOG-MOOD')?.value || '');
  const lifelogWeather = unescapeIcsText(icsProperty(lines, 'X-LUMA-LIFELOG-WEATHER')?.value || '');
  const description = unescapeIcsText(icsProperty(lines, 'DESCRIPTION')?.value || '');
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
    lumaDate,
    lifelogMood,
    lifelogWeather,
    note: lumaItemType === 'lifelog' ? description : '',
    eventColor: /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_EVENT_COLOR,
    remoteUpdatedAt: Number.isFinite(remoteUpdatedAt) ? remoteUpdatedAt : Date.now(),
    calendarUrl: calendar.url,
    calendarName: calendar.name,
  };
}

module.exports = {
  taskToIcloudIcs,
  parseIcloudEvent,
  lifelogToIcloudIcs,
  lifelogHasContent,
  mergeLifelogFromRemote,
};

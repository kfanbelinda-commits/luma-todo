function errorText(error) {
  return String(error?.message || error || 'Google API 请求失败');
}

async function collectGoogleCalendarReads(calendars, readCalendar) {
  const results = await Promise.all((calendars || []).map(async (calendar) => {
    try {
      const [windowEvents, lumaEvents] = await Promise.all([
        readCalendar(calendar, false),
        readCalendar(calendar, true),
      ]);
      return { calendar, events: [...(windowEvents || []), ...(lumaEvents || [])], error: null };
    } catch (error) {
      return { calendar, events: [], error: errorText(error) };
    }
  }));

  const events = [];
  const failedCalendarIds = new Set();
  const failures = [];
  for (const result of results) {
    if (result.error) {
      failedCalendarIds.add(String(result.calendar?.id || 'primary'));
      failures.push({
        calendarId: String(result.calendar?.id || 'primary'),
        calendarName: String(result.calendar?.summaryOverride || result.calendar?.summary || result.calendar?.id || 'Google Calendar'),
        error: result.error,
      });
      continue;
    }
    events.push(...result.events);
  }
  return { events, failedCalendarIds, failures };
}

function chooseDuplicateKeeper(group, linkedKey, remoteKey, updatedAt) {
  if (linkedKey) {
    const linked = group.find((item) => remoteKey(item) === linkedKey);
    if (linked) return linked;
  }
  return [...group].sort((a, b) => Number(updatedAt(b) || 0) - Number(updatedAt(a) || 0))[0];
}

// Suppress every extra copy from the current sync view so duplicates never
// create extra local items. Only exact-equivalent Luma-owned copies are safe to
// delete automatically; divergent copies are left untouched for inspection.
function classifyLumaDuplicates(items, {
  taskId,
  remoteKey,
  linkedKeyByTaskId = new Map(),
  fingerprint,
  updatedAt = () => 0,
}) {
  const groups = new Map();
  const passthrough = [];
  for (const item of items || []) {
    const id = String(taskId(item) || '');
    if (!id) {
      passthrough.push(item);
      continue;
    }
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }

  const kept = [...passthrough];
  const safeDuplicates = [];
  const divergentDuplicates = [];
  for (const [id, group] of groups) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const keeper = chooseDuplicateKeeper(
      group,
      linkedKeyByTaskId.get(id) || '',
      remoteKey,
      updatedAt
    );
    kept.push(keeper);
    const keeperFingerprint = fingerprint(keeper);
    for (const item of group) {
      if (item === keeper) continue;
      const record = { taskId: id, keeper, duplicate: item };
      if (fingerprint(item) === keeperFingerprint) safeDuplicates.push(record);
      else divergentDuplicates.push(record);
    }
  }
  return { kept, safeDuplicates, divergentDuplicates };
}

module.exports = {
  collectGoogleCalendarReads,
  classifyLumaDuplicates,
};

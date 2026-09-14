'use strict';

function sourceProvider(item) {
  const explicit = String(item?.sourceProvider || '').toLowerCase();
  if (['luma', 'apple', 'google'].includes(explicit)) return explicit;
  if (item?.icloudExternal) return 'apple';
  if (item?.googleCalendarExternal || item?.syncTarget === 'external-calendar') return 'google';
  return 'luma';
}

function googleIdentity(item) {
  return {
    taskId: String(item?.googleTaskId || ''),
    eventId: String(item?.googleCalendarEventId || ''),
    calendarId: String(item?.googleCalendarId || ''),
    etag: String(item?.googleCalendarEtag || ''),
  };
}

function appleIdentity(item) {
  return {
    href: String(item?.icloudHref || item?.icloudPendingHref || ''),
    uid: String(item?.icloudUid || item?.icloudPendingUid || ''),
    etag: String(item?.lastIcloudEtag || item?.icloudEtag || ''),
    calendarUrl: String(item?.icloudCalendarUrl || ''),
  };
}

function hasGoogleIdentity(item) {
  const id = googleIdentity(item);
  return Boolean(id.taskId || id.eventId);
}

function hasAppleIdentity(item) {
  const id = appleIdentity(item);
  return Boolean(id.href || id.uid);
}

function crossProviderAmbiguous(item) {
  const source = sourceProvider(item);
  return (source === 'apple' && hasGoogleIdentity(item))
    || (source === 'google' && hasAppleIdentity(item));
}

function protectedFromGoogle(item) {
  return sourceProvider(item) === 'apple';
}

function protectedFromApple(item) {
  return sourceProvider(item) === 'google';
}

function queueTask(entry) {
  return entry?.task && typeof entry.task === 'object' ? entry.task : null;
}

function queueOwnershipProbe(entry) {
  const item = queueTask(entry);
  return item ? { ...(entry || {}), ...item } : entry;
}

function protectGoogleDispatch(input) {
  const state = structuredClone(input || {});
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.googleDeletedItems = Array.isArray(state.googleDeletedItems) ? state.googleDeletedItems : [];

  const protectedTasks = [];
  const protectedTaskIds = new Set();
  const protectedEventIds = new Set();
  const protectedGoogleTaskIds = new Set();

  state.tasks = state.tasks.map((item) => {
    if (!protectedFromGoogle(item)) return item;
    const original = structuredClone(item);
    protectedTasks.push(original);
    protectedTaskIds.add(String(item.id || ''));
    const identity = googleIdentity(item);
    if (identity.eventId) protectedEventIds.add(identity.eventId);
    if (identity.taskId) protectedGoogleTaskIds.add(identity.taskId);

    // Keep the identity visible to duplicate classification while making the
    // item ineligible for Calendar/Tasks mutation. The original Apple-source
    // record is restored byte-for-byte after Google returns.
    return {
      ...item,
      sourceProvider: 'apple',
      syncTarget: 'provider-protected',
      googleCalendarExternal: false,
      providerSyncProtected: 'apple-source',
    };
  });

  const protectedDeletes = [];
  state.googleDeletedItems = state.googleDeletedItems.filter((entry) => {
    const item = queueTask(entry);
    if (!item || !protectedFromGoogle(item)) return true;
    protectedDeletes.push(structuredClone(entry));
    if (item.id) protectedTaskIds.add(String(item.id));
    const identity = googleIdentity({ ...item, ...entry });
    if (identity.eventId) protectedEventIds.add(identity.eventId);
    if (identity.taskId) protectedGoogleTaskIds.add(identity.taskId);
    return false;
  });

  return {
    state,
    protection: {
      protectedTasks,
      protectedDeletes,
      protectedTaskIds,
      protectedEventIds,
      protectedGoogleTaskIds,
    },
  };
}

function restoreGoogleProtected(originalState, returnedState, protection) {
  const result = structuredClone(returnedState || {});
  result.tasks = Array.isArray(result.tasks) ? result.tasks : [];
  result.googleDeletedItems = Array.isArray(result.googleDeletedItems) ? result.googleDeletedItems : [];

  const taskIds = protection?.protectedTaskIds || new Set();
  const eventIds = protection?.protectedEventIds || new Set();
  const googleTaskIds = protection?.protectedGoogleTaskIds || new Set();
  const conflictsWithProtected = (item) => taskIds.has(String(item?.id || ''))
    || eventIds.has(String(item?.googleCalendarEventId || ''))
    || googleTaskIds.has(String(item?.googleTaskId || ''));

  result.tasks = result.tasks.filter((item) => !conflictsWithProtected(item));
  for (const item of protection?.protectedTasks || []) result.tasks.push(structuredClone(item));

  const queueKey = (entry) => [
    String(entry?.source || ''),
    String(entry?.googleCalendarId || ''),
    String(entry?.googleCalendarEventId || ''),
    String(entry?.googleTaskId || ''),
    String(entry?.task?.id || ''),
  ].join('\n');
  const protectedQueueKeys = new Set((protection?.protectedDeletes || []).map(queueKey));
  result.googleDeletedItems = result.googleDeletedItems.filter((entry) => !protectedQueueKeys.has(queueKey(entry)));
  for (const entry of protection?.protectedDeletes || []) {
    const copy = structuredClone(entry);
    copy.googleSyncError = copy.googleSyncError || 'Apple 来源事项的 Google 关联待核实，未执行跨来源删除';
    copy.providerSyncProtected = 'apple-source';
    result.googleDeletedItems.push(copy);
  }

  // A provider cannot drop another provider's system project merely because
  // its own returned state omitted all protected records.
  const originalProjects = Array.isArray(originalState?.projects) ? originalState.projects : [];
  result.projects = Array.isArray(result.projects) ? result.projects : [];
  for (const id of ['apple-calendar']) {
    const project = originalProjects.find((item) => item?.id === id);
    if (project && !result.projects.some((item) => item?.id === id)) result.projects.push(structuredClone(project));
  }
  return result;
}

function protectAppleDispatch(input) {
  const state = structuredClone(input || {});
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  state.icloudDeletedItems = Array.isArray(state.icloudDeletedItems) ? state.icloudDeletedItems : [];

  const protectedTasks = [];
  const protectedDeletes = [];
  const protectedTaskIds = new Set();
  const protectedHrefs = new Set();
  const protectedUids = new Set();

  const remember = (item) => {
    if (!item) return;
    if (item.id) protectedTaskIds.add(String(item.id));
    const identity = appleIdentity(item);
    if (identity.href) protectedHrefs.add(identity.href);
    if (identity.uid) protectedUids.add(identity.uid);
  };

  state.tasks = state.tasks.filter((item) => {
    if (!protectedFromApple(item)) return true;
    const original = structuredClone(item);
    protectedTasks.push(original);
    remember(original);
    return false;
  });

  state.icloudDeletedItems = state.icloudDeletedItems.filter((entry) => {
    const probe = queueOwnershipProbe(entry);
    if (!probe || !protectedFromApple(probe)) return true;
    const original = structuredClone(entry);
    protectedDeletes.push(original);
    remember(probe);
    return false;
  });

  return {
    state,
    protection: {
      protectedTasks,
      protectedDeletes,
      protectedTaskIds,
      protectedHrefs,
      protectedUids,
    },
  };
}

function restoreAppleProtected(originalState, returnedState, protection) {
  const result = structuredClone(returnedState || {});
  result.tasks = Array.isArray(result.tasks) ? result.tasks : [];
  result.icloudDeletedItems = Array.isArray(result.icloudDeletedItems) ? result.icloudDeletedItems : [];

  const taskIds = protection?.protectedTaskIds || new Set();
  const hrefs = protection?.protectedHrefs || new Set();
  const uids = protection?.protectedUids || new Set();
  const conflictsWithProtected = (item) => {
    if (!item) return false;
    const identity = appleIdentity(item);
    return taskIds.has(String(item.id || ''))
      || Boolean(identity.href && hrefs.has(identity.href))
      || Boolean(identity.uid && uids.has(identity.uid));
  };

  // A REPORT result may re-import a protected Google-source Apple residue as a
  // fresh Apple item. Suppress that duplicate before restoring the original.
  result.tasks = result.tasks.filter((item) => !conflictsWithProtected(item));
  for (const item of protection?.protectedTasks || []) result.tasks.push(structuredClone(item));

  const queueKey = (entry) => [
    String(entry?.calendarUrl || ''),
    String(entry?.href || ''),
    String(entry?.uid || ''),
    String(entry?.task?.id || ''),
  ].join('\n');
  const protectedQueueKeys = new Set((protection?.protectedDeletes || []).map(queueKey));
  result.icloudDeletedItems = result.icloudDeletedItems.filter((entry) => {
    if (protectedQueueKeys.has(queueKey(entry))) return false;
    return !conflictsWithProtected(queueOwnershipProbe(entry));
  });
  // Keep deletion intent byte-for-byte. Ownership isolation means Apple must
  // not consume or rewrite another provider's queued operation.
  for (const entry of protection?.protectedDeletes || []) result.icloudDeletedItems.push(structuredClone(entry));

  const originalProjects = Array.isArray(originalState?.projects) ? originalState.projects : [];
  result.projects = Array.isArray(result.projects) ? result.projects : [];
  for (const id of ['google-calendar']) {
    const project = originalProjects.find((item) => item?.id === id);
    if (project && !result.projects.some((item) => item?.id === id)) result.projects.push(structuredClone(project));
  }
  return result;
}

function wrapAppleSyncEngine(syncCalendar) {
  if (typeof syncCalendar !== 'function') throw new TypeError('Apple sync engine must be a function');
  const wrapped = async (state, calendar, io) => {
    const originalState = structuredClone(state || {});
    const prepared = protectAppleDispatch(originalState);
    const result = await syncCalendar(prepared.state, calendar, io);
    if (result?.state) {
      result.state = restoreAppleProtected(originalState, result.state, prepared.protection);
    }
    if (result?.summary) {
      result.summary.providerProtected = prepared.protection.protectedTasks.length
        + prepared.protection.protectedDeletes.length;
    }
    return result;
  };
  Object.defineProperty(wrapped, '__lumaAppleOwnershipBoundary', { value: true });
  return wrapped;
}

function installAppleOwnershipBoundary() {
  const module = require('./icloud-sync.cjs');
  if (typeof module.syncCalendar !== 'function') throw new Error('Apple sync engine is unavailable');
  if (module.syncCalendar.__lumaAppleOwnershipBoundary) return module.syncCalendar;
  module.syncCalendar = wrapAppleSyncEngine(module.syncCalendar);
  return module.syncCalendar;
}

module.exports = {
  sourceProvider,
  googleIdentity,
  appleIdentity,
  hasGoogleIdentity,
  hasAppleIdentity,
  crossProviderAmbiguous,
  protectedFromGoogle,
  protectedFromApple,
  protectGoogleDispatch,
  restoreGoogleProtected,
  protectAppleDispatch,
  restoreAppleProtected,
  wrapAppleSyncEngine,
  installAppleOwnershipBoundary,
};

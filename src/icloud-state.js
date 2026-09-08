(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumaIcloudState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const queueKey = (item) => item.calendarUrl + '\n' + item.href;
  const syncField = (key) => key.startsWith('icloud') || key.startsWith('lastIcloud');

  function mergeItem(before, current, returned) {
    const merged = { ...returned };
    for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
      if (syncField(key) || equal(before[key], current[key])) continue;
      if (Object.hasOwn(current, key)) merged[key] = structuredClone(current[key]);
      else delete merged[key];
    }
    return merged;
  }

  // The network response describes the state at dispatch time. Keep all edits
  // made after dispatch, while retaining successful remote links and baselines.
  function mergeResult(before, current, returned) {
    const result = structuredClone(current);
    const oldTasks = new Map(before.tasks.map((task) => [task.id, task]));
    const nowTasks = new Map(current.tasks.map((task) => [task.id, task]));
    const syncedTasks = new Map(returned.tasks.map((task) => [task.id, task]));
    result.tasks = current.tasks.flatMap((task) => {
      const old = oldTasks.get(task.id);
      const synced = syncedTasks.get(task.id);
      if (!old) return [structuredClone(task)];
      if (synced) return [mergeItem(old, task, synced)];
      // Apple deleted the dispatched version, but newer local work still exists.
      return equal(old, task) ? [] : [structuredClone(task)];
    });
    for (const task of returned.tasks) {
      if (!oldTasks.has(task.id) && !nowTasks.has(task.id)) result.tasks.push(structuredClone(task));
    }
    const oldQueue = new Map((before.icloudDeletedItems || []).map((item) => [queueKey(item), item]));
    const nowQueue = new Map((current.icloudDeletedItems || []).map((item) => [queueKey(item), item]));
    const syncedQueue = new Map((returned.icloudDeletedItems || []).map((item) => [queueKey(item), item]));
    const queue = new Map();
    for (const [key, entry] of nowQueue) {
      if (!oldQueue.has(key) || !equal(entry, oldQueue.get(key))) queue.set(key, structuredClone(entry));
      else if (syncedQueue.has(key)) queue.set(key, structuredClone(syncedQueue.get(key)));
    }
    for (const [key, entry] of syncedQueue) {
      if (!oldQueue.has(key) && !nowQueue.has(key)) queue.set(key, structuredClone(entry));
    }
    // A previously unlinked task can be deleted while its first upload succeeds.
    // Record that new remote resource for deletion instead of resurrecting it.
    for (const [id, old] of oldTasks) {
      if (nowTasks.has(id)) continue;
      const synced = syncedTasks.get(id);
      const href = synced?.icloudHref || synced?.icloudPendingHref;
      if (!href || !synced.icloudCalendarUrl) continue;
      const existing = [...queue.values()].find((item) => item.task?.id === id || item.href === old.icloudHref);
      if (existing) queue.delete(queueKey(existing));
      const fields = old.itemType === 'event'
        ? ['title', 'dueDate', 'time', 'endDate', 'endTime', 'eventColor']
        : ['title', 'dueDate', 'time', 'completed'];
      const remoteEdited = fields.some((key) => !equal(old[key] ?? '', synced[key] ?? ''));
      // Deletion was requested before the user saw newly downloaded edits.
      // Do not acknowledge those unseen edits as a safe deletion baseline.
      const baseline = remoteEdited ? old : synced;
      const entry = {
        ...existing,
        href, uid: synced.icloudUid || synced.icloudPendingUid || '',
        calendarUrl: synced.icloudCalendarUrl, itemType: synced.itemType,
        etag: baseline.lastIcloudEtag || baseline.icloudEtag || '',
        lastIcloudSnapshot: baseline.lastIcloudSnapshot || null,
        task: { ...synced, ...(existing?.task || old) },
        deletedAt: existing?.deletedAt || Date.now(),
      };
      if (synced.icloudConflict) entry.icloudConflict = { ...synced.icloudConflict, local: null };
      queue.set(queueKey(entry), entry);
    }
    result.icloudDeletedItems = [...queue.values()];
    // Sync only adds the Apple system project. Keep concurrent category edits.
    const oldProjects = new Set(before.projects.map((project) => project.id));
    for (const project of returned.projects) {
      if (!oldProjects.has(project.id) && !result.projects.some((item) => item.id === project.id)) {
        result.projects.push(structuredClone(project));
      }
    }
    return result;
  }
  return { mergeResult };
});

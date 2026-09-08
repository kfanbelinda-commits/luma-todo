(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LumaGoogleState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const syncField = (key) => key.startsWith('google') || key.startsWith('lastGoogle');

  function mergeItem(before, current, returned) {
    const merged = { ...returned };
    for (const key of new Set([...Object.keys(before || {}), ...Object.keys(current || {})])) {
      if (syncField(key) || equal(before?.[key], current?.[key])) continue;
      if (Object.hasOwn(current, key)) merged[key] = structuredClone(current[key]);
      else delete merged[key];
    }
    return merged;
  }

  function queueKey(item) {
    const taskId = item?.task?.id || '';
    return [
      item?.source || '',
      item?.googleCalendarId || '',
      item?.googleCalendarEventId || '',
      item?.googleTaskId || '',
      taskId,
    ].join('\n');
  }

  function mergeQueue(beforeQueue, currentQueue, returnedQueue) {
    const oldQueue = new Map((beforeQueue || []).map((item) => [queueKey(item), item]));
    const nowQueue = new Map((currentQueue || []).map((item) => [queueKey(item), item]));
    const syncedQueue = new Map((returnedQueue || []).map((item) => [queueKey(item), item]));
    const merged = new Map();

    for (const [key, entry] of nowQueue) {
      const old = oldQueue.get(key);
      if (!old || !equal(entry, old)) merged.set(key, structuredClone(entry));
      else if (syncedQueue.has(key)) merged.set(key, structuredClone(syncedQueue.get(key)));
    }
    for (const [key, entry] of syncedQueue) {
      if (!oldQueue.has(key) && !nowQueue.has(key)) merged.set(key, structuredClone(entry));
    }
    return merged;
  }

  function mergeProjects(before, current, returned) {
    const old = new Map((before || []).map((item) => [item.id, item]));
    const now = new Map((current || []).map((item) => [item.id, item]));
    const synced = new Map((returned || []).map((item) => [item.id, item]));
    const result = [];

    for (const project of current || []) {
      const previous = old.get(project.id);
      const remote = synced.get(project.id);
      if (!previous) {
        result.push(structuredClone(project));
        continue;
      }
      if (!remote) {
        if (!equal(previous, project)) result.push(structuredClone(project));
        continue;
      }
      result.push(equal(previous, project) ? structuredClone(remote) : structuredClone(project));
    }
    for (const project of returned || []) {
      if (!old.has(project.id) && !now.has(project.id)) result.push(structuredClone(project));
    }
    return result;
  }

  // The network response is based on the state sent at dispatch time. Keep
  // edits made after dispatch while accepting Google links/remote snapshots
  // and remote-only imports from the completed sync.
  function mergeResult(before, current, returned) {
    const result = structuredClone(current);
    const oldTasks = new Map((before.tasks || []).map((task) => [task.id, task]));
    const nowTasks = new Map((current.tasks || []).map((task) => [task.id, task]));
    const syncedTasks = new Map((returned.tasks || []).map((task) => [task.id, task]));

    result.tasks = (current.tasks || []).flatMap((task) => {
      const old = oldTasks.get(task.id);
      const synced = syncedTasks.get(task.id);
      if (!old) return [structuredClone(task)];
      if (synced) return [mergeItem(old, task, synced)];
      // Google removed the dispatched version. A newer local edit must survive.
      return equal(old, task) ? [] : [structuredClone(task)];
    });

    for (const task of returned.tasks || []) {
      if (!oldTasks.has(task.id) && !nowTasks.has(task.id)) result.tasks.push(structuredClone(task));
    }

    const queue = mergeQueue(
      before.googleDeletedItems || [],
      current.googleDeletedItems || [],
      returned.googleDeletedItems || []
    );

    // A task can be deleted locally while its first remote upload is in flight.
    // If that upload succeeds, convert the new remote identity into a pending
    // deletion instead of resurrecting the task locally.
    for (const [id, old] of oldTasks) {
      if (nowTasks.has(id)) continue;
      const synced = syncedTasks.get(id);
      if (!synced) continue;
      const hasRemote = synced.googleTaskId || synced.googleCalendarEventId;
      if (!hasRemote) continue;

      for (const [key, entry] of queue) {
        if (entry?.task?.id === id) queue.delete(key);
      }

      const entry = {
        source: synced.googleCalendarEventId ? 'calendar' : 'tasks',
        googleTaskId: String(synced.googleTaskId || ''),
        googleCalendarEventId: String(synced.googleCalendarEventId || ''),
        googleCalendarId: String(synced.googleCalendarId || ''),
        deletedAt: Date.now(),
        task: { ...structuredClone(synced), ...structuredClone(old) },
        googleSyncError: '',
      };
      queue.set(queueKey(entry), entry);
    }

    result.googleDeletedItems = [...queue.values()];
    result.projects = mergeProjects(before.projects || [], current.projects || [], returned.projects || []);
    result.projectsUpdatedAt = equal(before.projects, current.projects)
      ? Number(returned.projectsUpdatedAt || current.projectsUpdatedAt || 0)
      : Number(current.projectsUpdatedAt || 0);
    return result;
  }

  return { mergeResult };
});

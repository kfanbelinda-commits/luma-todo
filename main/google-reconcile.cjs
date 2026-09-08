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

module.exports = {
  NATIVE_FIELDS,
  googleTaskLocalSnapshot,
  googleTaskRemoteSnapshot,
  reconcileGoogleTaskNative,
  googleTaskSnapshotEqual,
};

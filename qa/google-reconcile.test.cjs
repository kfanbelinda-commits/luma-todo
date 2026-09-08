const test = require('node:test');
const assert = require('node:assert/strict');
const {
  googleTaskLocalSnapshot,
  googleTaskRemoteSnapshot,
  reconcileGoogleTaskNative,
} = require('../main/google-reconcile.cjs');

const base = { title: '报销', dueDate: '2026-09-10', completed: false };

test('Google Task snapshots contain only native shared fields', () => {
  assert.deepEqual(googleTaskLocalSnapshot({
    title: '报销', dueDate: '2026-09-10', completed: false,
    time: '09:30', projectId: 'work', reminder: 15, order: 9,
  }), base);
  assert.deepEqual(googleTaskRemoteSnapshot({
    title: '报销', due: '2026-09-10T00:00:00.000Z', status: 'needsAction',
    notes: 'user notes',
  }), base);
});

test('remote-only Google Task edit pulls', () => {
  const result = reconcileGoogleTaskNative({
    base,
    local: base,
    remote: { ...base, dueDate: '2026-09-11' },
  });
  assert.equal(result.action, 'remote');
  assert.equal(result.merged.dueDate, '2026-09-11');
});

test('local-only Google Task edit pushes', () => {
  const result = reconcileGoogleTaskNative({
    base,
    local: { ...base, title: '差旅报销' },
    remote: base,
  });
  assert.equal(result.action, 'local');
  assert.equal(result.merged.title, '差旅报销');
});

test('different native fields merge without conflict', () => {
  const result = reconcileGoogleTaskNative({
    base,
    local: { ...base, title: '差旅报销' },
    remote: { ...base, completed: true },
  });
  assert.equal(result.action, 'merge');
  assert.deepEqual(result.merged, { title: '差旅报销', dueDate: '2026-09-10', completed: true });
});

test('same native field changed differently becomes conflict', () => {
  const result = reconcileGoogleTaskNative({
    base,
    local: { ...base, title: '差旅报销' },
    remote: { ...base, title: '费用报销' },
  });
  assert.equal(result.action, 'conflict');
  assert.equal(result.type, 'both-modified');
  assert.deepEqual(result.conflictFields, ['title']);
});

test('same final value on both sides is not a conflict', () => {
  const result = reconcileGoogleTaskNative({
    base,
    local: { ...base, completed: true },
    remote: { ...base, completed: true },
  });
  assert.equal(result.action, 'merge');
  assert.equal(result.merged.completed, true);
});

test('missing baseline accepts one clearly changed side', () => {
  assert.equal(reconcileGoogleTaskNative({
    base: null,
    local: base,
    remote: { ...base, title: 'Google edit' },
    localChangedHint: false,
    remoteChangedHint: true,
  }).action, 'remote');

  assert.equal(reconcileGoogleTaskNative({
    base: null,
    local: { ...base, title: 'Luma edit' },
    remote: base,
    localChangedHint: true,
    remoteChangedHint: false,
  }).action, 'local');
});

test('missing baseline freezes ambiguous mismatch', () => {
  const result = reconcileGoogleTaskNative({
    base: null,
    local: { ...base, title: 'Luma edit' },
    remote: { ...base, title: 'Google edit' },
    localChangedHint: true,
    remoteChangedHint: true,
  });
  assert.equal(result.action, 'conflict');
  assert.equal(result.type, 'missing-baseline');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_PREFIX,
  parseGoogleTaskNotes,
  buildGoogleTaskNotes,
} = require('../main/google-task-notes.cjs');

test('legacy Luma JSON metadata remains readable', () => {
  const metadata = { version: 3, taskId: 'one', time: '09:30' };
  const parsed = parseGoogleTaskNotes(LEGACY_PREFIX + JSON.stringify(metadata));
  assert.deepEqual(parsed.metadata, metadata);
  assert.equal(parsed.userNotes, '');
});

test('v4 metadata preserves Google Task user notes', () => {
  const notes = buildGoogleTaskNotes('Call supplier\nBring invoice', { version: 4, taskId: 'one' });
  const parsed = parseGoogleTaskNotes(notes);
  assert.equal(parsed.userNotes, 'Call supplier\nBring invoice');
  assert.equal(parsed.metadata.taskId, 'one');
  const updated = buildGoogleTaskNotes(notes, { version: 4, taskId: 'one', time: '10:00' });
  assert.equal(parseGoogleTaskNotes(updated).userNotes, 'Call supplier\nBring invoice');
  assert.equal(parseGoogleTaskNotes(updated).metadata.time, '10:00');
});

test('missing metadata is treated as user notes rather than discarded', () => {
  const parsed = parseGoogleTaskNotes('ordinary Google Task note');
  assert.equal(parsed.metadata, null);
  assert.equal(parsed.userNotes, 'ordinary Google Task note');
  const repaired = buildGoogleTaskNotes('ordinary Google Task note', { version: 4, taskId: 'one' });
  assert.equal(parseGoogleTaskNotes(repaired).userNotes, 'ordinary Google Task note');
});

test('invalid v4 block preserves surrounding user notes and can be repaired', () => {
  const broken = 'keep me\n\n[Luma Todo Metadata v4]\n{broken}\n[/Luma Todo Metadata]';
  const parsed = parseGoogleTaskNotes(broken);
  assert.equal(parsed.metadata, null);
  assert.equal(parsed.userNotes, 'keep me');
  const repaired = buildGoogleTaskNotes(broken, { version: 4, taskId: 'one' });
  assert.equal(parseGoogleTaskNotes(repaired).userNotes, 'keep me');
  assert.equal(parseGoogleTaskNotes(repaired).metadata.taskId, 'one');
});

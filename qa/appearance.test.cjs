'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('../src/appearance.js');

test('legacy settings and old backups retain their light/dark appearance', () => {
  assert.deepEqual(normalize(), { palette: 'graphite', lightMode: false });
  assert.deepEqual(normalize({ lightMode: true }), { palette: 'paper', lightMode: true });
  assert.deepEqual(normalize({ lightMode: false }), { palette: 'graphite', lightMode: false });
});

test('saved palette is authoritative and keeps the compatibility flag aligned', () => {
  for (const [palette, lightMode] of [['graphite', false], ['paper', true], ['warm', true], ['dusk', false]]) {
    assert.deepEqual(normalize({ palette, lightMode: !lightMode }), { palette, lightMode });
    assert.deepEqual(normalize(JSON.parse(JSON.stringify({ palette, lightMode }))), { palette, lightMode });
  }
});

test('unknown and inherited palette names fall back safely', () => {
  for (const palette of ['unknown', '__proto__', 'constructor', null]) {
    assert.deepEqual(normalize({ palette, lightMode: true }), { palette: 'paper', lightMode: true });
    assert.deepEqual(normalize({ palette, lightMode: false }), { palette: 'graphite', lightMode: false });
  }
});

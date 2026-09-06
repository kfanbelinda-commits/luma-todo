'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the real drag handlers, replacing only boot/render and the DOM.
const source = fs.readFileSync(path.join(__dirname, '../src/week-view.js'), 'utf8')
  .replace(/  boot\(\);\s+document.addEventListener\('DOMContentLoaded', boot\);/,
    '  globalThis.begin = beginDrag; renderBoard = () => {};');
function setup(overrides = {}) {
  const task = { id: 'todo', itemType: 'todo', dueDate: '2026-09-06', time: '13:00', ...overrides };
  const state = { tasks: [task] };
  let captured = null;
  const listeners = new Map(), saves = [];
  const classList = { add() {}, remove() {} };
  const board = { dataset: {}, setPointerCapture(id) { captured = { target: board, id }; }, releasePointerCapture() { captured = null; } };
  const columns = ['2026-09-06', '2026-09-07'].map(date => ({
    dataset: { date }, closest() { return this; },
    appendChild(el) { el.parentElement = this; if (captured?.target === el) captured = null; },
  }));
  const block = { dataset: { id: task.id, date: task.dueDate }, style: {}, classList,
    parentElement: columns[0], querySelector() { return {}; },
    setPointerCapture(id) { captured = { target: block, id }; },
  };
  const days = { dataset: { startHour: '0', hours: '24' }, scrollHeight: 1440,
    getBoundingClientRect: () => ({ top: 0, height: 1440 }) };
  const document = {
    body: { classList },
    querySelector(s) {
      if (s === '#weekBoard') return board;
      if (s === '.week-days') return days;
      if (s.startsWith('.week-block')) return block;
      return columns.find(c => s === `.week-day-col[data-date="${c.dataset.date}"]`) || null;
    },
    querySelectorAll: () => [block],
    elementFromPoint: x => x < 100 ? columns[0] : columns[1],
  };
  const window = {
    addEventListener(type, handler, capture) { listeners.set(type, { handler, capture }); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const context = vm.createContext({ document, window, state, console,
    persist: async () => { saves.push(JSON.parse(JSON.stringify(state))); }, render() {},
    isCalendarEvent: t => t.itemType === 'event',
    fromDateKey: key => new Date(`${key}T00:00:00`),
  });
  vm.runInContext(source, context);
  const event = (x, y, pointerId = 1) => ({ clientX: x, clientY: y, pointerId, preventDefault() {}, stopPropagation() {} });
  return { task, saves, board, block, listeners, event,
    begin(edge) { context.begin(event(10, 780), block, edge); },
    emit(type, x, y, id = 1) { listeners.get(type)?.handler(event(x, y, id)); },
    captured: () => captured,
  };
}

test('cross-column preview keeps capture; outside release saves final date/time once', () => {
  const h = setup();
  h.begin();
  h.emit('pointermove', 110, 840);
  assert.equal(h.captured()?.target, h.board);
  assert.equal(h.task.time, '13:00', 'preview must not mutate persisted state');
  assert.equal(h.listeners.get('pointerup').capture, true);
  h.emit('pointerup', 200, 855);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].tasks[0].dueDate, '2026-09-07');
  assert.equal(h.saves[0].tasks[0].time, '14:15');
  assert.equal(h.saves[0].tasks[0].itemType, 'todo');
  assert.equal(h.captured(), null);
  assert.equal(h.listeners.size, 0);
});

test('another pointer cannot move, cancel or commit the active drag', () => {
  const h = setup(); h.begin();
  h.emit('pointermove', 110, 900, 2);
  h.emit('pointercancel', 110, 900, 2);
  h.emit('pointerup', 110, 900, 2);
  assert.equal(h.saves.length, 0);
  assert.ok(h.captured());
  h.emit('pointerup', 110, 840);
  assert.equal(h.saves[0].tasks[0].time, '14:00');
});

test('cancel and click preserve the exact original task without saving', () => {
  for (const cancel of [false, true]) {
    const h = setup(), original = { ...h.task }; h.begin();
    if (cancel) h.emit('pointermove', 110, 900);
    h.emit(cancel ? 'pointercancel' : 'pointerup', 10, 780);
    assert.deepEqual(h.task, original);
    assert.equal(h.saves.length, 0);
  }
});

test('event move retains duration, date span and calendar source metadata', () => {
  const h = setup({ itemType: 'event', endDate: '2026-09-08', endTime: '14:00', icloudUid: 'source-id', syncTarget: 'calendar' });
  h.begin(); h.emit('pointerup', 110, 840);
  const saved = h.saves[0].tasks[0];
  assert.equal(saved.endDate, '2026-09-09');
  assert.equal(saved.endTime, '15:00');
  assert.equal(saved.icloudUid, 'source-id');
  assert.equal(saved.syncTarget, 'calendar');
});

test('resize commits the selected edge without changing the date', () => {
  for (const [edge, y, start, end] of [['start', 750, '12:30', '14:00'], ['end', 900, '13:00', '15:00']]) {
    const h = setup({ itemType: 'event', endTime: '14:00' });
    h.begin(edge); h.emit('pointerup', 10, y);
    assert.equal(h.task.time, start); assert.equal(h.task.endTime, end);
    assert.equal(h.task.dueDate, '2026-09-06'); assert.equal(h.saves.length, 1);
  }
});

test('completed and external items cannot start a drag', () => {
  for (const flags of [{ completed: true }, { googleCalendarExternal: true }, { syncTarget: 'external-calendar' }]) {
    const h = setup(flags); h.begin();
    assert.equal(h.captured(), null); assert.equal(h.listeners.size, 0);
  }
});

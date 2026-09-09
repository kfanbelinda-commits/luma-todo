"use strict";

const { isIsoDateKey } = require('./private-extensions.cjs');
const { parseIcloudEvent } = require('./icloud-ics.cjs');

// Unknown X-LUMA boolean markers belong to extensions, even after uninstall.
// The ordinary item fields are excluded by the ICS parser.
function isExtensionEvent(event) {
  return Object.values(event?.extensionProperties || {}).some(value => String(value).toLowerCase() === 'true');
}

async function syncExtensionEvents({ range, payload, identify, list, put, remove }) {
  if (!isIsoDateKey(range?.startDate) || !isIsoDateKey(range?.endDate) || range.endDate < range.startDate) throw new Error('扩展日期范围不正确');
  if (!Array.isArray(payload?.events)) throw new Error('扩展未返回日历列表');
  const expected = new Map();
  for (const event of payload.events) {
    if (!event || typeof event.uid !== 'string' || !event.uid || /[\r\n]/.test(event.uid) || expected.has(event.uid)
      || !isIsoDateKey(event.dateKey) || event.dateKey < range.startDate || event.dateKey > range.endDate
      || typeof event.title !== 'string' || typeof event.ics !== 'string') throw new Error('扩展日历条目无效');
    const parsed = parseIcloudEvent(event.ics, '', '', {url:'',name:''});
    if (!parsed || parsed.uid !== event.uid || parsed.title !== event.title || parsed.dueDate !== event.dateKey || !isExtensionEvent(parsed)) throw new Error('扩展日历内容与条目不一致');
    expected.set(event.uid,event);
  }
  const existing = [];
  for (const event of await list()) {
    const identity = identify(event);
    if (identity && identity.dateKey >= range.startDate && identity.dateKey <= range.endDate) existing.push(event);
  }
  const byUid = new Map(existing.map(event=>[event.uid,event]));
  const result = {created:0,updated:0,deleted:0,unchanged:0};
  for (const event of expected.values()) {
    const current = byUid.get(event.uid);
    if (current && current.title === event.title && current.dueDate === event.dateKey) {result.unchanged++;continue;}
    await put(event,current);
    result[current ? 'updated' : 'created']++;
  }
  for (const event of existing) {
    if (expected.has(event.uid)) continue;
    await remove(event);
    result.deleted++;
  }
  return result;
}

module.exports = { syncExtensionEvents, isExtensionEvent };

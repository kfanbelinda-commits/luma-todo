'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { parseIcloudEvent, parseIcloudEventIdentity, taskToIcloudIcs } = require('../main/icloud-ics.cjs');
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
// Exercise the actual main-process transport functions with an isolated fetch.
function transport(fetch) {
  const context = vm.createContext({ fetch, URL, Buffer, parseIcloudEvent, parseIcloudEventIdentity });
  const xml = source.slice(source.indexOf('function decodeXmlText('), source.indexOf('async function', source.indexOf('function resolveCaldavHref(')));
  const helpers = source.slice(source.indexOf('function ensureCalendarUrl('), source.indexOf('async function putIcloudEvent('));
  const writeAndList = source.slice(source.indexOf('async function putIcloudEvent('), source.indexOf('function ensureAppleCalendarProject('));
  const get = source.slice(source.indexOf('async function getIcloudEvent('), source.indexOf('async function syncIcloudEvents('));
  vm.runInContext(xml + '\n' + helpers + '\n' + writeAndList + '\n' + get, context);
  return context;
}
const response = (status, body = '', etag = '') => ({ ok: status >= 200 && status < 300, status,
  url: 'https://qa.invalid/calendar/', text: async () => body, headers: { get: (key) => key === 'etag' ? etag : '' } });
const calendar = { url: 'https://qa.invalid/calendar/', name: 'QA' };
test('DELETE accepts 204, 404 and 410 and sends If-Match', async () => {
  for (const status of [204, 404, 410]) {
    const api = transport(async (_url, options) => {
      assert.equal(options.method, 'DELETE');
      assert.equal(options.headers['If-Match'], '"1"');
      return response(status);
    });
    assert.equal(await api.deleteIcloudEvent(calendar.url + 'qa.ics', {}, '"1"'), true);
  }
});
test('PUT and DELETE surface typed 412 errors', async () => {
  const api = transport(async () => response(412));
  await assert.rejects(() => api.putIcloudEvent(calendar.url + 'qa.ics', {}, 'ics', '"1"'), (error) => error.status === 412);
  await assert.rejects(() => api.deleteIcloudEvent(calendar.url + 'qa.ics', {}, '"1"'), (error) => error.status === 412);
});
test('new PUT is conditional and missing response etag is never replaced by stale etag', async () => {
  const headers = [];
  const api = transport(async (_url, options) => { headers.push(options.headers); return response(204); });
  assert.equal(await api.putIcloudEvent(calendar.url + 'qa.ics', {}, 'ics', ''), '');
  assert.equal(headers[0]['If-None-Match'], '*');
  assert.equal(await api.putIcloudEvent(calendar.url + 'qa.ics', {}, 'ics', '"1"'), '');
  assert.equal(headers[1]['If-Match'], '"1"');
});
test('GET distinguishes missing resources from unreadable content and server failures', async () => {
  for (const status of [404, 410]) {
    assert.equal(await transport(async () => response(status)).getIcloudEvent(calendar.url + 'qa.ics', {}, calendar), null);
  }
  await assert.rejects(() => transport(async () => response(200, 'broken')).getIcloudEvent(calendar.url + 'qa.ics', {}, calendar), /无法解析/);
  await assert.rejects(() => transport(async () => response(503)).getIcloudEvent(calendar.url + 'qa.ics', {}, calendar), /503/);
});
test('REPORT still rejects structurally incomplete lists before sync can infer deletion', async () => {
  for (const xml of ['<html>error</html>', '<d:multistatus xmlns:d="DAV:">', '<d:multistatus xmlns:d="DAV:"><d:response></d:multistatus>', '<d:multistatus xmlns:d="DAV:"><d:response><d:status>HTTP/1.1 403 Forbidden</d:status></d:response></d:multistatus>']) {
    await assert.rejects(() => transport(async () => response(207, xml)).listIcloudCalendarEvents({}, calendar), /停止同步|缺少事项地址/);
  }
  const list = await transport(async () => response(207, '<d:multistatus xmlns:d="DAV:"></d:multistatus>')).listIcloudCalendarEvents({}, calendar);
  assert.equal(list.length, 0);
});

test('REPORT retries one unreadable item with GET and keeps the rest usable', async () => {
  const validIcs = taskToIcloudIcs({ id: 'valid', itemType: 'event', title: 'Valid', completed: false, dueDate: '2026-09-08', endDate: '2026-09-08' }, 'valid@luma');
  const brokenIcs = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:broken@apple', 'SUMMARY:Broken Apple item',
    'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
  const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const report = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:response><d:href>/calendar/valid.ics</d:href><d:getetag>&quot;1&quot;</d:getetag><c:calendar-data>' + escapeXml(validIcs) + '</c:calendar-data></d:response>'
    + '<d:response><d:href>/calendar/broken.ics</d:href><d:getetag>&quot;2&quot;</d:getetag><c:calendar-data>' + escapeXml(brokenIcs) + '</c:calendar-data></d:response>'
    + '</d:multistatus>';
  const methods = [];
  const api = transport(async (url, options) => {
    methods.push([options.method, url]);
    if (options.method === 'REPORT') return response(207, report);
    if (String(url).endsWith('/broken.ics')) return response(200, brokenIcs, '"2b"');
    throw new Error('unexpected request');
  });
  const list = await api.listIcloudCalendarEvents({}, calendar);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, 'Valid');
  assert.equal(list[1].unreadable, true);
  assert.equal(list[1].uid, 'broken@apple');
  assert.equal(list[1].href, calendar.url + 'broken.ics');
  assert.deepEqual(methods.map((item) => item[0]), ['REPORT', 'GET']);
});

test('REPORT GET fallback can recover an item omitted from calendar-data', async () => {
  const recoveredIcs = taskToIcloudIcs({ id: 'recover', itemType: 'event', title: 'Recovered', completed: false, dueDate: '2026-09-08', endDate: '2026-09-08' }, 'recover@luma');
  const report = '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:response><d:href>/calendar/recover.ics</d:href><d:getetag>&quot;1&quot;</d:getetag></d:response>'
    + '</d:multistatus>';
  const api = transport(async (_url, options) => options.method === 'REPORT'
    ? response(207, report)
    : response(200, recoveredIcs, '"2"'));
  const list = await api.listIcloudCalendarEvents({}, calendar);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Recovered');
  assert.equal(list[0].unreadable, undefined);
  assert.equal(list[0].etag, '"2"');
});
test('GET parses Apple snapshot and latest etag', async () => {
  const ics = taskToIcloudIcs({ id: 'qa', itemType: 'todo', title: '买水果', completed: true, dueDate: '2026-09-08' }, 'qa@luma');
  const item = await transport(async () => response(200, ics, '"2"')).getIcloudEvent(calendar.url + 'qa.ics', {}, calendar);
  assert.equal(item.etag, '"2"');
  assert.equal(item.title, '✓ 买水果');
});

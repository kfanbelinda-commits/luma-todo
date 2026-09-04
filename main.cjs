const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen, nativeImage, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEMO_MODE = !app.isPackaged && process.argv.includes('--demo');
const DEMO_RESET_MODE = DEMO_MODE && process.argv.includes('--demo-reset');

// Keep real and demo data completely separate.
if (process.platform === 'win32') {
  const appDataName = DEMO_MODE ? 'luma-todo-demo' : 'luma-todo';
  app.setPath('userData', path.join(app.getPath('home'), 'AppData', 'Roaming', appDataName));
} else if (DEMO_MODE) {
  app.setPath('userData', `${app.getPath('userData')}-demo`);
}

const COMPACT = { width: 410, height: 550 };
const EXPANDED = { width: 1040, height: 660 };
let mainWindow;
let tray;
let isExpanded = false;
let resizeSession = null;
let compactBounds = null;
let expandedBounds = null;
let compactDisplayState = null;
let expandedDisplayState = null;
let updateCheckTimer = null;
let isPinnedAlwaysOnTop = false;
let isDesktopHosted = false;
let desktopAttachTimer = null;
let desktopAttachRequestId = 0;
let desktopHostTransition = Promise.resolve(true);
let nativeModalDepth = 0;
let isExplicitlyHidden = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

function dataPath() {
  return path.join(app.getPath('userData'), 'luma-data.json');
}

function ensureDemoData() {
  if (!DEMO_MODE) return;
  const target = dataPath();
  if (DEMO_RESET_MODE && fs.existsSync(target)) fs.unlinkSync(target);
  if (fs.existsSync(target)) return;
  const { buildDemoState } = require('./demo/demo-state.cjs');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(buildDemoState(), null, 2), 'utf8');
}

function desktopWindowHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'desktop-window.ps1')
    : path.join(__dirname, 'assets', 'desktop-window.ps1');
}

function windowHandleArgument() {
  const handle = mainWindow.getNativeWindowHandle();
  return handle.length >= 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
}

function runDesktopHostTransition(enabled) {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  if (isDesktopHosted === Boolean(enabled)) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', desktopWindowHelperPath(),
        '-Handle', windowHandleArgument(),
        '-Mode', enabled ? 'Attach' : 'Detach',
      ],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.warn(`[Luma Todo] Desktop window mode failed: ${error.message}`);
          resolve(false);
          return;
        }
        isDesktopHosted = Boolean(enabled);
        try {
          const result = JSON.parse(String(stdout || '').trim());
          if (result.boundsPreserved === false) console.warn('[Luma Todo] Desktop host transition changed the native window bounds.');
        } catch {}
        resolve(true);
      },
    );
  });
}

function setDesktopHosted(enabled) {
  desktopHostTransition = desktopHostTransition
    .catch(() => false)
    .then(() => runDesktopHostTransition(enabled));
  return desktopHostTransition;
}

function activateNativeWindow() {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', desktopWindowHelperPath(),
        '-Handle', windowHandleArgument(),
        '-Mode', 'Activate',
      ],
      { windowsHide: true },
      (error) => {
        if (error) {
          console.warn(`[Luma Todo] Native foreground activation failed: ${error.message}`);
          resolve(false);
          return;
        }
        resolve(true);
      },
    );
  });
}

function cancelDesktopAttach() {
  desktopAttachRequestId += 1;
  if (!desktopAttachTimer) return;
  clearTimeout(desktopAttachTimer);
  desktopAttachTimer = null;
}

async function activateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  isExplicitlyHidden = false;
  cancelDesktopAttach();

  // Always queue a detach. If a blur-triggered WorkerW attach is still running,
  // this waits for it and immediately detaches again instead of losing the click.
  await setDesktopHosted(false);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) mainWindow.restore();

  if (!isPinnedAlwaysOnTop) {
    // Windows can leave a detached WorkerW child behind the current foreground
    // app. Use a short topmost pulse plus a native foreground request so one
    // click on the exposed Luma surface reliably raises it above Chrome.
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.moveTop();
    await activateNativeWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.focus();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || isPinnedAlwaysOnTop) return;
      mainWindow.setAlwaysOnTop(false);
      if (mainWindow.isFocused()) mainWindow.moveTop();
    }, 160);
    return;
  }

  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.moveTop();
  await activateNativeWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.focus();
}

async function revealMainWindow() {
  await activateMainWindow();
}

function scheduleDesktopAttach() {
  if (process.env.LUMA_SCREENSHOT_DIR || isPinnedAlwaysOnTop || isDesktopHosted || isExplicitlyHidden) return;
  cancelDesktopAttach();
  const requestId = desktopAttachRequestId;
  desktopAttachTimer = setTimeout(async () => {
    desktopAttachTimer = null;
    if (requestId !== desktopAttachRequestId || !mainWindow || mainWindow.isDestroyed()
      || isPinnedAlwaysOnTop || isDesktopHosted || isExplicitlyHidden) return;
    if (nativeModalDepth > 0) {
      scheduleDesktopAttach();
      return;
    }
    if (mainWindow.isFocused()) return;
    mainWindow.setAlwaysOnTop(false);
    const attached = await setDesktopHosted(true);
    if (!attached || !mainWindow || mainWindow.isDestroyed()) return;
    if (requestId !== desktopAttachRequestId || isPinnedAlwaysOnTop || mainWindow.isFocused()) {
      await setDesktopHosted(false);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.showInactive();
    }
  }, 250);
}

async function setPinnedState(enabled) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  isPinnedAlwaysOnTop = Boolean(enabled);
  cancelDesktopAttach();
  if (isPinnedAlwaysOnTop) {
    await setDesktopHosted(false);
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setAlwaysOnTop(true);
    mainWindow.moveTop();
    mainWindow.focus();
  } else {
    mainWindow.setAlwaysOnTop(false);
    if (!mainWindow.isFocused()) scheduleDesktopAttach();
  }
  return isPinnedAlwaysOnTop;
}

function googleCredentialsPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'credentials.json')
    : path.join(__dirname, 'credentials.json');
}

function googleTokenPath() {
  return path.join(app.getPath('userData'), 'google-token.enc');
}

function readGoogleCredentials() {
  const parsed = JSON.parse(fs.readFileSync(googleCredentialsPath(), 'utf8'));
  const credentials = parsed.installed;
  if (!credentials?.client_id || !credentials?.client_secret) throw new Error('credentials.json 不是 Google 桌面应用凭据');
  return credentials;
}

function loadGoogleToken() {
  try {
    const encrypted = fs.readFileSync(googleTokenPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return JSON.parse(safeStorage.decryptString(encrypted));
  } catch (error) {
    console.warn(`[Luma Todo] Google token could not be loaded: ${error.message}`);
    return null;
  }
}

function saveGoogleToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，无法安全保存 Google 登录');
  const target = googleTokenPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, safeStorage.encryptString(JSON.stringify(token)));
}

function base64Url(buffer) {
  return buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function exchangeGoogleToken(parameters) {
  const credentials = readGoogleCredentials();
  const response = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: credentials.client_id, client_secret: credentials.client_secret, ...parameters }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || payload.error || 'Google 令牌请求失败');
  return payload;
}

async function getGoogleAccessToken() {
  const token = loadGoogleToken();
  if (!token) throw new Error('尚未连接 Google');
  if (token.access_token && Number(token.expires_at) > Date.now() + 60000) return token.access_token;
  if (!token.refresh_token) throw new Error('Google 登录已过期，请重新连接');
  const refreshed = await exchangeGoogleToken({ refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  const merged = { ...token, ...refreshed, refresh_token: token.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
  saveGoogleToken(merged);
  return merged.access_token;
}

async function googleRequest(url, options = {}) {
  const accessToken = await getGoogleAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Google API 请求失败 (${response.status})`);
  return payload;
}

async function connectGoogle() {
  const credentials = readGoogleCredentials();
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64Url(crypto.randomBytes(24));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      error ? reject(error) : resolve(value);
    };
    const server = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        if (url.pathname !== '/oauth2callback') {
          response.writeHead(404).end();
          return;
        }
        if (url.searchParams.get('state') !== state) throw new Error('Google 登录状态校验失败');
        if (url.searchParams.get('error')) {
          const reason = url.searchParams.get('error_description') || url.searchParams.get('error');
          throw new Error(`Google 登录失败：${reason}`);
        }
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Google 未返回授权码');
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
        const token = await exchangeGoogleToken({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
        saveGoogleToken({ ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>Google 已连接</title><style>body{font:16px system-ui;padding:48px;background:#20232a;color:white}h1{color:#8fd4e1}</style><h1>Google 已连接</h1><p>可以关闭此页面并返回 Luma Todo。</p>');
        finish(null, { connected: true });
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error.message);
        finish(error);
      }
    });
    server.listen(0, '127.0.0.1', async () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const authUrl = new URL(credentials.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.search = new URLSearchParams({
        client_id: credentials.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/tasks',
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      try { await shell.openExternal(authUrl.toString()); } catch (error) { finish(error); }
    });
    const timeout = setTimeout(() => finish(new Error('Google 登录超时，请重试')), 180000);
  });
}

function nextDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const LUMA_TASK_NOTES_PREFIX = '[Luma Todo]\n';
const LUMA_METADATA_NOTES_PREFIX = '[Luma Todo Sync Metadata v1]\n';
const LUMA_METADATA_TITLE = 'Luma Todo 同步数据（请勿删除）';
const FALLBACK_PROJECT_COLORS = ['#7289f5', '#8b6ef5', '#4fb58f', '#f0a85a', '#ef7180', '#4da7c9'];
const GOOGLE_CALENDAR_PROJECT_ID = 'google-calendar';
const DEFAULT_EVENT_COLOR = '#91a9c7';

function ensureGoogleCalendarProject(state) {
  state.projects ??= [];
  let project = state.projects.find((item) => item.id === GOOGLE_CALENDAR_PROJECT_ID);
  if (project) {
    project.name = 'Google 日历';
    project.color = '#8b93a3';
    return project;
  }
  project = {
    id: GOOGLE_CALENDAR_PROJECT_ID,
    name: 'Google 日历',
    color: '#8b93a3',
    order: Math.max(-1, ...state.projects.map((item) => Number(item.order) || 0)) + 1,
    updatedAt: Date.now(),
  };
  state.projects.push(project);
  state.projectsUpdatedAt = Date.now();
  return project;
}

function parseJsonAfterPrefix(notes, prefix) {
  if (typeof notes !== 'string' || !notes.startsWith(prefix)) return null;
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return null;
  }
}

function googleTaskMetadata(remoteTask) {
  const parsed = parseJsonAfterPrefix(remoteTask?.notes, LUMA_TASK_NOTES_PREFIX);
  if (parsed) return parsed;
  if (typeof remoteTask?.notes !== 'string' || !remoteTask.notes.startsWith(LUMA_TASK_NOTES_PREFIX)) return null;
  const legacyProject = remoteTask.notes.match(/(?:^|\n)分类：([^\n]+)/)?.[1]?.trim();
  return { version: 1, projectId: legacyProject || 'inbox' };
}

function normalizeCloudProject(project, index = 0) {
  const id = String(project?.id || '').trim();
  if (!id) return null;
  const color = /^#[0-9a-f]{6}$/i.test(project?.color || '')
    ? project.color
    : FALLBACK_PROJECT_COLORS[index % FALLBACK_PROJECT_COLORS.length];
  return {
    id,
    name: String(project?.name || (id === 'inbox' ? '未分类' : '云端分类')),
    color,
    order: Number.isFinite(Number(project?.order)) ? Number(project.order) : index,
    updatedAt: Number(project?.updatedAt || 0),
  };
}

function ensureProject(state, details = {}) {
  state.projects ??= [];
  const id = String(details.projectId || 'inbox');
  let project = state.projects.find((item) => item.id === id);
  if (project) return project;
  project = normalizeCloudProject({
    id,
    name: details.projectName || (id === 'inbox' ? '未分类' : '云端分类'),
    color: details.projectColor,
    order: details.projectOrder ?? state.projects.length,
  }, state.projects.length);
  state.projects.push(project);
  state.projectsUpdatedAt = Date.now();
  return project;
}

function projectMetadataForTask(state, task) {
  const project = ensureProject(state, { projectId: task.projectId });
  return {
    projectId: project.id,
    projectName: project.name,
    projectColor: project.color,
    projectOrder: project.order,
  };
}

function taskNotes(state, task) {
  return LUMA_TASK_NOTES_PREFIX + JSON.stringify({
    version: 3,
    taskId: task.id,
    ...projectMetadataForTask(state, task),
    order: Number(task.order ?? task.createdAt ?? 0),
    reminder: task.reminder ?? null,
    time: /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.time || '') ? task.time : '',
    updatedAt: Number(task.updatedAt || task.createdAt || Date.now()),
  });
}

function calendarBody(state, task) {
  const project = projectMetadataForTask(state, task);
  const itemType = task.itemType === 'event' ? 'event' : 'todo';
  const body = {
    summary: task.title,
    extendedProperties: {
      private: {
        lumaTodo: 'true',
        lumaVersion: '2',
        lumaTaskId: String(task.id),
        lumaItemType: itemType,
        lumaEventColor: itemType === 'event' ? String(task.eventColor || DEFAULT_EVENT_COLOR) : '',
        lumaProjectId: project.projectId,
        lumaProjectName: project.projectName,
        lumaProjectColor: project.projectColor,
        lumaProjectOrder: String(project.projectOrder),
        lumaCompleted: String(Boolean(task.completed)),
        lumaReminder: task.reminder == null ? '' : String(task.reminder),
        lumaOrder: String(Number(task.order ?? task.createdAt ?? 0)),
        lumaUpdatedAt: String(Number(task.updatedAt || task.createdAt || Date.now())),
      },
    },
  };

  if (itemType === 'event') {
    const endDate = task.endDate && task.endDate >= task.dueDate ? task.endDate : task.dueDate;
    if (task.time) {
      const start = new Date(`${task.dueDate}T${task.time}:00`);
      let end = new Date(`${endDate}T${task.endTime || task.time}:00`);
      if (end <= start) end = new Date(start.getTime() + 30 * 60000);
      body.start = { dateTime: start.toISOString() };
      body.end = { dateTime: end.toISOString() };
    } else {
      body.start = { date: task.dueDate };
      body.end = { date: nextDateKey(endDate || task.dueDate) };
    }
    return body;
  }

  if (task.time) {
    const start = new Date(`${task.dueDate}T${task.time}:00`);
    const end = new Date(start.getTime() + 30 * 60000);
    body.start = { dateTime: start.toISOString() };
    body.end = { dateTime: end.toISOString() };
  } else {
    body.start = { date: task.dueDate };
    body.end = { date: nextDateKey(task.dueDate) };
  }
  return body;
}

function applyCalendarEvent(task, event) {
  const details = event.extendedProperties?.private || {};
  task.title = event.summary || task.title;

  if (event.start?.date) {
    task.dueDate = event.start.date;
    task.time = '';
  } else if (event.start?.dateTime) {
    const start = new Date(event.start.dateTime);
    task.dueDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    task.time = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  }

  if (event.end?.date) {
    task.endDate = previousDateKey(event.end.date);
    task.endTime = '';
  } else if (event.end?.dateTime) {
    const end = new Date(event.end.dateTime);
    task.endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    task.endTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  } else {
    task.endDate = task.dueDate || '';
    task.endTime = '';
  }

  if (Object.hasOwn(details, 'lumaItemType')) task.itemType = details.lumaItemType === 'event' ? 'event' : 'todo';
  const remoteEventColor = details.lumaEventColor || event._lumaCalendarColor || task.eventColor || DEFAULT_EVENT_COLOR;
  if ((task.itemType === 'event' || task.googleCalendarExternal || task.syncTarget === 'external-calendar') && /^#[0-9a-f]{6}$/i.test(remoteEventColor)) {
    task.eventColor = remoteEventColor;
  }
  if (Object.hasOwn(details, 'lumaCompleted')) task.completed = details.lumaCompleted === 'true';
  if (Object.hasOwn(details, 'lumaReminder')) task.reminder = details.lumaReminder === '' ? null : Number(details.lumaReminder);
  task.projectId = details.lumaProjectId || task.projectId || 'inbox';
  if (details.lumaOrder) task.order = Number(details.lumaOrder);
}

function applyGoogleTask(task, remoteTask, details = {}) {
  task.title = remoteTask.title || task.title;
  task.itemType = 'todo';
  task.completed = remoteTask.status === 'completed';
  task.dueDate = remoteTask.due ? remoteTask.due.slice(0, 10) : '';
  task.endDate = '';
  task.endTime = '';
  task.time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(details.time || '') ? details.time : '';
  task.projectId = details.projectId || task.projectId || 'inbox';
  if (details.order != null) task.order = Number(details.order);
  if (Object.hasOwn(details, 'reminder')) task.reminder = details.reminder;
}

async function listGoogleCalendars() {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    let page;
    try {
      page = await googleRequest(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`);
    } catch (error) {
      if (/scope|permission|forbidden|insufficient/i.test(error.message)) {
        throw new Error('需要重新授权 Google 日历列表权限：请先断开 Google，再重新连接');
      }
      throw error;
    }
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items.filter((calendar) =>
    !calendar.deleted
    && !calendar.hidden
    && calendar.selected !== false
    && ['reader', 'writer', 'owner'].includes(calendar.accessRole)
  );
}

async function listEventsForCalendar(calendar, { lumaOnly = false } = {}) {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '2500' });
    if (lumaOnly) {
      params.set('privateExtendedProperty', 'lumaTodo=true');
    } else {
      const timeMin = new Date();
      const timeMax = new Date();
      timeMin.setFullYear(timeMin.getFullYear() - 1);
      timeMax.setFullYear(timeMax.getFullYear() + 2);
      params.set('timeMin', timeMin.toISOString());
      params.set('timeMax', timeMax.toISOString());
    }
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`);
    items.push(...(page.items || []).map((event) => ({
      ...event,
      _lumaCalendarId: calendar.id,
      _lumaCalendarName: calendar.summaryOverride || calendar.summary || calendar.id,
      _lumaCalendarColor: /^#[0-9a-f]{6}$/i.test(calendar.backgroundColor || '') ? calendar.backgroundColor : DEFAULT_EVENT_COLOR,
    })));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items;
}

async function listGoogleCalendarEvents() {
  const calendars = await listGoogleCalendars();
  const pages = await Promise.all(calendars.flatMap((calendar) => [
    listEventsForCalendar(calendar),
    listEventsForCalendar(calendar, { lumaOnly: true }),
  ]));
  const unique = new Map();
  pages.flat().forEach((event) => unique.set(calendarEventKey(calendarIdForEvent(event), event.id), event));
  return [...unique.values()];
}

async function listGoogleTasks() {
  const items = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', showDeleted: 'true', maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const page = await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks?${params}`);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return items;
}

function localChangedSinceSync(task) {
  return Number(task.updatedAt || task.createdAt || 0) > Number(task.lastGoogleSyncAt || 0);
}

function remoteShouldWin(task, remoteUpdatedAt) {
  const remoteChanged = Number(remoteUpdatedAt || 0) > Number(task.googleRemoteUpdatedAt || 0);
  if (!remoteChanged) return false;
  if (!localChangedSinceSync(task)) return true;
  return Number(remoteUpdatedAt || 0) > Number(task.updatedAt || task.createdAt || 0);
}

function applyRemoteProjectMetadata(state, googleTasks) {
  const metadataTask = googleTasks.find((task) => !task.deleted && typeof task.notes === 'string' && task.notes.startsWith(LUMA_METADATA_NOTES_PREFIX));
  const payload = parseJsonAfterPrefix(metadataTask?.notes, LUMA_METADATA_NOTES_PREFIX);
  const remoteUpdatedAt = Number(payload?.updatedAt || Date.parse(metadataTask?.updated || 0) || 0);
  const localUpdatedAt = Number(state.projectsUpdatedAt || 0);
  let downloaded = 0;

  if (Array.isArray(payload?.projects) && remoteUpdatedAt > localUpdatedAt) {
    const projects = payload.projects.map(normalizeCloudProject).filter(Boolean);
    if (!projects.some((project) => project.id === 'inbox')) {
      projects.unshift(normalizeCloudProject({ id: 'inbox', name: '未分类', color: '#9aa4b8', order: 0 }));
    }
    state.projects = projects;
    state.projectsUpdatedAt = remoteUpdatedAt;
    downloaded = projects.length;
  }

  return { metadataTask, remoteUpdatedAt, downloaded };
}

async function uploadProjectMetadata(state, remoteMetadata) {
  state.projects ??= [];
  if (!Number(state.projectsUpdatedAt || 0)) state.projectsUpdatedAt = Date.now();
  if (remoteMetadata.metadataTask && Number(state.projectsUpdatedAt) <= Number(remoteMetadata.remoteUpdatedAt)) return 0;

  const projects = state.projects
    .map(normalizeCloudProject)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
  const body = {
    title: LUMA_METADATA_TITLE,
    notes: LUMA_METADATA_NOTES_PREFIX + JSON.stringify({ version: 1, updatedAt: state.projectsUpdatedAt, projects }),
    status: 'completed',
    completed: new Date().toISOString(),
  };
  const url = remoteMetadata.metadataTask
    ? `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(remoteMetadata.metadataTask.id)}`
    : 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
  await googleRequest(url, { method: remoteMetadata.metadataTask ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  return 1;
}

function calendarTaskDetails(event) {
  const details = event.extendedProperties?.private || {};
  return {
    version: Number(details.lumaVersion || 1),
    taskId: details.lumaTaskId,
    itemType: details.lumaItemType === 'event' ? 'event' : 'todo',
    eventColor: /^#[0-9a-f]{6}$/i.test(details.lumaEventColor || '') ? details.lumaEventColor : '',
    projectId: details.lumaProjectId || 'inbox',
    projectName: details.lumaProjectName,
    projectColor: details.lumaProjectColor,
    projectOrder: details.lumaProjectOrder,
  };
}

function calendarIdForEvent(event) {
  return event?._lumaCalendarId || 'primary';
}

function calendarEventKey(calendarId, eventId) {
  return `${calendarId || 'primary'}\u0000${eventId || ''}`;
}

function newLocalTaskId(state, preferred, source, remoteId) {
  const candidate = String(preferred || `${source}-${remoteId}`);
  if (!state.tasks.some((task) => task.id === candidate)) return candidate;
  return `${source}-${remoteId}`;
}

async function syncGoogleState(state) {
  state.tasks ??= [];
  state.projects ??= [];
  const [calendarEvents, googleTasks] = await Promise.all([listGoogleCalendarEvents(), listGoogleTasks()]);
  const calendarByKey = new Map(calendarEvents.map((event) => [calendarEventKey(calendarIdForEvent(event), event.id), event]));
  const calendarById = new Map(calendarEvents.map((event) => [event.id, event]));
  const googleTasksById = new Map(googleTasks.map((task) => [task.id, task]));
  const calendarByTaskId = new Map(calendarEvents.map((event) => [calendarTaskDetails(event).taskId, event]).filter(([id]) => id));
  const lumaGoogleTasks = googleTasks.filter((task) => googleTaskMetadata(task));
  const googleTaskByTaskId = new Map(lumaGoogleTasks.map((task) => [googleTaskMetadata(task)?.taskId, task]).filter(([id]) => id));
  const consumedCalendarIds = new Set();
  const consumedGoogleTaskIds = new Set();
  const remoteProjectMetadata = applyRemoteProjectMetadata(state, googleTasks);
  const syncTime = Date.now();
  const retainedTasks = [];
  let uploaded = 0;
  let downloaded = 0;
  let deleted = 0;
  let externalCalendarDownloaded = 0;
  const findCalendarEvent = (task) => {
    if (!task.googleCalendarEventId) return null;
    return calendarByKey.get(calendarEventKey(task.googleCalendarId, task.googleCalendarEventId))
      || calendarById.get(task.googleCalendarEventId)
      || null;
  };

  for (const task of state.tasks) {
    task.updatedAt ??= task.createdAt || Date.now();

    if (task.googleCalendarExternal || task.syncTarget === 'external-calendar') {
      const remote = findCalendarEvent(task);
      if (remote) consumedCalendarIds.add(calendarEventKey(calendarIdForEvent(remote), remote.id));
      if (!remote || remote.status === 'cancelled') {
        deleted += 1;
        continue;
      }
      const remoteUpdatedAt = Date.parse(remote.updated || 0) || syncTime;
      const previousRemoteUpdatedAt = Number(task.googleRemoteUpdatedAt || 0);
      applyCalendarEvent(task, remote);
      task.itemType = 'event';
      task.projectId = ensureGoogleCalendarProject(state).id;
      task.completed = false;
      task.syncTarget = 'external-calendar';
      task.googleCalendarExternal = true;
      task.googleCalendarId = calendarIdForEvent(remote);
      task.googleCalendarName = remote._lumaCalendarName || task.googleCalendarName || 'Google 日历';
      task.googleRemoteUpdatedAt = remoteUpdatedAt;
      task.updatedAt = remoteUpdatedAt;
      task.lastGoogleSyncAt = syncTime;
      retainedTasks.push(task);
      if (remoteUpdatedAt > previousRemoteUpdatedAt) {
        downloaded += 1;
        externalCalendarDownloaded += 1;
      }
      continue;
    }

    if (task.syncTarget === 'calendar' && task.dueDate) {
      if (task.googleTaskId) {
        consumedGoogleTaskIds.add(task.googleTaskId);
        try { await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(task.googleTaskId)}`, { method: 'DELETE' }); } catch {}
        task.googleTaskId = null;
      }
      const foundRemote = findCalendarEvent(task) || calendarByTaskId.get(task.id);
      if (foundRemote) consumedCalendarIds.add(calendarEventKey(calendarIdForEvent(foundRemote), foundRemote.id));
      const remoteDeleted = foundRemote?.status === 'cancelled';
      const remote = remoteDeleted ? null : foundRemote;
      const remoteUpdatedAt = Date.parse(foundRemote?.updated || 0);
      const remoteDetails = remote ? calendarTaskDetails(remote) : {};
      const needsMetadataUpgrade = remote && remoteDetails.version < 2;

      if (remoteDeleted && !localChangedSinceSync(task)) {
        deleted += 1;
        continue;
      }
      if (remote && remoteShouldWin(task, remoteUpdatedAt)) {
        applyCalendarEvent(task, remote);
        ensureProject(state, remoteDetails);
        task.googleCalendarEventId = remote.id;
        task.googleCalendarId = calendarIdForEvent(remote);
        task.googleRemoteUpdatedAt = remoteUpdatedAt;
        task.updatedAt = remoteUpdatedAt;
        downloaded += 1;
        if (needsMetadataUpgrade) {
          const upgraded = await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarIdForEvent(remote))}/events/${encodeURIComponent(remote.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(calendarBody(state, task)),
          });
          task.googleRemoteUpdatedAt = Date.parse(upgraded.updated || new Date().toISOString());
          uploaded += 1;
        }
      } else if (!remote || localChangedSinceSync(task) || needsMetadataUpgrade) {
        if (remoteDeleted) task.googleCalendarEventId = null;
        const body = calendarBody(state, task);
        const url = remote
          ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarIdForEvent(remote))}/events/${encodeURIComponent(remote.id)}`
          : 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
        const saved = await googleRequest(url, { method: remote ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        task.googleCalendarEventId = saved.id;
        task.googleCalendarId = remote ? calendarIdForEvent(remote) : 'primary';
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        uploaded += 1;
      }
    } else if (task.syncTarget === 'tasks') {
      if (task.googleCalendarEventId) {
        consumedCalendarIds.add(calendarEventKey(task.googleCalendarId, task.googleCalendarEventId));
        try { await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(task.googleCalendarId || 'primary')}/events/${encodeURIComponent(task.googleCalendarEventId)}`, { method: 'DELETE' }); } catch {}
        task.googleCalendarEventId = null;
        task.googleCalendarId = null;
      }
      const foundRemote = (task.googleTaskId ? googleTasksById.get(task.googleTaskId) : null) || googleTaskByTaskId.get(task.id);
      if (foundRemote) consumedGoogleTaskIds.add(foundRemote.id);
      const remoteDeleted = Boolean(foundRemote?.deleted);
      const remote = remoteDeleted ? null : foundRemote;
      const remoteUpdatedAt = Date.parse(foundRemote?.updated || 0);
      const remoteDetails = remote ? (googleTaskMetadata(remote) || {}) : {};
      const needsMetadataUpgrade = remote && Number(remoteDetails.version || 1) < 3;

      if (remoteDeleted && !localChangedSinceSync(task)) {
        deleted += 1;
        continue;
      }
      if (remote && remoteShouldWin(task, remoteUpdatedAt)) {
        applyGoogleTask(task, remote, remoteDetails);
        ensureProject(state, remoteDetails);
        task.googleTaskId = remote.id;
        task.googleRemoteUpdatedAt = remoteUpdatedAt;
        task.updatedAt = remoteUpdatedAt;
        downloaded += 1;
        if (needsMetadataUpgrade) {
          const upgraded = await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(remote.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              title: task.title,
              notes: taskNotes(state, task),
              status: task.completed ? 'completed' : 'needsAction',
              completed: task.completed ? new Date(task.updatedAt || Date.now()).toISOString() : null,
              due: task.dueDate ? `${task.dueDate}T00:00:00.000Z` : null,
            }),
          });
          task.googleRemoteUpdatedAt = Date.parse(upgraded.updated || new Date().toISOString());
          uploaded += 1;
        }
      } else if (!remote || localChangedSinceSync(task) || needsMetadataUpgrade) {
        if (remoteDeleted) task.googleTaskId = null;
        const body = {
          title: task.title,
          notes: taskNotes(state, task),
          status: task.completed ? 'completed' : 'needsAction',
          completed: task.completed ? new Date(task.updatedAt || Date.now()).toISOString() : null,
          due: task.dueDate ? `${task.dueDate}T00:00:00.000Z` : null,
        };
        const url = remote
          ? `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(remote.id)}`
          : 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
        const saved = await googleRequest(url, { method: remote ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        task.googleTaskId = saved.id;
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        uploaded += 1;
      }
    }
    task.lastGoogleSyncAt = syncTime;
    retainedTasks.push(task);
  }

  for (const event of calendarEvents) {
    if (consumedCalendarIds.has(calendarEventKey(calendarIdForEvent(event), event.id)) || event.status === 'cancelled') continue;
    const isLumaEvent = event.extendedProperties?.private?.lumaTodo === 'true';
    const details = calendarTaskDetails(event);
    const remoteUpdatedAt = Date.parse(event.updated || 0) || syncTime;
    const project = isLumaEvent ? ensureProject(state, details) : ensureGoogleCalendarProject(state);
    const task = {
      id: newLocalTaskId(state, details.taskId, 'calendar', `${calendarIdForEvent(event)}-${event.id}`),
      title: event.summary || '未命名日程',
      projectId: project.id,
      completed: false,
      createdAt: Date.parse(event.created || 0) || remoteUpdatedAt,
      updatedAt: remoteUpdatedAt,
      order: Number(event.extendedProperties?.private?.lumaOrder || remoteUpdatedAt),
      reminder: null,
      itemType: isLumaEvent
        ? (event.extendedProperties?.private?.lumaItemType === 'event' ? 'event' : 'todo')
        : 'event',
      syncTarget: isLumaEvent ? 'calendar' : 'external-calendar',
      googleCalendarEventId: event.id,
      googleCalendarId: calendarIdForEvent(event),
      googleCalendarName: event._lumaCalendarName || 'Google 日历',
      googleCalendarExternal: !isLumaEvent,
      googleRemoteUpdatedAt: remoteUpdatedAt,
      lastGoogleSyncAt: syncTime,
    };
    applyCalendarEvent(task, event);
    if (!isLumaEvent) {
      task.itemType = 'event';
      task.projectId = project.id;
    }
    retainedTasks.push(task);
    state.tasks.push(task);
    downloaded += 1;
    if (!isLumaEvent) externalCalendarDownloaded += 1;
  }

  for (const remoteTask of lumaGoogleTasks) {
    if (consumedGoogleTaskIds.has(remoteTask.id) || remoteTask.deleted) continue;
    const details = googleTaskMetadata(remoteTask) || {};
    const remoteUpdatedAt = Date.parse(remoteTask.updated || 0) || syncTime;
    ensureProject(state, details);
    const task = {
      id: newLocalTaskId(state, details.taskId, 'google-task', remoteTask.id),
      title: remoteTask.title || '未命名任务',
      projectId: details.projectId || 'inbox',
      completed: remoteTask.status === 'completed',
      createdAt: remoteUpdatedAt,
      updatedAt: remoteUpdatedAt,
      order: Number(details.order || remoteUpdatedAt),
      reminder: details.reminder ?? null,
      itemType: 'todo',
      syncTarget: 'tasks',
      googleTaskId: remoteTask.id,
      googleRemoteUpdatedAt: remoteUpdatedAt,
      lastGoogleSyncAt: syncTime,
    };
    applyGoogleTask(task, remoteTask, details);
    retainedTasks.push(task);
    state.tasks.push(task);
    downloaded += 1;
  }

  state.tasks = retainedTasks;
  const projectsUploaded = await uploadProjectMetadata(state, remoteProjectMetadata);
  return {
    state,
    summary: {
      uploaded,
      downloaded,
      deleted,
      externalCalendarDownloaded,
      projectsUploaded,
      projectsDownloaded: remoteProjectMetadata.downloaded,
    },
  };
}

async function deleteGoogleTask(task) {
  if (!loadGoogleToken() || !task) return false;
  if (task.googleCalendarExternal || task.syncTarget === 'external-calendar') return false;
  if (task.googleCalendarEventId) {
    await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(task.googleCalendarId || 'primary')}/events/${encodeURIComponent(task.googleCalendarEventId)}`, { method: 'DELETE' });
  }
  if (task.googleTaskId) {
    await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(task.googleTaskId)}`, { method: 'DELETE' });
  }
  return true;
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
  } catch {
    return {};
  }
}

function displayStateForBounds(bounds) {
  const display = screen.getDisplayMatching(bounds);
  return {
    id: display.id,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  const displayState = displayStateForBounds(current);
  if (isExpanded) {
    expandedBounds = current;
    expandedDisplayState = displayState;
  } else {
    compactBounds = current;
    compactDisplayState = displayState;
  }
  fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
  fs.writeFileSync(windowStatePath(), JSON.stringify({
    compactBounds,
    expandedBounds,
    compactDisplayState,
    expandedDisplayState,
  }, null, 2), 'utf8');
}

function ensureDailyBackup() {
  const source = dataPath();
  if (!fs.existsSync(source)) return;
  const backupDir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(backupDir, `luma-backup-${stamp}.json`);
  if (!fs.existsSync(target)) fs.copyFileSync(source, target);
}

function clampWindowPosition(position, size, area) {
  const minVisible = 48;
  const minX = area.x - size.width + minVisible;
  const maxX = area.x + area.width - minVisible;
  const minY = area.y;
  const maxY = area.y + area.height - minVisible;
  return {
    x: Math.round(Math.min(Math.max(position.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(position.y, minY), maxY)),
  };
}

function windowPosition(size, savedBounds = null, savedDisplayState = null) {
  if (savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)) {
    const displays = screen.getAllDisplays();
    const savedDisplay = savedDisplayState
      ? displays.find((display) => String(display.id) === String(savedDisplayState.id))
      : null;
    const targetDisplay = savedDisplay || screen.getDisplayMatching({
      x: savedBounds.x,
      y: savedBounds.y,
      width: Math.max(1, savedBounds.width || size.width),
      height: Math.max(1, savedBounds.height || size.height),
    });
    const area = targetDisplay.workArea;

    let position = { x: savedBounds.x, y: savedBounds.y };
    const oldArea = savedDisplayState?.workArea;
    if (savedDisplay && oldArea
      && Number.isFinite(oldArea.x) && Number.isFinite(oldArea.y)
      && (oldArea.x !== area.x || oldArea.y !== area.y)) {
      position = {
        x: area.x + (savedBounds.x - oldArea.x),
        y: area.y + (savedBounds.y - oldArea.y),
      };
    }
    return clampWindowPosition(position, size, area);
  }

  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: area.x + area.width - size.width - 28,
    y: area.y + Math.max(28, Math.round((area.height - size.height) / 2)),
  };
}

function createWindow() {
  const savedState = loadWindowState();
  let startupSettings = {};
  try {
    startupSettings = JSON.parse(fs.readFileSync(dataPath(), 'utf8')).settings || {};
  } catch {}
  const startupAlwaysOnTop = Boolean(startupSettings.alwaysOnTop ?? startupSettings.desktopPinned);
  isPinnedAlwaysOnTop = startupAlwaysOnTop;
  compactBounds = savedState.compactBounds || null;
  expandedBounds = savedState.expandedBounds || null;
  compactDisplayState = savedState.compactDisplayState || null;
  expandedDisplayState = savedState.expandedDisplayState || null;
  const initialSize = compactBounds
    ? { width: Math.max(330, compactBounds.width), height: Math.max(420, compactBounds.height) }
    : COMPACT;
  const pos = windowPosition(initialSize, compactBounds, compactDisplayState);
  mainWindow = new BrowserWindow({
    ...initialSize,
    ...pos,
    minWidth: 330,
    minHeight: 420,
    transparent: true,
    frame: false,
    hasShadow: false,
    // A Windows thick frame leaves a dark DWM rectangle around transparent
    // frameless windows. Resizing is already handled by our custom edges.
    thickFrame: false,
    show: false,
    resizable: true,
    minimizable: false,
    alwaysOnTop: startupAlwaysOnTop,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', async () => {
    if (process.env.LUMA_SCREENSHOT_DIR) mainWindow.showInactive();
    else await revealMainWindow();
    if (process.env.LUMA_SCREENSHOT_DIR) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (process.env.LUMA_SCREENSHOT_LIGHT === '1') {
        await mainWindow.webContents.executeJavaScript("applyColorMode(true); render()");
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (process.env.LUMA_SCREENSHOT_DARK === '1') {
        await mainWindow.webContents.executeJavaScript("applyColorMode(false); render()");
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (process.env.LUMA_SCREENSHOT_SETTINGS === '1') {
        await mainWindow.webContents.executeJavaScript("document.querySelector('#settingsDialog').showModal()");
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
      fs.mkdirSync(process.env.LUMA_SCREENSHOT_DIR, { recursive: true });
      const compactImage = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(process.env.LUMA_SCREENSHOT_DIR, 'compact.png'), compactImage.toPNG());
      const beforeResize = mainWindow.getBounds();
      await mainWindow.webContents.executeJavaScript("window.luma.resizeStart({ edge: 'sw', x: 100, y: 100 })");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await mainWindow.webContents.executeJavaScript("window.luma.resizeMove({ x: 52, y: 132 }); window.luma.resizeEnd()");
      await new Promise((resolve) => setTimeout(resolve, 80));
      const afterResize = mainWindow.getBounds();
      if (afterResize.width < beforeResize.width + 40 || afterResize.height < beforeResize.height + 24) {
        throw new Error('Custom corner resize QA failed');
      }
      mainWindow.setBounds(beforeResize);
      compactBounds = beforeResize;
      saveWindowState();
      const size = EXPANDED;
      const nextPos = windowPosition(size);
      mainWindow.setBounds({ ...nextPos, ...size });
      await mainWindow.webContents.executeJavaScript("document.querySelector('#app').classList.add('expanded')");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const expandedImage = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(process.env.LUMA_SCREENSHOT_DIR, 'expanded.png'), expandedImage.toPNG());
      const holdMs = Math.max(0, Number(process.env.LUMA_SCREENSHOT_HOLD_MS || 0));
      if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
      app.isQuitting = true;
      app.quit();
    }
  });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      isExplicitlyHidden = true;
      cancelDesktopAttach();
      mainWindow.hide();
    }
  });
  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    cancelDesktopAttach();
    if (isPinnedAlwaysOnTop) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.showInactive();
      return;
    }
    setDesktopHosted(true).then((attached) => {
      if (!attached || !mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.showInactive();
    });
  });
  mainWindow.on('focus', () => {
    cancelDesktopAttach();
    if (!isPinnedAlwaysOnTop && isDesktopHosted) activateMainWindow();
  });
  mainWindow.on('blur', () => {
    scheduleDesktopAttach();
  });
  mainWindow.on('moved', saveWindowState);
}

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(icon);
  tray.setToolTip('Luma Todo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Luma Todo', click: () => { revealMainWindow(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      isExplicitlyHidden = true;
      mainWindow.hide();
    }
    else revealMainWindow();
  });
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => console.warn(`[Luma Todo] Update check failed: ${error.message}`));
  autoUpdater.once('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Luma Todo 更新已就绪',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '可以立即重启安装，也可以稍后在退出软件时自动安装。',
      buttons: ['立即重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response !== 0) return;
      app.isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    });
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => {
    console.warn(`[Luma Todo] Update check failed: ${error.message}`);
  });
  setTimeout(check, 5000);
  updateCheckTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  revealMainWindow();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  ensureDemoData();
  ensureDailyBackup();
  createWindow();
  createTray();
  setupAutoUpdates();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  cancelDesktopAttach();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

ipcMain.handle('window:set-expanded', (_event, expanded) => {
  const current = mainWindow.getBounds();
  if (isExpanded) expandedBounds = current;
  else compactBounds = current;
  isExpanded = Boolean(expanded);
  const remembered = isExpanded ? expandedBounds : compactBounds;
  const fallback = isExpanded ? EXPANDED : COMPACT;
  const size = {
    width: remembered?.width || fallback.width,
    height: isExpanded ? current.height : (remembered?.height || fallback.height),
  };
  const area = screen.getDisplayMatching(current).workArea;
  const right = Math.min(current.x + current.width, area.x + area.width - 28);
  size.width = Math.min(size.width, area.width - 40);
  size.height = Math.min(size.height, area.height - 40);
  const x = Math.max(area.x + 20, right - size.width);
  const y = Math.min(Math.max(current.y, area.y + 20), area.y + area.height - size.height - 20);
  mainWindow.setMinimumSize(isExpanded ? 760 : 330, 420);
  mainWindow.setBounds({ x, y, ...size }, false);
  mainWindow.webContents.invalidate();
  saveWindowState();
  return mainWindow.getBounds();
});

ipcMain.handle('window:set-always-on-top', async (_event, enabled) => {
  return setPinnedState(enabled);
});

ipcMain.on('window:activate', () => {
  cancelDesktopAttach();
  if (!isPinnedAlwaysOnTop && (!mainWindow?.isFocused() || isDesktopHosted)) {
    activateMainWindow();
  }
});

ipcMain.on('window:resize-start', (_event, payload) => {
  if (!payload?.edge) return;
  resizeSession = {
    edge: payload.edge,
    startX: Number(payload.x),
    startY: Number(payload.y),
    bounds: mainWindow.getBounds(),
  };
});

ipcMain.on('window:resize-move', (_event, payload) => {
  if (!resizeSession) return;
  const { edge, startX, startY, bounds } = resizeSession;
  const dx = Number(payload.x) - startX;
  const dy = Number(payload.y) - startY;
  const area = screen.getDisplayMatching(bounds).workArea;
  const minWidth = isExpanded ? 760 : 330;
  const minHeight = 420;
  const next = { ...bounds };

  if (edge.includes('e')) next.width = Math.max(minWidth, Math.min(area.x + area.width - bounds.x, bounds.width + dx));
  if (edge.includes('s')) next.height = Math.max(minHeight, Math.min(area.y + area.height - bounds.y, bounds.height + dy));
  if (edge.includes('w')) {
    next.width = Math.max(minWidth, Math.min(bounds.x + bounds.width - area.x, bounds.width - dx));
    next.x = bounds.x + bounds.width - next.width;
  }
  if (edge.includes('n')) {
    next.height = Math.max(minHeight, Math.min(bounds.y + bounds.height - area.y, bounds.height - dy));
    next.y = bounds.y + bounds.height - next.height;
  }
  mainWindow.setBounds(next);
});

ipcMain.on('window:resize-end', () => {
  if (!resizeSession) return;
  resizeSession = null;
  saveWindowState();
});

ipcMain.on('window:hide', () => {
  isExplicitlyHidden = true;
  cancelDesktopAttach();
  mainWindow.hide();
});

ipcMain.handle('data:load', () => {
  try {
    return JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('data:save', (_event, payload) => {
  const target = dataPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return true;
});

ipcMain.handle('data:export', async (_event, payload) => {
  nativeModalDepth += 1;
  cancelDesktopAttach();
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Luma Todo 备份',
      defaultPath: `luma-todo-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return false;
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } finally {
    nativeModalDepth = Math.max(0, nativeModalDepth - 1);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) scheduleDesktopAttach();
  }
});

ipcMain.handle('google:status', () => {
  if (DEMO_MODE) {
    return {
      connected: false,
      requiresCalendarReauth: false,
      credentialsAvailable: false,
    };
  }
  const token = loadGoogleToken();
  const scopes = new Set(String(token?.scope || '').split(/\s+/).filter(Boolean));
  const hasCalendarListScope = scopes.has('https://www.googleapis.com/auth/calendar')
    || scopes.has('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
  return {
    connected: Boolean(token),
    requiresCalendarReauth: Boolean(token) && !hasCalendarListScope,
    credentialsAvailable: fs.existsSync(googleCredentialsPath()),
  };
});

ipcMain.handle('google:connect', async () => {
  if (DEMO_MODE) throw new Error('演示模式不会连接真实 Google 账户');
  if (!fs.existsSync(googleCredentialsPath())) throw new Error('项目目录中没有找到 credentials.json');
  return connectGoogle();
});

ipcMain.handle('google:disconnect', async () => {
  const token = loadGoogleToken();
  const revocationToken = token?.refresh_token || token?.access_token;
  if (revocationToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revocationToken)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    } catch {}
  }
  if (fs.existsSync(googleTokenPath())) fs.unlinkSync(googleTokenPath());
  return { connected: false, credentialsAvailable: fs.existsSync(googleCredentialsPath()) };
});

ipcMain.handle('google:sync', (_event, payload) => {
  if (DEMO_MODE) return { state: payload, summary: { uploaded: 0, downloaded: 0, deleted: 0, externalCalendarDownloaded: 0, projectsUploaded: 0, projectsDownloaded: 0 } };
  return syncGoogleState(payload);
});
ipcMain.handle('google:delete-task', (_event, task) => DEMO_MODE ? false : deleteGoogleTask(task));

ipcMain.handle('settings:auto-start', (_event, enabled) => {
  if (DEMO_MODE) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('settings:get-auto-start', () => DEMO_MODE ? false : app.getLoginItemSettings().openAtLogin);

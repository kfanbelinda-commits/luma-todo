const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, screen, nativeImage, safeStorage, shell } = require('electron');
const { taskToIcloudIcs, parseIcloudEvent, parseIcloudEventIdentity } = require('./main/icloud-ics.cjs');
const { syncCalendar } = require('./main/icloud-sync.cjs');
const {
  googleTaskLocalSnapshot,
  googleTaskRemoteSnapshot,
  reconcileGoogleTaskNative,
  googleTaskSnapshotEqual,
  normalizeGoogleCalendarSnapshot,
  reconcileGoogleCalendar,
  googleCalendarSnapshotEqual,
  remoteChangedSinceGoogleSnapshot,
} = require('./main/google-reconcile.cjs');
const { parseGoogleTaskNotes, buildGoogleTaskNotes } = require('./main/google-task-notes.cjs');
const { collectGoogleCalendarReads, classifyLumaDuplicates } = require('./main/google-sync-safety.cjs');
const { createPrivateExtensionManager, isIsoDateKey } = require('./main/private-extensions.cjs');
const { luckyDayMarkerIcs, markerUid, markerKey } = require('./main/luckyday-icloud.cjs');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { createLocalData, atomicJson } = require('./main/local-data.cjs');

const DEMO_MODE = !app.isPackaged && process.argv.includes('--demo');
const DEMO_RESET_MODE = DEMO_MODE && process.argv.includes('--demo-reset');
const DEMO_RESET_LIFELOG = DEMO_MODE && (DEMO_RESET_MODE || process.argv.includes('--demo-reset-lifelog'));
const ICLOUD_TEST_MODE = !app.isPackaged && process.argv.includes('--icloud-test');

// Demo data stays isolated. The iCloud experiment deliberately uses the real
// Luma userData so it can be tested against the user's actual Event database.
// The normal single-instance lock prevents production and the experiment from
// writing the same data file at the same time.
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
let autoUpdaterRef = null;
let downloadedUpdateInfo = null;
let updateCheckInFlight = null;
let installPromptOpen = false;
let isPinnedAlwaysOnTop = false;
let isDesktopHosted = false;
let desktopAttachTimer = null;
let desktopAttachRequestId = 0;
let desktopHostTransition = Promise.resolve(true);
let nativeModalDepth = 0;
let isExplicitlyHidden = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();

const EDGE_TAB_W = 36;
const EDGE_TAB_H = 40;
let edgeWindow = null;
const localData = createLocalData(app.getPath('userData'));
const privateExtensions = createPrivateExtensionManager({
  rootPath: () => app.getPath('userData'),
  protectSecret: (value) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存私人扩展授权');
    return safeStorage.encryptString(String(value));
  },
  unprotectSecret: (buffer) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法读取私人扩展授权');
    return safeStorage.decryptString(buffer);
  },
});

function dataPath() {
  return path.join(localData.root(), 'luma-data.json');
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

function lifelogPath() {
  return path.join(localData.root(), 'lifelog.json');
}

function lifelogMediaDir() {
  return path.join(localData.root(), 'lifelog-media');
}

function readLifelogStore() {
  const target = lifelogPath();
  if (!fs.existsSync(target)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return {
      version: Number(parsed && parsed.version) || 1,
      entries: parsed && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

function writeLifelogStore(store) {
  const target = lifelogPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    version: 1,
    entries: store && store.entries && typeof store.entries === 'object' ? store.entries : {},
  };
  atomicJson(target, payload);
  return payload;
}

function ensureDemoLifelog() {
  if (!DEMO_MODE) return;
  const target = lifelogPath();
  const mediaDir = lifelogMediaDir();
  if (DEMO_RESET_LIFELOG) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
  }
  if (fs.existsSync(target)) return;
  const { buildDemoLifelog } = require('./demo/lifelog-demo.cjs');
  const demo = buildDemoLifelog(new Date());
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const item of demo.media || []) {
    const dest = path.join(mediaDir, item.relativePath);
    if (item.fromFile) {
      fs.copyFileSync(item.fromFile, dest);
    } else if (item.buffer) {
      fs.writeFileSync(dest, item.buffer);
    } else if (item.svg != null) {
      fs.writeFileSync(dest, item.svg, 'utf8');
    }
  }
  writeLifelogStore({ version: 1, entries: demo.entries });
}

function lifelogMediaAbsolute(relativePath) {
  const safe = String(relativePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!safe.length || safe.some((part) => part === '..')) return null;
  const rootDir = path.resolve(lifelogMediaDir());
  const abs = path.resolve(rootDir, ...safe);
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (abs !== rootDir && !abs.toLowerCase().startsWith(rootWithSep.toLowerCase())) return null;
  return abs;
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
  hideEdgeWindow();
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

function hideEdgeWindow() {
  if (edgeWindow && !edgeWindow.isDestroyed()) edgeWindow.hide();
}

function placeEdgeWindow(area, right, y) {
  edgeWindow.setBounds({
    x: right ? area.x + area.width - EDGE_TAB_W : area.x,
    y: Math.max(area.y, Math.min(area.y + area.height - EDGE_TAB_H, y)),
    width: EDGE_TAB_W,
    height: EDGE_TAB_H,
  });
}

function ensureEdgeWindow() {
  if (edgeWindow && !edgeWindow.isDestroyed()) return edgeWindow;
  edgeWindow = new BrowserWindow({
    width: EDGE_TAB_W,
    height: EDGE_TAB_H,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#303339',
    webPreferences: {
      preload: path.join(__dirname, 'main', 'edge-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  edgeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  edgeWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  edgeWindow.loadFile(path.join(__dirname, 'src', 'edge.html')).catch((error) => {
    console.error('Luma edge failed to load:', error.message);
    revealMainWindow();
  });
  edgeWindow.once('ready-to-show', () => {
    if (isExplicitlyHidden && localData.status().closeAction === 'edge' && edgeWindow && !edgeWindow.isDestroyed()) {
      edgeWindow.showInactive();
    }
  });
  return edgeWindow;
}

function closeToPreference() {
  isExplicitlyHidden = true;
  cancelDesktopAttach();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  const st = localData.status();
  if (st.closeAction !== 'edge') {
    hideEdgeWindow();
    return;
  }
  const bounds = mainWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const right = st.edgeTabSide === 'right' ? true
    : st.edgeTabSide === 'left' ? false
    : bounds.x + bounds.width / 2 >= area.x + area.width / 2;
  const y = Number.isFinite(st.edgeTabY)
    ? st.edgeTabY
    : Math.max(area.y, Math.min(area.y + area.height - EDGE_TAB_H, bounds.y + 70));
  ensureEdgeWindow();
  placeEdgeWindow(area, right, y);
  if (!edgeWindow.webContents.isLoading()) edgeWindow.showInactive();
}

function isTrustedEdgeSender(event) {
  if (!edgeWindow || edgeWindow.isDestroyed()) return false;
  if (!event || event.sender !== edgeWindow.webContents) return false;
  const frameUrl = String(event.senderFrame?.url || '');
  const pageUrl = String(edgeWindow.webContents.getURL() || '');
  return Boolean(frameUrl && pageUrl && frameUrl === pageUrl && frameUrl.startsWith('file:'));
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


function icloudCredentialPath() {
  return path.join(app.getPath('userData'), 'icloud-calendar.enc');
}

function loadIcloudCredentials() {
  try {
    const encrypted = fs.readFileSync(icloudCredentialPath());
    if (!safeStorage.isEncryptionAvailable()) return null;
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    if (!parsed || !parsed.email || !parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIcloudCredentials(credentials) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储当前不可用，无法安全保存 iCloud 凭据');
  }
  const target = icloudCredentialPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, safeStorage.encryptString(JSON.stringify(credentials)));
}

function clearIcloudCredentials() {
  const target = icloudCredentialPath();
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function xmlLocalTagInner(xml, localName) {
  const pattern = new RegExp(
    '<(?:[A-Za-z0-9_-]+:)?' + localName + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?' + localName + '\\s*>',
    'i'
  );
  const match = pattern.exec(xml);
  return match ? match[1] : '';
}

function xmlLocalTagText(xml, localName) {
  return decodeXmlText(xmlLocalTagInner(xml, localName).replace(/<[^>]+>/g, ''));
}

function resolveCaldavHref(href, baseUrl) {
  if (!href) return '';
  return new URL(decodeXmlText(href), baseUrl).toString();
}

function icloudAuthHeader(credentials) {
  return 'Basic ' + Buffer.from(credentials.email + ':' + credentials.password, 'utf8').toString('base64');
}

async function icloudPropfind(url, credentials, depth, body) {
  const response = await fetch(url, {
    method: 'PROPFIND',
    redirect: 'follow',
    headers: {
      Authorization: icloudAuthHeader(credentials),
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml',
      'User-Agent': 'Luma-Todo/1.0 CalDAV'
    },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    const requestId = response.headers.get('x-apple-request-uuid')
      || response.headers.get('x-apple-jingle-correlation-key')
      || '';
    const suffix = requestId ? ' · Apple Request ID: ' + requestId : '';
    if (response.status === 401) {
      throw new Error('iCloud 身份验证被拒绝（HTTP 401）' + suffix);
    }
    if (response.status === 403) {
      throw new Error('iCloud 日历访问被拒绝（HTTP 403）' + suffix);
    }
    throw new Error('iCloud CalDAV 请求失败（HTTP ' + response.status + '）' + suffix);
  }
  return { text, url: response.url || url };
}

async function discoverIcloudCalendars(credentials) {
  const principalQuery = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

  let principalResponse;
  try {
    principalResponse = await icloudPropfind(
      'https://caldav.icloud.com/.well-known/caldav',
      credentials,
      0,
      principalQuery
    );
  } catch (error) {
    const message = String(error && error.message || error || '');
    if (/HTTP (400|404|405)/.test(message)) {
      principalResponse = await icloudPropfind(
        'https://caldav.icloud.com/',
        credentials,
        0,
        principalQuery
      );
    } else {
      throw error;
    }
  }
  const principalInner = xmlLocalTagInner(principalResponse.text, 'current-user-principal');
  const principalHref = xmlLocalTagText(principalInner, 'href');
  const principalUrl = resolveCaldavHref(principalHref, principalResponse.url);
  if (!principalUrl) throw new Error('已登录 iCloud，但未能发现 CalDAV Principal');

  const homeQuery = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><c:calendar-home-set/></d:prop></d:propfind>';
  const homeResponse = await icloudPropfind(principalUrl, credentials, 0, homeQuery);
  const homeInner = xmlLocalTagInner(homeResponse.text, 'calendar-home-set');
  const homeHref = xmlLocalTagText(homeInner, 'href');
  const calendarHomeUrl = resolveCaldavHref(homeHref, homeResponse.url);
  if (!calendarHomeUrl) throw new Error('已登录 iCloud，但未能发现日历目录');

  const listQuery = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>';
  const listResponse = await icloudPropfind(calendarHomeUrl, credentials, 1, listQuery);
  const responseBlocks = listResponse.text.match(
    /<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response\s*>/gi
  ) || [];
  const calendars = responseBlocks
    .filter((block) => /<(?:[A-Za-z0-9_-]+:)?calendar(?:\s|\/|>)/i.test(block))
    .map((block) => {
      const href = xmlLocalTagText(block, 'href');
      const name = xmlLocalTagText(block, 'displayname') || '未命名日历';
      return { name, url: resolveCaldavHref(href, listResponse.url) };
    })
    .filter((calendar) => calendar.url);

  if (!calendars.length) throw new Error('iCloud 已连接，但没有发现可访问的日历');
  return { principalUrl, calendarHomeUrl, calendars };
}

function publicIcloudStatus(credentials) {
  if (!credentials) return { connected: false, email: '', calendars: [], selectedCalendarUrl: '' };
  return {
    connected: true,
    email: credentials.email,
    calendars: Array.isArray(credentials.calendars) ? credentials.calendars : [],
    selectedCalendarUrl: credentials.selectedCalendarUrl || ''
  };
}

function icsSafeUidPart(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || crypto.randomUUID();
}

function ensureCalendarUrl(url) {
  return String(url || '').endsWith('/') ? String(url) : String(url || '') + '/';
}

function icloudCalendarResourceUrl(href, calendarUrl) {
  const target = new URL(href);
  const selected = new URL(ensureCalendarUrl(calendarUrl));
  if (target.protocol !== 'https:' || target.origin !== selected.origin || !target.pathname.startsWith(selected.pathname)
    || target.username || target.password || target.search || target.hash) {
    throw new Error('iCloud 事项地址不属于所选日历');
  }
  return target.href;
}

function unreadableIcloudEvent(ics, href, etag, calendar, reason) {
  const identity = parseIcloudEventIdentity(ics) || {};
  return {
    uid: identity.uid || '',
    title: identity.title || '',
    lumaTaskId: identity.lumaTaskId || '',
    lumaItemType: identity.lumaItemType || '',
    href,
    etag: etag || '',
    unreadable: true,
    readError: String(reason || 'Apple 日历事项暂时无法解析'),
    calendarUrl: calendar.url,
    calendarName: calendar.name,
  };
}

async function putIcloudEvent(resourceUrl, credentials, ics, etag) {
  const headers = {
    Authorization: icloudAuthHeader(credentials),
    'Content-Type': 'text/calendar; charset=utf-8',
    'User-Agent': 'Luma-Todo/1.0 CalDAV'
  };
  if (etag) headers['If-Match'] = etag;
  else headers['If-None-Match'] = '*';

  const response = await fetch(resourceUrl, {
    method: 'PUT',
    redirect: 'follow',
    headers,
    body: ics
  });

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 412) {
      throw Object.assign(new Error('iCloud 日程已在其他设备发生变化'), { status: 412 });
    }
    const requestId = response.headers.get('x-apple-request-uuid')
      || response.headers.get('x-apple-jingle-correlation-key')
      || '';
    const suffix = requestId ? ' · Apple Request ID: ' + requestId : '';
    throw new Error('写入 iCloud 日历失败（HTTP ' + response.status + '）' + suffix + (text ? '' : ''));
  }

  return response.headers.get('etag') || '';
}

async function deleteIcloudEvent(resourceUrl, credentials, etag) {
  const headers = {
    Authorization: icloudAuthHeader(credentials),
    'User-Agent': 'Luma-Todo/1.0 CalDAV'
  };
  if (etag) headers['If-Match'] = etag;

  const response = await fetch(resourceUrl, {
    method: 'DELETE',
    redirect: 'follow',
    headers
  });

  if (response.ok || response.status === 404 || response.status === 410) return true;
  const text = await response.text();
  if (response.status === 412) {
    throw Object.assign(new Error('iCloud 日程已在其他设备发生变化，暂未删除'), { status: 412 });
  }
  const requestId = response.headers.get('x-apple-request-uuid')
    || response.headers.get('x-apple-jingle-correlation-key')
    || '';
  const suffix = requestId ? ' · Apple Request ID: ' + requestId : '';
  throw new Error('删除 iCloud 日历事项失败（HTTP ' + response.status + '）' + suffix + (text ? '' : ''));
}


async function listIcloudCalendarEvents(credentials, calendar) {
  const body = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
    + '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
    + '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>'
    + '</c:calendar-query>';

  const response = await fetch(calendar.url, {
    method: 'REPORT',
    redirect: 'follow',
    headers: {
      Authorization: icloudAuthHeader(credentials),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml',
      'User-Agent': 'Luma-Todo/1.0 CalDAV'
    },
    body
  });

  const xml = await response.text();
  if (!response.ok) throw new Error('读取 iCloud 日历失败（HTTP ' + response.status + '）');

  const blocks = xml.match(
    /<(?:[A-Za-z0-9_-]+:)?response\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?response\s*>/gi
  ) || [];

  if (!/<(?:[A-Za-z0-9_-]+:)?multistatus\b/i.test(xml)
    || !/<\/(?:[A-Za-z0-9_-]+:)?multistatus\s*>\s*$/i.test(xml)
    || (xml.match(/<(?:[A-Za-z0-9_-]+:)?response\b/gi) || []).length !== blocks.length) {
    throw new Error('iCloud 日历列表不完整，已停止同步');
  }

  const items = [];
  for (const block of blocks) {
    const rawHref = xmlLocalTagText(block, 'href');
    if (!rawHref) throw new Error('iCloud 日历列表缺少事项地址，已停止同步');
    const href = icloudCalendarResourceUrl(resolveCaldavHref(rawHref, response.url || calendar.url), calendar.url);
    const etag = decodeXmlText(xmlLocalTagText(block, 'getetag'));
    const calendarData = decodeXmlText(xmlLocalTagInner(block, 'calendar-data'));
    const parsed = parseIcloudEvent(calendarData, href, etag, calendar);
    if (parsed) {
      items.push(parsed);
      continue;
    }

    try {
      const fallback = await getIcloudEvent(href, credentials, calendar, { allowUnreadable: true });
      if (fallback) items.push(fallback);
    } catch (error) {
      items.push(unreadableIcloudEvent(calendarData, href, etag, calendar, error.message));
    }
  }
  return items;
}

function ensureAppleCalendarProject(state) {
  state.projects ??= [];
  let project = state.projects.find((item) => item.id === 'apple-calendar');
  if (project) {
    project.name = 'Apple 日历';
    project.color = '#8b93a3';
    return project;
  }
  project = {
    id: 'apple-calendar',
    name: 'Apple 日历',
    color: '#8b93a3',
    order: Math.max(-1, ...state.projects.map((item) => Number(item.order) || 0)) + 1,
    updatedAt: Date.now(),
  };
  state.projects.push(project);
  state.projectsUpdatedAt = Date.now();
  return project;
}

async function getIcloudEvent(resourceUrl, credentials, calendar, options = {}) {
  const response = await fetch(resourceUrl, {
    method: 'GET', redirect: 'error',
    headers: { Authorization: icloudAuthHeader(credentials), Accept: 'text/calendar', 'User-Agent': 'Luma-Todo/1.0 CalDAV' }
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error('读取 iCloud 事项失败（HTTP ' + response.status + '）');
  const ics = await response.text();
  const etag = response.headers.get('etag') || '';
  const remote = parseIcloudEvent(ics, resourceUrl, etag, calendar);
  if (!remote) {
    if (options.allowUnreadable) return unreadableIcloudEvent(ics, resourceUrl, etag, calendar, 'Apple 日历事项格式暂不支持');
    throw new Error('iCloud 事项无法解析，暂未修改');
  }
  return remote;
}

async function syncIcloudEvents(state, calendarUrl) {
  const credentials = loadIcloudCredentials();
  if (!credentials) throw new Error('iCloud 尚未连接');
  const calendar = (credentials.calendars || []).find((item) => item.url === calendarUrl);
  if (!calendar) throw new Error('请先选择一个 iCloud 日历');
  if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.projects)) throw new Error('Luma 同步数据无效');
  const resource = (href) => icloudCalendarResourceUrl(href, calendar.url);
  const result = await syncCalendar(state, calendar, {
    list: async () => (await listIcloudCalendarEvents(credentials, calendar)).filter((item) => !item?.luckyDayMarker),
    get: (href) => getIcloudEvent(resource(href), credentials, calendar),
    put: (href, task, uid, etag) => putIcloudEvent(resource(href), credentials, taskToIcloudIcs(task, uid), etag),
    remove: (href, etag) => deleteIcloudEvent(resource(href), credentials, etag),
    uid: (id) => 'luma-' + icsSafeUidPart(id) + '@luma-todo',
    safeId: icsSafeUidPart,
    ensureProject: ensureAppleCalendarProject,
  });
  credentials.selectedCalendarUrl = calendar.url;
  saveIcloudCredentials(credentials);
  return result;
}

function localCalendarDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function luckyDayDefaultSyncRange() {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() - 30);
  const end = new Date();
  end.setHours(12, 0, 0, 0);
  end.setMonth(end.getMonth() + 18);
  return { startDate: localCalendarDateKey(start), endDate: localCalendarDateKey(end) };
}

function luckyDayIcloudStatus() {
  const credentials = loadIcloudCredentials();
  if (!credentials) return { connected: false, calendars: [], selectedCalendarUrl: '' };
  return {
    connected: true,
    calendars: Array.isArray(credentials.calendars) ? credentials.calendars : [],
    selectedCalendarUrl: String(credentials.luckyDayCalendarUrl || ''),
  };
}

async function syncLuckyDayIcloudMarkers(calendarUrl, options = {}) {
  const credentials = loadIcloudCredentials();
  if (!credentials) throw new Error('请先连接 Apple 日历');
  const calendar = (credentials.calendars || []).find((item) => item.url === calendarUrl);
  if (!calendar) throw new Error('请选择 LuckyDay 使用的 iCloud 日历');

  const startDate = String(options.startDate || '');
  const endDate = String(options.endDate || '');
  if (!isIsoDateKey(startDate) || !isIsoDateKey(endDate) || endDate < startDate) {
    throw new Error('LuckyDay iCloud 同步日期范围不正确');
  }

  const payload = privateExtensions.call('luckyday', 'getDayMarks', { startDate, endDate });
  const marks = Array.isArray(payload?.marks) ? payload.marks : [];
  const expected = new Map(marks.map((mark) => [markerKey(mark), mark]));
  const existing = (await listIcloudCalendarEvents(credentials, calendar))
    .filter((item) => item?.luckyDayMarker && item.luckyDayDate >= startDate && item.luckyDayDate <= endDate);
  const existingByKey = new Map(existing.map((item) => [markerKey(item), item]));

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const [key, mark] of expected) {
    const current = existingByKey.get(key);
    const expectedTitle = mark.type === 'cheng' ? '成日' : '除日';
    const uid = markerUid(mark);
    if (current && current.uid === uid && current.title === expectedTitle && current.dueDate === mark.dateKey) {
      unchanged += 1;
      continue;
    }

    const href = current?.href || icloudCalendarResourceUrl(
      new URL(icsSafeUidPart(uid) + '.ics', ensureCalendarUrl(calendar.url)).href,
      calendar.url
    );
    await putIcloudEvent(href, credentials, luckyDayMarkerIcs(mark), current?.etag || '');
    if (current) updated += 1;
    else created += 1;
  }

  for (const [key, current] of existingByKey) {
    if (expected.has(key)) continue;
    await deleteIcloudEvent(current.href, credentials, current.etag || '');
    deleted += 1;
  }

  credentials.luckyDayCalendarUrl = calendar.url;
  saveIcloudCredentials(credentials);
  return {
    calendarName: calendar.name,
    calendarUrl: calendar.url,
    startDate,
    endDate,
    created,
    updated,
    deleted,
    unchanged,
    total: marks.length,
  };
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
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Google API 请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function googleMissingRemote(error) {
  return error && (Number(error.status) === 404 || Number(error.status) === 410);
}

async function deleteGoogleCalendarEvent(calendarId, eventId) {
  if (!eventId) return false;
  try {
    await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId || 'primary')}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  } catch (error) {
    if (!googleMissingRemote(error)) throw error;
  }
  return true;
}

async function deleteGoogleTasksItem(taskId) {
  if (!taskId) return false;
  try {
    await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
  } catch (error) {
    if (!googleMissingRemote(error)) throw error;
  }
  return true;
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

const LUMA_METADATA_NOTES_PREFIX = '[Luma Todo Sync Metadata v1]\\n';
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
  return parseGoogleTaskNotes(remoteTask?.notes).metadata;
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

function taskNotes(state, task, existingNotes = '') {
  const metadata = {
    version: 4,
    taskId: task.id,
    ...projectMetadataForTask(state, task),
    order: Number(task.order ?? task.createdAt ?? 0),
    reminder: task.reminder ?? null,
    time: /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(task.time || '') ? task.time : '',
    updatedAt: Number(task.updatedAt || task.createdAt || Date.now()),
  };
  return buildGoogleTaskNotes(existingNotes, metadata);
}

function googleTaskBody(state, task, existingNotes = '') {
  return {
    title: task.title,
    notes: taskNotes(state, task, existingNotes),
    status: task.completed ? 'completed' : 'needsAction',
    completed: task.completed ? new Date(task.updatedAt || Date.now()).toISOString() : null,
    due: task.dueDate ? `${task.dueDate}T00:00:00.000Z` : null,
  };
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

function googleCalendarLocalSnapshot(task) {
  return normalizeGoogleCalendarSnapshot(task);
}

function googleCalendarRemoteSnapshot(event, fallbackTask) {
  const copy = structuredClone(fallbackTask || {});
  applyCalendarEvent(copy, event);
  return normalizeGoogleCalendarSnapshot(copy);
}

function applyGoogleCalendarSnapshot(task, snapshot) {
  for (const field of [
    'title', 'dueDate', 'time', 'endDate', 'endTime',
    'itemType', 'eventColor', 'projectId', 'completed', 'reminder', 'order',
  ]) task[field] = snapshot[field];
}

function applyGoogleTaskNative(task, snapshot) {
  task.title = snapshot.title || task.title;
  task.itemType = 'todo';
  task.completed = Boolean(snapshot.completed);
  task.dueDate = snapshot.dueDate || '';
  task.endDate = '';
  task.endTime = '';
}

function applyGoogleTaskMetadata(task, details) {
  if (!details) return;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(details.time || '')) task.time = details.time;
  else if (Object.hasOwn(details, 'time')) task.time = '';
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
  let calendars;
  try {
    calendars = await listGoogleCalendars();
  } catch (error) {
    return {
      events: [],
      failedCalendarIds: new Set(),
      failures: [{ calendarId: '*', calendarName: 'Google Calendar', error: String(error.message || error) }],
      allCalendarsUnavailable: true,
      primaryCalendarId: '',
    };
  }

  const collected = await collectGoogleCalendarReads(
    calendars,
    (calendar, lumaOnly) => listEventsForCalendar(calendar, { lumaOnly })
  );
  const unique = new Map();
  collected.events.forEach((event) => unique.set(calendarEventKey(calendarIdForEvent(event), event.id), event));
  return {
    events: [...unique.values()],
    failedCalendarIds: collected.failedCalendarIds,
    failures: collected.failures,
    allCalendarsUnavailable: false,
    primaryCalendarId: String(calendars.find((calendar) => calendar.primary)?.id || ''),
  };
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
  state.googleDeletedItems = Array.isArray(state.googleDeletedItems) ? state.googleDeletedItems : [];
  const [calendarResult, tasksResult] = await Promise.allSettled([
    listGoogleCalendarEvents(),
    listGoogleTasks(),
  ]);
  const calendarRead = calendarResult.status === 'fulfilled'
    ? calendarResult.value
    : {
        events: [],
        failedCalendarIds: new Set(),
        failures: [{ calendarId: '*', calendarName: 'Google Calendar', error: String(calendarResult.reason?.message || calendarResult.reason || '读取失败') }],
        allCalendarsUnavailable: true,
        primaryCalendarId: '',
      };
  const googleTasksAvailable = tasksResult.status === 'fulfilled';
  let calendarEvents = Array.isArray(calendarRead.events) ? calendarRead.events : [];
  let googleTasks = googleTasksAvailable ? (tasksResult.value || []) : [];

  const syncTime = Date.now();
  const retainedTasks = [];
  let uploaded = 0;
  let downloaded = 0;
  let deleted = 0;
  let conflicts = 0;
  let failed = (calendarRead.failures || []).length + (googleTasksAvailable ? 0 : 1);
  let remoteDeletedCount = 0;
  let externalCalendarDownloaded = 0;
  let duplicatesRemoved = 0;
  let duplicatesDeferred = 0;
  const failureMessages = (calendarRead.failures || []).map((item) =>
    item.calendarName + '：' + item.error
  );
  if (!googleTasksAvailable) {
    failureMessages.push('Google Tasks：' + String(tasksResult.reason?.message || tasksResult.reason || '读取失败'));
  }

  const failedCalendarIds = calendarRead.failedCalendarIds instanceof Set
    ? calendarRead.failedCalendarIds
    : new Set(calendarRead.failedCalendarIds || []);
  const calendarUnavailable = (calendarId = 'primary') => {
    if (calendarRead.allCalendarsUnavailable) return true;
    const requested = String(calendarId || 'primary');
    const resolved = requested === 'primary' && calendarRead.primaryCalendarId
      ? String(calendarRead.primaryCalendarId)
      : requested;
    return failedCalendarIds.has(resolved);
  };

  const localByTaskId = new Map();
  const linkedCalendarKeyByTaskId = new Map();
  const linkedGoogleTaskByTaskId = new Map();
  for (const task of state.tasks) {
    if (!task?.id) continue;
    localByTaskId.set(String(task.id), task);
    if (task.googleCalendarEventId) linkedCalendarKeyByTaskId.set(String(task.id), String(task.googleCalendarEventId));
    if (task.googleTaskId) linkedGoogleTaskByTaskId.set(String(task.id), String(task.googleTaskId));
  }
  for (const entry of state.googleDeletedItems) {
    const id = String(entry?.task?.id || '');
    if (!id) continue;
    if (!localByTaskId.has(id) && entry.task) localByTaskId.set(id, entry.task);
    if (entry.googleCalendarEventId) linkedCalendarKeyByTaskId.set(id, String(entry.googleCalendarEventId));
    if (entry.googleTaskId) linkedGoogleTaskByTaskId.set(id, String(entry.googleTaskId));
  }

  const calendarDuplicates = classifyLumaDuplicates(calendarEvents, {
    taskId: (event) => event.extendedProperties?.private?.lumaTodo === 'true'
      ? calendarTaskDetails(event).taskId
      : '',
    remoteKey: (event) => String(event.id || ''),
    linkedKeyByTaskId: linkedCalendarKeyByTaskId,
    fingerprint: (event) => {
      const id = String(calendarTaskDetails(event).taskId || '');
      return JSON.stringify(googleCalendarRemoteSnapshot(event, localByTaskId.get(id) || {}));
    },
    updatedAt: (event) => Date.parse(event.updated || 0) || 0,
  });
  calendarEvents = calendarDuplicates.kept;
  duplicatesDeferred += calendarDuplicates.divergentDuplicates.length;
  for (const record of calendarDuplicates.safeDuplicates) {
    const event = record.duplicate;
    try {
      await deleteGoogleCalendarEvent(calendarIdForEvent(event), event.id);
      duplicatesRemoved += 1;
    } catch (error) {
      failed += 1;
      failureMessages.push('重复 Google Calendar 事项 ' + String(event.id || '') + '：' + String(error.message || error));
    }
  }

  const googleTaskDuplicates = classifyLumaDuplicates(googleTasks, {
    taskId: (remoteTask) => googleTaskMetadata(remoteTask)?.taskId || '',
    remoteKey: (remoteTask) => String(remoteTask.id || ''),
    linkedKeyByTaskId: linkedGoogleTaskByTaskId,
    fingerprint: (remoteTask) => {
      const parts = parseGoogleTaskNotes(remoteTask?.notes);
      const metadata = { ...(parts.metadata || {}) };
      delete metadata.version;
      delete metadata.updatedAt;
      return JSON.stringify({
        native: googleTaskRemoteSnapshot(remoteTask),
        metadata,
        userNotes: parts.userNotes || '',
      });
    },
    updatedAt: (remoteTask) => Date.parse(remoteTask.updated || 0) || 0,
  });
  googleTasks = googleTaskDuplicates.kept;
  duplicatesDeferred += googleTaskDuplicates.divergentDuplicates.length;
  if (googleTasksAvailable) {
    for (const record of googleTaskDuplicates.safeDuplicates) {
      const remoteTask = record.duplicate;
      try {
        await deleteGoogleTasksItem(remoteTask.id);
        duplicatesRemoved += 1;
      } catch (error) {
        failed += 1;
        failureMessages.push('重复 Google Task ' + String(remoteTask.id || '') + '：' + String(error.message || error));
      }
    }
  }

  const calendarByKey = new Map(calendarEvents.map((event) => [calendarEventKey(calendarIdForEvent(event), event.id), event]));
  const calendarById = new Map(calendarEvents.map((event) => [event.id, event]));
  const googleTasksById = new Map(googleTasks.map((task) => [task.id, task]));
  const calendarByTaskId = new Map(calendarEvents.map((event) => [calendarTaskDetails(event).taskId, event]).filter(([id]) => id));
  const lumaGoogleTasks = googleTasks.filter((task) => googleTaskMetadata(task));
  const googleTaskByTaskId = new Map(lumaGoogleTasks.map((task) => [googleTaskMetadata(task)?.taskId, task]).filter(([id]) => id));
  const consumedCalendarIds = new Set();
  const consumedGoogleTaskIds = new Set();
  const remoteProjectMetadata = googleTasksAvailable
    ? applyRemoteProjectMetadata(state, googleTasks)
    : { metadataTask: null, remoteUpdatedAt: 0, downloaded: 0, unavailable: true };
  const findCalendarEvent = (task) => {
    if (!task.googleCalendarEventId) return null;
    return calendarByKey.get(calendarEventKey(task.googleCalendarId, task.googleCalendarEventId))
      || calendarById.get(task.googleCalendarEventId)
      || null;
  };

  // A local delete is compared with the remote version before DELETE. If the
  // remote item changed after the last successful snapshot, preserve both
  // states and ask the user instead of silently deleting unseen edits.
  const pendingGoogleDeletes = [];
  const deleteOtherGoogleIdentity = async (entry, source) => {
    if (source !== 'tasks' && entry.googleTaskId) {
      if (!googleTasksAvailable) throw new Error('Google Tasks 暂时无法读取，保留待删除记录');
      await deleteGoogleTasksItem(entry.googleTaskId);
    }
    if (source !== 'calendar' && entry.googleCalendarEventId) {
      if (calendarUnavailable(entry.googleCalendarId || 'primary')) {
        throw new Error('对应 Google Calendar 暂时无法读取，保留待删除记录');
      }
      await deleteGoogleCalendarEvent(entry.googleCalendarId || 'primary', entry.googleCalendarEventId);
    }
  };
  for (const entry of state.googleDeletedItems) {
    const source = entry.source === 'calendar' ? 'calendar' : 'tasks';
    const previousConflict = entry.googleConflict;
    const resolution = entry.googleResolution;
    delete entry.googleSyncError;

    if (source === 'tasks' && !googleTasksAvailable) {
      entry.googleSyncError = 'Google Tasks 暂时无法读取；未判断远端删除';
      pendingGoogleDeletes.push(entry);
      continue;
    }
    if (source === 'calendar' && calendarUnavailable(entry.googleCalendarId || 'primary')) {
      entry.googleSyncError = '对应 Google Calendar 暂时无法读取；未判断远端删除';
      pendingGoogleDeletes.push(entry);
      continue;
    }

    try {
    if (source === 'tasks' && entry.googleTaskId) {
      const remote = googleTasksById.get(entry.googleTaskId) || null;
      if (remote) consumedGoogleTaskIds.add(remote.id);
      if (!remote || remote.deleted) {
        await deleteOtherGoogleIdentity(entry, 'tasks');
        remoteDeletedCount += 1;
        continue;
      }

      const remoteUpdatedAt = Date.parse(remote.updated || 0);
      const remoteSnapshot = googleTaskRemoteSnapshot(remote);
      const baseSnapshot = entry.task?.lastGoogleTaskSnapshot || null;
      const previousRemoteUpdatedAt = Number(entry.task?.googleRemoteUpdatedAt || 0);
      const remoteChanged = remoteChangedSinceGoogleSnapshot({
        base: baseSnapshot,
        remote: remoteSnapshot,
        previousRemoteUpdatedAt,
        remoteUpdatedAt,
        equalSnapshot: googleTaskSnapshotEqual,
      });
      const resolutionFresh = Boolean(
        previousConflict
        && resolution
        && resolution.detectedAt === previousConflict.detectedAt
        && (!previousConflict.remoteUpdatedAt || previousConflict.remoteUpdatedAt === remoteUpdatedAt)
      );

      if (remoteChanged && !(resolutionFresh && resolution.choice === 'local')) {
        if (resolutionFresh && resolution.choice === 'remote' && entry.task) {
          const restored = structuredClone(entry.task);
          if (state.tasks.some((task) => task.id === restored.id)) {
            entry.googleSyncError = '恢复 Google Task 时发现相同本地 ID';
            pendingGoogleDeletes.push(entry);
            continue;
          }
          applyGoogleTaskNative(restored, remoteSnapshot);
          const details = googleTaskMetadata(remote);
          if (details) {
            applyGoogleTaskMetadata(restored, details);
            ensureProject(state, details);
          }
          restored.googleTaskId = remote.id;
          restored.googleRemoteUpdatedAt = remoteUpdatedAt;
          restored.lastGoogleTaskSnapshot = googleTaskLocalSnapshot(restored);
          restored.lastGoogleSyncAt = syncTime;
          restored.updatedAt = remoteUpdatedAt;
          await deleteOtherGoogleIdentity(entry, 'tasks');
          delete restored.googleConflict;
          delete restored.googleResolution;
          retainedTasks.push(restored);
          downloaded += 1;
          continue;
        }

        entry.googleConflict = {
          source: 'tasks',
          type: 'local-deleted-remote-modified',
          detectedAt: syncTime,
          remoteUpdatedAt,
          local: null,
          remote: remoteSnapshot,
          conflictFields: [],
        };
        delete entry.googleResolution;
        conflicts += 1;
        pendingGoogleDeletes.push(entry);
        continue;
      }

      await deleteGoogleTasksItem(remote.id);
      await deleteOtherGoogleIdentity(entry, 'tasks');
      remoteDeletedCount += 1;
      continue;
    }

    if (source === 'calendar' && entry.googleCalendarEventId) {
      const remote = calendarByKey.get(calendarEventKey(entry.googleCalendarId, entry.googleCalendarEventId))
        || calendarById.get(entry.googleCalendarEventId)
        || null;
      if (remote) consumedCalendarIds.add(calendarEventKey(calendarIdForEvent(remote), remote.id));
      if (!remote || remote.status === 'cancelled') {
        await deleteOtherGoogleIdentity(entry, 'calendar');
        remoteDeletedCount += 1;
        continue;
      }

      const remoteUpdatedAt = Date.parse(remote.updated || 0);
      const remoteSnapshot = googleCalendarRemoteSnapshot(remote, entry.task || {});
      const baseSnapshot = entry.task?.lastGoogleCalendarSnapshot || null;
      const previousRemoteUpdatedAt = Number(entry.task?.googleRemoteUpdatedAt || 0);
      const remoteChanged = remoteChangedSinceGoogleSnapshot({
        base: baseSnapshot,
        remote: remoteSnapshot,
        previousRemoteUpdatedAt,
        remoteUpdatedAt,
        equalSnapshot: googleCalendarSnapshotEqual,
      });
      const resolutionFresh = Boolean(
        previousConflict
        && resolution
        && resolution.detectedAt === previousConflict.detectedAt
        && (!previousConflict.remoteUpdatedAt || previousConflict.remoteUpdatedAt === remoteUpdatedAt)
      );

      if (remoteChanged && !(resolutionFresh && resolution.choice === 'local')) {
        if (resolutionFresh && resolution.choice === 'remote' && entry.task) {
          const restored = structuredClone(entry.task);
          if (state.tasks.some((task) => task.id === restored.id)) {
            entry.googleSyncError = '恢复 Google Calendar 事项时发现相同本地 ID';
            pendingGoogleDeletes.push(entry);
            continue;
          }
          applyGoogleCalendarSnapshot(restored, remoteSnapshot);
          const details = calendarTaskDetails(remote);
          ensureProject(state, details);
          restored.googleCalendarEventId = remote.id;
          restored.googleCalendarId = calendarIdForEvent(remote);
          restored.googleRemoteUpdatedAt = remoteUpdatedAt;
          restored.lastGoogleCalendarSnapshot = googleCalendarLocalSnapshot(restored);
          restored.lastGoogleSyncAt = syncTime;
          restored.updatedAt = remoteUpdatedAt;
          await deleteOtherGoogleIdentity(entry, 'calendar');
          delete restored.googleConflict;
          delete restored.googleResolution;
          retainedTasks.push(restored);
          downloaded += 1;
          continue;
        }

        entry.googleConflict = {
          source: 'calendar',
          type: 'local-deleted-remote-modified',
          detectedAt: syncTime,
          remoteUpdatedAt,
          local: null,
          remote: remoteSnapshot,
          conflictFields: [],
        };
        delete entry.googleResolution;
        conflicts += 1;
        pendingGoogleDeletes.push(entry);
        continue;
      }

      await deleteGoogleCalendarEvent(calendarIdForEvent(remote), remote.id);
      await deleteOtherGoogleIdentity(entry, 'calendar');
      remoteDeletedCount += 1;
      continue;
    }

    // No usable remote identity remains; the local delete is already complete.
    remoteDeletedCount += 1;
    } catch (error) {
      entry.googleSyncError = String(error.message || error || 'Google 删除失败');
      failed += 1;
      failureMessages.push('待删除事项：' + entry.googleSyncError);
      if (!pendingGoogleDeletes.includes(entry)) pendingGoogleDeletes.push(entry);
    }
  }
  state.googleDeletedItems = pendingGoogleDeletes;

  for (const task of state.tasks) {
    task.updatedAt ??= task.createdAt || Date.now();
    delete task.googleSyncError;

    try {
      if ((task.googleCalendarExternal || task.syncTarget === 'external-calendar')
        && calendarUnavailable(task.googleCalendarId || 'primary')) {
        task.googleSyncError = '对应 Google Calendar 暂时无法读取；本地事项保持不变';
        retainedTasks.push(task);
        continue;
      }
      if (task.syncTarget === 'calendar' && task.dueDate) {
        if (calendarUnavailable(task.googleCalendarId || 'primary')) {
          task.googleSyncError = '对应 Google Calendar 暂时无法读取；未判断远端删除或更新';
          retainedTasks.push(task);
          continue;
        }
        if (task.googleTaskId && !googleTasksAvailable) {
          task.googleSyncError = 'Google Tasks 暂时无法读取；未执行 Tasks → Calendar 转换';
          retainedTasks.push(task);
          continue;
        }
      }
      if (task.syncTarget === 'tasks') {
        if (!googleTasksAvailable) {
          task.googleSyncError = 'Google Tasks 暂时无法读取；本地任务保持不变';
          retainedTasks.push(task);
          continue;
        }
        if (task.googleCalendarEventId && calendarUnavailable(task.googleCalendarId || 'primary')) {
          task.googleSyncError = '对应 Google Calendar 暂时无法读取；未执行 Calendar → Tasks 转换';
          retainedTasks.push(task);
          continue;
        }
      }

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
        await deleteGoogleTasksItem(task.googleTaskId);
        task.googleTaskId = null;
      }

      const localWasChanged = localChangedSinceSync(task);
      const foundRemote = findCalendarEvent(task) || calendarByTaskId.get(task.id);
      if (foundRemote) consumedCalendarIds.add(calendarEventKey(calendarIdForEvent(foundRemote), foundRemote.id));
      const remoteDeleted = Boolean(task.googleCalendarEventId && (!foundRemote || foundRemote.status === 'cancelled'));
      const remote = foundRemote?.status === 'cancelled' ? null : foundRemote;
      const remoteUpdatedAt = Date.parse(foundRemote?.updated || 0);
      const remoteDetails = remote ? calendarTaskDetails(remote) : null;
      const needsMetadataUpgrade = Boolean(remote && Number(remoteDetails?.version || 1) < 2);
      const localSnapshot = googleCalendarLocalSnapshot(task);
      const baseSnapshot = task.lastGoogleCalendarSnapshot || null;
      const previousConflict = task.googleConflict?.source === 'calendar' ? task.googleConflict : null;
      const resolution = task.googleResolution;
      const resolutionFresh = Boolean(
        previousConflict
        && resolution
        && resolution.detectedAt === previousConflict.detectedAt
        && (!previousConflict.remoteUpdatedAt || previousConflict.remoteUpdatedAt === remoteUpdatedAt)
      );

      if (remoteDeleted) {
        if (resolutionFresh && resolution.choice === 'remote') {
          deleted += 1;
          continue;
        }
        if (!(resolutionFresh && resolution.choice === 'local')) {
          if (localWasChanged || !baseSnapshot) {
            task.googleConflict = {
              source: 'calendar',
              type: 'remote-deleted-local-modified',
              detectedAt: syncTime,
              remoteUpdatedAt,
              local: localSnapshot,
              remote: null,
              conflictFields: [],
            };
            delete task.googleResolution;
            conflicts += 1;
            retainedTasks.push(task);
            continue;
          }
          deleted += 1;
          continue;
        }

        task.googleCalendarEventId = null;
        task.googleCalendarId = null;
        const saved = await googleRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          body: JSON.stringify(calendarBody(state, task)),
        });
        task.googleCalendarEventId = saved.id;
        task.googleCalendarId = 'primary';
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        task.lastGoogleCalendarSnapshot = googleCalendarLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
        uploaded += 1;
      } else if (!remote) {
        const saved = await googleRequest('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST',
          body: JSON.stringify(calendarBody(state, task)),
        });
        task.googleCalendarEventId = saved.id;
        task.googleCalendarId = 'primary';
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        task.lastGoogleCalendarSnapshot = googleCalendarLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
        uploaded += 1;
      } else {
        const remoteSnapshot = googleCalendarRemoteSnapshot(remote, task);
        const remoteChangedHint = remoteUpdatedAt > Number(task.googleRemoteUpdatedAt || 0);
        let decision;

        if (resolutionFresh && resolution.choice === 'local') {
          decision = { action: 'local', merged: localSnapshot, conflictFields: [] };
        } else if (resolutionFresh && resolution.choice === 'remote') {
          decision = { action: 'remote', merged: remoteSnapshot, conflictFields: [] };
        } else {
          decision = reconcileGoogleCalendar({
            base: baseSnapshot,
            local: localSnapshot,
            remote: remoteSnapshot,
            localChangedHint: localWasChanged,
            remoteChangedHint,
          });
        }

        if (decision.action === 'conflict') {
          task.googleConflict = {
            source: 'calendar',
            type: decision.type,
            detectedAt: syncTime,
            remoteUpdatedAt,
            local: localSnapshot,
            remote: remoteSnapshot,
            conflictFields: decision.conflictFields,
          };
          delete task.googleResolution;
          conflicts += 1;
          retainedTasks.push(task);
          continue;
        }

        const changedByRemote = !googleCalendarSnapshotEqual(localSnapshot, decision.merged);
        if (changedByRemote) {
          applyGoogleCalendarSnapshot(task, decision.merged);
          if (remoteDetails) ensureProject(state, remoteDetails);
          downloaded += 1;
          if (!localWasChanged) task.updatedAt = remoteUpdatedAt;
        }

        const shouldPush = decision.action === 'local'
          || decision.action === 'merge'
          || localWasChanged
          || needsMetadataUpgrade;
        if (shouldPush) {
          const saved = await googleRequest(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarIdForEvent(remote))}/events/${encodeURIComponent(remote.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(calendarBody(state, task)),
          });
          task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
          uploaded += 1;
        } else {
          task.googleRemoteUpdatedAt = remoteUpdatedAt;
        }

        task.googleCalendarEventId = remote.id;
        task.googleCalendarId = calendarIdForEvent(remote);
        task.lastGoogleCalendarSnapshot = googleCalendarLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
      }
    } else if (task.syncTarget === 'tasks') {
      if (task.googleCalendarEventId) {
        consumedCalendarIds.add(calendarEventKey(task.googleCalendarId, task.googleCalendarEventId));
        await deleteGoogleCalendarEvent(task.googleCalendarId || 'primary', task.googleCalendarEventId);
        task.googleCalendarEventId = null;
        task.googleCalendarId = null;
      }

      const localWasChanged = localChangedSinceSync(task);
      const foundRemote = (task.googleTaskId ? googleTasksById.get(task.googleTaskId) : null) || googleTaskByTaskId.get(task.id);
      if (foundRemote) consumedGoogleTaskIds.add(foundRemote.id);
      const remoteDeleted = Boolean(task.googleTaskId && (!foundRemote || foundRemote.deleted));
      const remote = foundRemote?.deleted ? null : foundRemote;
      const remoteUpdatedAt = Date.parse(foundRemote?.updated || 0);
      const remoteDetails = remote ? googleTaskMetadata(remote) : null;
      const needsMetadataUpgrade = Boolean(remote && (!remoteDetails || Number(remoteDetails.version || 1) < 4));
      const localSnapshot = googleTaskLocalSnapshot(task);
      const baseSnapshot = task.lastGoogleTaskSnapshot || null;
      const previousConflict = task.googleConflict?.source === 'tasks' ? task.googleConflict : null;
      const resolution = task.googleResolution;
      const resolutionFresh = Boolean(
        previousConflict
        && resolution
        && resolution.detectedAt === previousConflict.detectedAt
        && (!previousConflict.remoteUpdatedAt || previousConflict.remoteUpdatedAt === remoteUpdatedAt)
      );

      if (remoteDeleted) {
        if (resolutionFresh && resolution.choice === 'remote') {
          deleted += 1;
          continue;
        }
        if (!(resolutionFresh && resolution.choice === 'local')) {
          if (localWasChanged || !baseSnapshot) {
            task.googleConflict = {
              source: 'tasks',
              type: 'remote-deleted-local-modified',
              detectedAt: syncTime,
              remoteUpdatedAt,
              local: localSnapshot,
              remote: null,
              conflictFields: [],
            };
            delete task.googleResolution;
            conflicts += 1;
            retainedTasks.push(task);
            continue;
          }
          deleted += 1;
          continue;
        }

        task.googleTaskId = null;
        const saved = await googleRequest('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
          method: 'POST',
          body: JSON.stringify(googleTaskBody(state, task)),
        });
        task.googleTaskId = saved.id;
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        task.lastGoogleTaskSnapshot = googleTaskLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
        uploaded += 1;
      } else if (!remote) {
        const saved = await googleRequest('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
          method: 'POST',
          body: JSON.stringify(googleTaskBody(state, task)),
        });
        task.googleTaskId = saved.id;
        task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
        task.lastGoogleTaskSnapshot = googleTaskLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
        uploaded += 1;
      } else {
        const remoteSnapshot = googleTaskRemoteSnapshot(remote);
        const remoteChangedHint = remoteUpdatedAt > Number(task.googleRemoteUpdatedAt || 0);
        let decision;

        if (resolutionFresh && resolution.choice === 'local') {
          decision = { action: 'local', merged: localSnapshot, conflictFields: [] };
        } else if (resolutionFresh && resolution.choice === 'remote') {
          decision = { action: 'remote', merged: remoteSnapshot, conflictFields: [] };
        } else {
          decision = reconcileGoogleTaskNative({
            base: baseSnapshot,
            local: localSnapshot,
            remote: remoteSnapshot,
            localChangedHint: localWasChanged,
            remoteChangedHint,
          });
        }

        if (decision.action === 'conflict') {
          task.googleConflict = {
            source: 'tasks',
            type: decision.type,
            detectedAt: syncTime,
            remoteUpdatedAt,
            local: localSnapshot,
            remote: remoteSnapshot,
            conflictFields: decision.conflictFields,
          };
          delete task.googleResolution;
          conflicts += 1;
          retainedTasks.push(task);
          continue;
        }

        const nativeChangedByRemote = !googleTaskSnapshotEqual(localSnapshot, decision.merged);
        if (nativeChangedByRemote) applyGoogleTaskNative(task, decision.merged);

        // Google Task title/due/status are shared. Luma-only metadata stays
        // local when this device has pending work; otherwise valid metadata
        // from another Luma sync may be accepted.
        if (remoteDetails && !localWasChanged) {
          applyGoogleTaskMetadata(task, remoteDetails);
          ensureProject(state, remoteDetails);
        }

        if (nativeChangedByRemote) downloaded += 1;
        if (nativeChangedByRemote && !localWasChanged) task.updatedAt = remoteUpdatedAt;

        const shouldPush = decision.action === 'local'
          || decision.action === 'merge'
          || localWasChanged
          || needsMetadataUpgrade;

        if (shouldPush) {
          const saved = await googleRequest(`https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(remote.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(googleTaskBody(state, task, remote.notes || '')),
          });
          task.googleRemoteUpdatedAt = Date.parse(saved.updated || new Date().toISOString());
          uploaded += 1;
        } else {
          task.googleRemoteUpdatedAt = remoteUpdatedAt;
        }

        task.googleTaskId = remote.id;
        task.lastGoogleTaskSnapshot = googleTaskLocalSnapshot(task);
        delete task.googleConflict;
        delete task.googleResolution;
      }
    }
    task.lastGoogleSyncAt = syncTime;
    retainedTasks.push(task);
    } catch (error) {
      task.googleSyncError = String(error.message || error || 'Google 单条同步失败');
      failed += 1;
      failureMessages.push((task.title || task.id || '事项') + '：' + task.googleSyncError);
      if (!retainedTasks.includes(task)) retainedTasks.push(task);
    }
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
    if (isLumaEvent) task.lastGoogleCalendarSnapshot = googleCalendarLocalSnapshot(task);
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
    applyGoogleTaskNative(task, googleTaskRemoteSnapshot(remoteTask));
    applyGoogleTaskMetadata(task, details);
    task.lastGoogleTaskSnapshot = googleTaskLocalSnapshot(task);
    retainedTasks.push(task);
    state.tasks.push(task);
    downloaded += 1;
  }

  state.tasks = retainedTasks;
  let projectsUploaded = 0;
  if (googleTasksAvailable) {
    try {
      projectsUploaded = await uploadProjectMetadata(state, remoteProjectMetadata);
    } catch (error) {
      failed += 1;
      failureMessages.push('Google 分类同步：' + String(error.message || error));
    }
  }
  return {
    state,
    summary: {
      uploaded,
      downloaded,
      deleted,
      conflicts,
      failed,
      remoteDeleted: remoteDeletedCount,
      externalCalendarDownloaded,
      projectsUploaded,
      projectsDownloaded: remoteProjectMetadata.downloaded,
      calendarReadFailed: (calendarRead.failures || []).length,
      tasksReadFailed: googleTasksAvailable ? 0 : 1,
      duplicatesRemoved,
      duplicatesDeferred,
      failures: failureMessages.slice(0, 20),
    },
  };
}

async function deleteGoogleTask(task) {
  if (!loadGoogleToken() || !task) return false;
  if (task.googleCalendarExternal || task.syncTarget === 'external-calendar') return false;
  if (task.googleCalendarEventId) await deleteGoogleCalendarEvent(task.googleCalendarId || 'primary', task.googleCalendarEventId);
  if (task.googleTaskId) await deleteGoogleTasksItem(task.googleTaskId);
  return true;
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    const prefsFile = path.join(app.getPath('userData'), 'local-preferences.json');
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch {}
    const patch = {};
    if (!prefs.closeAction && (saved.closeAction === 'edge' || saved.closeAction === 'hide')) patch.closeAction = saved.closeAction;
    if (!Number.isFinite(prefs.edgeTabY) && Number.isFinite(saved.edgeTabY)) patch.edgeTabY = saved.edgeTabY;
    if (!prefs.edgeTabSide && (saved.edgeTabSide === 'left' || saved.edgeTabSide === 'right')) patch.edgeTabSide = saved.edgeTabSide;
    if (Object.keys(patch).length) localData.configure(patch);
    return saved;
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
  const backupDir = path.join(localData.root(), 'backups');
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
      sandbox: true,
    },
  });

  // The renderer is a local application surface. It must not create arbitrary
  // child windows or replace itself with remote/local content.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl || url === currentUrl) return;
    event.preventDefault();
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', async () => {
    if (process.env.LUMA_SCREENSHOT_DIR) mainWindow.showInactive();
    else await revealMainWindow();
    if (process.env.LUMA_SCREENSHOT_DIR) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!app.isPackaged && process.env.LUMA_SYNC_PROTOCOL_SMOKE === '1') {
        if (!DEMO_MODE) {
          console.error('[Luma Todo] Sync protocol smoke requires demo mode');
          app.isQuitting = true;
          app.exit(1);
          return;
        }
        try {
          const runSyncProtocolSmokeTests = require(path.join(__dirname, 'qa', 'sync-protocol-smoke.cjs'));
          const tested = await runSyncProtocolSmokeTests({
            taskToIcloudIcs,
            parseIcloudEvent,
            calendarBody,
            applyCalendarEvent,
            deleteIcloudEvent,
          });
          console.log('[Luma Todo] Sync protocol smoke: ' + tested.join(', '));
        } catch (error) {
          console.error('[Luma Todo] Sync protocol smoke failed: ' + (error?.stack || error?.message || error));
          app.isQuitting = true;
          app.exit(1);
          return;
        }
      }
      if (!app.isPackaged && process.env.LUMA_BEHAVIOR_SMOKE === '1') {
        if (!DEMO_MODE) {
          console.error('[Luma Todo] Behavior smoke requires demo mode');
          app.isQuitting = true;
          app.exit(1);
          return;
        }
        try {
          const smokeScript = fs.readFileSync(path.join(__dirname, 'qa', 'renderer-behavior-smoke.js'), 'utf8');
          const smokeResult = await mainWindow.webContents.executeJavaScript(smokeScript);
          if (!smokeResult?.ok) throw new Error('Behavior smoke returned no success result');
          console.log('[Luma Todo] Behavior smoke: ' + smokeResult.tested.join(', '));
        } catch (error) {
          console.error('[Luma Todo] Behavior smoke failed: ' + (error?.stack || error?.message || error));
          app.isQuitting = true;
          app.exit(1);
          return;
        }
      }
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
      closeToPreference();
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
    if (mainWindow.isVisible() && mainWindow.isFocused()) closeToPreference();
    else revealMainWindow();
  });
}

function getAutoUpdater() {
  if (autoUpdaterRef) return autoUpdaterRef;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (error) => console.warn(`[Luma Todo] Update check failed: ${error.message}`));
  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateInfo = info;
    promptUpdateInstall(info);
  });
  autoUpdaterRef = autoUpdater;
  return autoUpdater;
}

function promptUpdateInstall(info) {
  if (!mainWindow || mainWindow.isDestroyed() || installPromptOpen) return;
  installPromptOpen = true;
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
    installPromptOpen = false;
    if (response !== 0) return;
    app.isQuitting = true;
    getAutoUpdater().quitAndInstall(false, true);
  });
}

function appVersionStatus() {
  return {
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    downloaded: downloadedUpdateInfo?.version || '',
  };
}

async function checkForAppUpdates({ fromUser = false } = {}) {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) {
    return {
      status: 'dev',
      currentVersion,
      message: `当前 ${currentVersion}（开发模式，安装包才会检查更新）`,
    };
  }
  if (downloadedUpdateInfo) {
    if (fromUser) promptUpdateInstall(downloadedUpdateInfo);
    return {
      status: 'ready',
      currentVersion,
      version: downloadedUpdateInfo.version,
      message: `新版本 ${downloadedUpdateInfo.version} 已下载，可立即安装`,
    };
  }
  if (!updateCheckInFlight) {
    updateCheckInFlight = getAutoUpdater().checkForUpdates().finally(() => {
      updateCheckInFlight = null;
    });
  }
  try {
    const result = await updateCheckInFlight;
    const info = result?.updateInfo;
    const available = Boolean(result?.isUpdateAvailable) || Boolean(info?.version && info.version !== currentVersion);
    if (!available) {
      return { status: 'current', currentVersion, message: `已是最新版本 ${currentVersion}` };
    }
    if (downloadedUpdateInfo) {
      if (fromUser) promptUpdateInstall(downloadedUpdateInfo);
      return {
        status: 'ready',
        currentVersion,
        version: downloadedUpdateInfo.version,
        message: `新版本 ${downloadedUpdateInfo.version} 已下载，可立即安装`,
      };
    }
    return {
      status: 'downloading',
      currentVersion,
      version: info.version,
      message: `发现 ${info.version}，正在下载…`,
    };
  } catch (error) {
    const detail = error?.message || String(error);
    return {
      status: 'error',
      currentVersion,
      message: fromUser ? `检查失败：${detail}` : detail,
    };
  }
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  getAutoUpdater();
  const check = () => checkForAppUpdates({ fromUser: false }).catch((error) => {
    console.warn(`[Luma Todo] Update check failed: ${error.message}`);
  });
  setTimeout(check, 5000);
  updateCheckTimer = setInterval(check, 6 * 60 * 60 * 1000);
}

function isTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!event || event.sender !== mainWindow.webContents) return false;

  const frameUrl = String(event.senderFrame?.url || '');
  const pageUrl = String(mainWindow.webContents.getURL() || '');
  return Boolean(frameUrl && pageUrl && frameUrl === pageUrl && frameUrl.startsWith('file:'));
}

function trustedHandle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event)) throw new Error('Blocked untrusted IPC sender');
    return handler(event, ...args);
  });
}

function trustedOn(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    if (channel === 'edge:restore' || channel === 'edge:move') {
      if (!isTrustedEdgeSender(event)) return;
      return handler(event, ...args);
    }
    if (!isTrustedIpcSender(event)) return;
    return handler(event, ...args);
  });
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  revealMainWindow();
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  try {
    localData.root();
  } catch {
    dialog.showErrorBox('Luma 数据位置不可用', '请重新连接数据所在磁盘或恢复文件夹后，再启动 Luma。未切换到空数据库。');
    app.isQuitting = true;
    app.quit();
    return;
  }
  ensureDemoData();
  try { ensureDemoLifelog(); } catch (err) { console.warn("demo lifelog seed skipped:", err && err.message); }
  ensureDailyBackup();
  localData.scan();
  createWindow();
  createTray();
  setupAutoUpdates();
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  cancelDesktopAttach();
  hideEdgeWindow();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

trustedHandle('private-extensions:status', () => privateExtensions.status());

trustedHandle('private-extensions:activate', (_event, code) => privateExtensions.activate(code));

trustedHandle('private-extensions:install', async () => {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: '安装私人扩展',
    properties: ['openFile'],
    filters: [{ name: 'Luma 私人扩展', extensions: ['luma-plugin'] }],
  });
  if (choice.canceled || !choice.filePaths?.[0]) return { canceled: true, ...privateExtensions.status() };
  const target = choice.filePaths[0];
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('私人扩展包过大或不可用');
  return { canceled: false, ...privateExtensions.installPackage(fs.readFileSync(target, 'utf8')) };
});

trustedHandle('private-extensions:luckyday-summary', (_event, payload) => {
  const dateKey = String(payload?.dateKey || '');
  const hourBranch = Number(payload?.hourBranch);
  if (!isIsoDateKey(dateKey)) throw new Error('LuckyDay 日期格式不正确');
  return privateExtensions.call('luckyday', 'getSummary', { dateKey, hourBranch });
});

trustedHandle('private-extensions:luckyday-day-marks', (_event, payload) => {
  const startDate = String(payload?.startDate || '');
  const endDate = String(payload?.endDate || '');
  if (!isIsoDateKey(startDate) || !isIsoDateKey(endDate) || endDate < startDate) throw new Error('LuckyDay 日期范围不正确');
  return privateExtensions.call('luckyday', 'getDayMarks', { startDate, endDate });
});

trustedHandle('private-extensions:luckyday-icloud-status', () => luckyDayIcloudStatus());

let luckyDayIcloudSyncInFlight = false;
trustedHandle('private-extensions:luckyday-sync-icloud', async (_event, payload) => {
  if (luckyDayIcloudSyncInFlight) throw new Error('LuckyDay iCloud 同步正在进行');
  if (DEMO_MODE) throw new Error('演示模式不会写入真实 iCloud');
  luckyDayIcloudSyncInFlight = true;
  try {
    return await syncLuckyDayIcloudMarkers(
      String(payload?.calendarUrl || ''),
      { startDate: String(payload?.startDate || ''), endDate: String(payload?.endDate || '') }
    );
  } finally {
    luckyDayIcloudSyncInFlight = false;
  }
});

trustedHandle('private-extensions:open-luckyday', async () => {
  const manifest = privateExtensions.manifest('luckyday');
  if (!manifest?.fullUrl) throw new Error('LuckyDay 完整页面地址不可用');
  await shell.openExternal(manifest.fullUrl);
  return true;
});

trustedHandle('window:set-expanded', (_event, expanded) => {
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

trustedHandle('window:set-always-on-top', async (_event, enabled) => {
  return setPinnedState(enabled);
});

trustedOn('window:activate', () => {
  cancelDesktopAttach();
  if (!isPinnedAlwaysOnTop && (!mainWindow?.isFocused() || isDesktopHosted)) {
    activateMainWindow();
  }
});

trustedOn('window:resize-start', (_event, payload) => {
  if (!payload?.edge) return;
  resizeSession = {
    edge: payload.edge,
    startX: Number(payload.x),
    startY: Number(payload.y),
    bounds: mainWindow.getBounds(),
  };
});

trustedOn('window:resize-move', (_event, payload) => {
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

trustedOn('window:resize-end', () => {
  if (!resizeSession) return;
  resizeSession = null;
  saveWindowState();
});

trustedOn('window:hide', () => {
  closeToPreference();
});

trustedHandle('local:status', () => localData.status());

trustedHandle('local:configure', (_event, values) => {
  if (!values || typeof values !== 'object' || Object.keys(values).some(key => !['closeAction', 'inboxEnabled'].includes(key))) throw new Error('无效设置');
  if ('closeAction' in values && !['hide', 'edge'].includes(values.closeAction)) throw new Error('无效关闭行为');
  if ('inboxEnabled' in values && typeof values.inboxEnabled !== 'boolean') throw new Error('无效收件箱设置');
  if (values.inboxEnabled && !localData.status().inboxPath) throw new Error('请先选择收件箱文件夹');
  const result = localData.configure(values);
  if (result.closeAction !== 'edge') hideEdgeWindow();
  return result;
});

trustedHandle('local:scan', () => localData.scan());

trustedHandle('local:choose', async (_event, kind) => {
  if (!['storage', 'inbox'].includes(kind)) throw new Error('无效文件夹类型');
  nativeModalDepth += 1;
  cancelDesktopAttach();
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'storage' ? '选择空文件夹存放 Luma 数据（原数据保留）' : '选择手机日记收件箱',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return localData.status();
    const selected = fs.realpathSync(result.filePaths[0]);
    if (kind === 'storage') return localData.migrate(selected);
    return localData.configure({ inboxPath: selected });
  } finally {
    nativeModalDepth = Math.max(0, nativeModalDepth - 1);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) scheduleDesktopAttach();
  }
});

trustedOn('edge:restore', () => {
  revealMainWindow();
});

trustedOn('edge:move', (_event, payload) => {
  if (!edgeWindow || edgeWindow.isDestroyed()) return;
  const bounds = edgeWindow.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const right = bounds.x + bounds.width / 2 >= area.x + area.width / 2;
  const dy = Number(payload?.dy) || 0;
  const nextY = Math.max(area.y, Math.min(area.y + area.height - EDGE_TAB_H, bounds.y + dy));
  placeEdgeWindow(area, right, nextY);
  if (payload?.persist) localData.configure({ edgeTabY: nextY, edgeTabSide: right ? 'right' : 'left' });
});

trustedHandle('data:load', () => {
  try {
    return JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
  } catch {
    return null;
  }
});

trustedHandle('data:save', (_event, payload) => {
  const target = dataPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return true;
});

trustedHandle('data:export', async (_event, payload) => {
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

trustedHandle('lifelog:load', () => {
  ensureDemoLifelog();
  return readLifelogStore();
});

trustedHandle('lifelog:save', (_event, payload) => writeLifelogStore(payload || {}));

trustedHandle('lifelog:save-media', (_event, payload) => {
  const mediaDir = lifelogMediaDir();
  fs.mkdirSync(mediaDir, { recursive: true });
  const mime = String(payload && payload.mime || 'image/jpeg');
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : mime === 'image/svg+xml' ? '.svg' : '.jpg';
  const safeName = String(payload && payload.relativePath || (Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext))
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop();
  if (!safeName || safeName.includes('..')) throw new Error('invalid media path');
  const abs = path.join(mediaDir, safeName);
  const raw = String(payload && payload.dataBase64 || '');
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  fs.writeFileSync(abs, Buffer.from(b64, 'base64'));
  return safeName;
});

trustedHandle('lifelog:delete-media', (_event, relativePath) => {
  const safeName = String(relativePath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .pop();
  if (!safeName || safeName.includes('..')) throw new Error('invalid media path');
  const abs = path.join(lifelogMediaDir(), safeName);
  if (fs.existsSync(abs)) fs.unlinkSync(abs);
  return true;
});

trustedHandle('lifelog:media-data-url', (_event, relativePath) => {
  const abs = lifelogMediaAbsolute(relativePath);
  if (!abs || !fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
});

trustedHandle('google:status', () => {
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

trustedHandle('google:connect', async () => {
  if (DEMO_MODE) throw new Error('演示模式不会连接真实 Google 账户');
  if (!fs.existsSync(googleCredentialsPath())) throw new Error('项目目录中没有找到 credentials.json');
  return connectGoogle();
});

trustedHandle('google:disconnect', async () => {
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

let googleSyncInFlight = false;
trustedHandle('google:sync', async (_event, payload) => {
  if (googleSyncInFlight) throw new Error('Google 同步正在进行，请等待完成');
  if (DEMO_MODE) return { state: payload, summary: { uploaded: 0, downloaded: 0, deleted: 0, remoteDeleted: 0, externalCalendarDownloaded: 0, projectsUploaded: 0, projectsDownloaded: 0 } };
  googleSyncInFlight = true;
  try {
    return await syncGoogleState(payload);
  } finally {
    googleSyncInFlight = false;
  }
});
trustedHandle('google:delete-task', (_event, task) => DEMO_MODE ? false : deleteGoogleTask(task));


trustedHandle('icloud:status', () => {
  if (DEMO_MODE) return { connected: false, email: '', calendars: [], demo: true };
  return publicIcloudStatus(loadIcloudCredentials());
});

trustedHandle('icloud:connect', async (_event, payload) => {
  if (DEMO_MODE) throw new Error('演示模式不会连接真实 iCloud 账户');
  const email = String((payload && payload.email) || '').trim();
  const password = String((payload && payload.password) || '').trim();
  if (!email || !password) throw new Error('请输入 Apple 账户邮箱和 App 专用密码');

  const discovery = await discoverIcloudCalendars({ email, password });
  const previous = loadIcloudCredentials();
  const stored = {
    email,
    password,
    principalUrl: discovery.principalUrl,
    calendarHomeUrl: discovery.calendarHomeUrl,
    calendars: discovery.calendars,
    selectedCalendarUrl: previous?.selectedCalendarUrl || '',
    luckyDayCalendarUrl: previous?.luckyDayCalendarUrl || '',
    verifiedAt: Date.now()
  };
  saveIcloudCredentials(stored);
  return publicIcloudStatus(stored);
});

trustedHandle('icloud:disconnect', () => {
  clearIcloudCredentials();
  return { connected: false, email: '', calendars: [], selectedCalendarUrl: '' };
});

let icloudSyncInFlight = false;
trustedHandle('icloud:sync', async (_event, payload) => {
  if (icloudSyncInFlight) throw new Error('Apple 同步正在进行，请等待完成');
  if (DEMO_MODE) return { state: payload?.state, summary: { created: 0, updated: 0, unchanged: 0, calendarName: '' } };
  icloudSyncInFlight = true;
  try {
    const result = await syncIcloudEvents(payload?.state || {}, String(payload?.calendarUrl || ''));
    const credentials = loadIcloudCredentials();
    if (credentials?.luckyDayCalendarUrl && privateExtensions.manifest('luckyday')) {
      try {
        result.luckyDay = await syncLuckyDayIcloudMarkers(credentials.luckyDayCalendarUrl, luckyDayDefaultSyncRange());
      } catch (error) {
        result.luckyDay = { error: String(error?.message || error || 'LuckyDay iCloud 同步失败') };
      }
    }
    return result;
  } finally {
    icloudSyncInFlight = false;
  }
});

trustedHandle('settings:auto-start', (_event, enabled) => {
  if (DEMO_MODE) return false;
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
  return app.getLoginItemSettings().openAtLogin;
});

trustedHandle('settings:get-auto-start', () => DEMO_MODE ? false : app.getLoginItemSettings().openAtLogin);
trustedHandle('app:version', () => appVersionStatus());
trustedHandle('app:check-updates', () => checkForAppUpdates({ fromUser: true }));

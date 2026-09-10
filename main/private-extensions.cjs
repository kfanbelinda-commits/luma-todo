"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 24;
const METHODS = new Set(['getPanel','getSettings','getDayMarks','getCalendarEvents','identifyCalendarEvent','getCalendarRange']);
const validId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);
const validFullUrl = value => /^https:\/\/\S+$/i.test(String(value || ''));
function contributions(manifest) {
  if (manifest.apiVersion !== 2) return {};
  const c = manifest.contributions || {};
  return {
    panel:c.panel && {
      label:String(c.panel.label || manifest.name || manifest.id).slice(0,30),
      title:String(c.panel.title || manifest.name || manifest.id).slice(0,120),
      web:Boolean(validFullUrl(manifest.fullUrl)),
      webLabel:String(c.panel.webLabel || '网页详情').slice(0,30),
    },
    settings:Boolean(c.settings),
    dayMarks:Boolean(c.dayMarks),
    calendar:c.calendar ? {
      legacySetting:/^[a-zA-Z][a-zA-Z0-9]{0,48}CalendarUrl$/.test(c.calendar.legacySetting || '') ? c.calendar.legacySetting : '',
    } : null,
  };
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function codeHash(value) {
  return crypto.createHash("sha256").update(normalizeCode(value)).digest("hex");
}

function decodeB64(value, label) {
  try {
    const buffer = Buffer.from(String(value || ""), "base64");
    if (!buffer.length) throw new Error();
    return buffer;
  } catch {
    throw new Error(label + " 格式不正确");
  }
}

function decryptAesGcm(key, encrypted, label) {
  try {
    const iv = decodeB64(encrypted?.iv, label + " iv");
    const tag = decodeB64(encrypted?.tag, label + " tag");
    const ciphertext = decodeB64(encrypted?.ciphertext, label + " ciphertext");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (/格式不正确/.test(String(error?.message || ""))) throw error;
    throw new Error(label + " 无法解密");
  }
}

function safeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:/i.test(raw)) return null;
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

function createPrivateExtensionManager({
  rootPath,
  protectSecret,
  unprotectSecret,
} = {}) {
  if (typeof rootPath !== "function") throw new Error("Private extension rootPath is required");

  const extensionRoot = () => path.join(rootPath(), "private-extensions");
  const accessPath = () => path.join(extensionRoot(), "access.json");
  const installedRoot = () => path.join(extensionRoot(), "installed");

  function readAccess() {
    try {
      const parsed = JSON.parse(fs.readFileSync(accessPath(), "utf8"));
      if (parsed?.format !== 1 || typeof parsed.secret !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function readCode() {
    const access = readAccess();
    if (!access) return "";
    if (typeof unprotectSecret !== "function") throw new Error("当前系统无法读取私人扩展授权");
    try {
      return normalizeCode(unprotectSecret(Buffer.from(access.secret, "base64")));
    } catch {
      throw new Error("私人扩展授权无法解密，请重新激活");
    }
  }

  function activate(rawCode) {
    const code = normalizeCode(rawCode);
    if (!/^LD-[A-Z0-9-]{12,}$/.test(code)) throw new Error("授权码格式不正确");
    if (typeof protectSecret !== "function") throw new Error("当前系统无法安全保存私人扩展授权");
    const encrypted = protectSecret(code);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error("授权码保存失败");
    fs.mkdirSync(extensionRoot(), { recursive: true });
    fs.writeFileSync(accessPath(), JSON.stringify({
      format: 1,
      codeHash: codeHash(code),
      secret: encrypted.toString("base64"),
    }, null, 2), "utf8");
    return status();
  }

  function pluginDirectory(id) {
    if (!validId(id)) throw new Error("扩展标识无效");
    return path.join(installedRoot(), id);
  }

  function readManifest(id) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDirectory(id), "manifest.json"), "utf8"));
      if (manifest?.id !== id || typeof manifest.version !== "string" || typeof manifest.entry !== "string") return null;
      const entry = safeRelativePath(manifest.entry);
      if (!entry) return null;
      return { ...manifest, entry };
    } catch {
      return null;
    }
  }

  function installedPlugins() {
    let names = [];
    try { names = fs.readdirSync(installedRoot()); } catch {}
    return names
      .map((id) => readManifest(id))
      .filter(Boolean)
      .map((manifest) => ({
        id: manifest.id,
        name: String(manifest.name || manifest.id),
        version: manifest.version,
        apiVersion: manifest.apiVersion || 1,
        contributions: contributions(manifest),
      }));
  }

  function status() {
    const access = readAccess();
    const plugins = installedPlugins();
    return {
      activated: Boolean(access),
      codeHash: access?.codeHash || "",
      plugins,
    };
  }

  function parseAndDecryptPackage(text) {
    if (Buffer.byteLength(String(text || ""), "utf8") > MAX_PACKAGE_BYTES) throw new Error("私人扩展包过大");
    let pack;
    try { pack = JSON.parse(text); } catch { throw new Error("私人扩展包格式不正确"); }
    if (pack?.format !== 1 || !validId(pack?.id) || !Array.isArray(pack.recipients) || !pack.payload) {
      throw new Error("不支持的私人扩展包");
    }

    const code = readCode();
    if (!code) throw new Error("请先输入私人扩展授权码");
    const hash = codeHash(code);
    const recipient = pack.recipients.find((item) => item?.codeHash === hash);
    if (!recipient) throw new Error("当前授权码没有此扩展版本的权限");

    const salt = decodeB64(recipient.salt, "授权 salt");
    const wrapKey = crypto.scryptSync(code, salt, 32);
    const contentKey = decryptAesGcm(wrapKey, recipient, "扩展密钥");
    if (contentKey.length !== 32) throw new Error("扩展密钥长度不正确");
    const payloadBuffer = decryptAesGcm(contentKey, pack.payload, "扩展内容");

    let payload;
    try { payload = JSON.parse(payloadBuffer.toString("utf8")); } catch { throw new Error("扩展内容格式不正确"); }
    const manifest = payload?.manifest;
    const files = payload?.files;
    if (
      manifest?.id !== pack.id
      || String(manifest.version || "") !== String(pack.version || "")
      || typeof manifest.entry !== "string"
      || !files
      || typeof files !== "object"
      || Array.isArray(files)
    ) throw new Error("扩展清单不完整");

    const entries = Object.entries(files);
    if (!entries.length || entries.length > MAX_FILES) throw new Error("扩展文件数量不正确");
    const safeFiles = {};
    let total = 0;
    for (const [fileName, content] of entries) {
      const safe = safeRelativePath(fileName);
      if (!safe || typeof content !== "string") throw new Error("扩展包含不安全文件");
      total += Buffer.byteLength(content, "utf8");
      if (total > MAX_PACKAGE_BYTES) throw new Error("扩展内容过大");
      safeFiles[safe] = content;
    }
    const safeEntry = safeRelativePath(manifest.entry);
    if (!safeEntry || !Object.hasOwn(safeFiles, safeEntry)) throw new Error("扩展入口不存在");
    return {
      manifest: {
        id: manifest.id,
        name: String(manifest.name || manifest.id),
        version: String(manifest.version),
        entry: safeEntry,
        apiVersion: manifest.apiVersion || 1,
        contributions: contributions(manifest),
        fullUrl: validFullUrl(manifest.fullUrl) ? String(manifest.fullUrl) : "",
      },
      files: safeFiles,
    };
  }

  function installPackage(text) {
    const payload = parseAndDecryptPackage(text);
    const target = pluginDirectory(payload.manifest.id);
    const temp = target + ".installing-" + process.pid + "-" + Date.now();
    const backup = target + ".previous";

    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });
    try {
      for (const [relative, content] of Object.entries(payload.files)) {
        const output = path.join(temp, ...relative.split("/"));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, content, "utf8");
      }
      fs.writeFileSync(path.join(temp, "manifest.json"), JSON.stringify(payload.manifest, null, 2), "utf8");

      fs.mkdirSync(installedRoot(), { recursive: true });
      fs.rmSync(backup, { recursive: true, force: true });
      if (fs.existsSync(target)) fs.renameSync(target, backup);
      fs.renameSync(temp, target);
      clearCache(target);
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(temp, { recursive: true, force: true });
      if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    return status();
  }

  function clearCache(target) {
    for (const file of Object.keys(require.cache)) if (file.startsWith(target + path.sep)) delete require.cache[file];
  }
  function uninstall(id) {
    const target = pluginDirectory(id);
    if (fs.existsSync(target)) {
      const archive = path.join(extensionRoot(), 'removed');
      fs.mkdirSync(archive,{recursive:true});
      fs.renameSync(target,path.join(archive,id+'-'+Date.now()));
      clearCache(target);
    }
    return status();
  }
  function call(id, method, args) {
    const manifest = readManifest(id);
    if (!manifest) throw new Error("私人扩展尚未安装");
    const allowed = manifest.apiVersion === 2 && METHODS.has(method);
    if (!allowed) throw new Error("私人扩展方法不受支持");
    const entryPath = path.join(pluginDirectory(id), ...manifest.entry.split("/"));

    const plugin = require(entryPath);
    if (typeof plugin?.[method] !== "function") throw new Error("私人扩展入口无效");
    return plugin[method](args || {});
  }

  function manifest(id) {
    return readManifest(id);
  }

  return {
    activate,
    status,
    installPackage,
    uninstall,
    call,
    manifest,
    _test: { codeHash, parseAndDecryptPackage, safeRelativePath },
  };
}

function isIsoDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

module.exports = { createPrivateExtensionManager, normalizeCode, codeHash, isIsoDateKey };
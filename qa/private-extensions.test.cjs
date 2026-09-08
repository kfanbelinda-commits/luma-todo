"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPrivateExtensionManager, isIsoDateKey } = require("../main/private-extensions.cjs");

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function packFor(code, entrySource = "module.exports={getSummary:()=>({ok:true})};") {
  const contentKey = crypto.randomBytes(32);
  const salt = crypto.randomBytes(16);
  const wrapKey = crypto.scryptSync(code.toUpperCase(), salt, 32);
  return JSON.stringify({
    format: 1,
    id: "luckyday",
    version: "0.1.0",
    payload: encrypt(contentKey, JSON.stringify({
      manifest: {
        id: "luckyday",
        name: "LuckyDay 吉课",
        version: "0.1.0",
        entry: "plugin-entry.cjs",
        fullUrl: "https://example.com/luckyday",
      },
      files: { "plugin-entry.cjs": entrySource },
    })),
    recipients: [{
      codeHash: crypto.createHash("sha256").update(code.toUpperCase()).digest("hex"),
      salt: salt.toString("base64"),
      ...encrypt(wrapKey, contentKey),
    }],
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "luma-private-ext-"));
  const manager = createPrivateExtensionManager({
    rootPath: () => root,
    protectSecret: (value) => Buffer.from("protected:" + value),
    unprotectSecret: (buffer) => buffer.toString("utf8").replace(/^protected:/, ""),
  });
  return { root, manager };
}

test("private extension stays absent before provisioning", () => {
  const { root, manager } = fixture();
  try {
    assert.deepEqual(manager.status().plugins, []);
    assert.equal(manager.status().activated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("activation secret is stored protected rather than plaintext", () => {
  const { root, manager } = fixture();
  try {
    const code = "LD-ABCDEF-123456-789ABC-DEF012";
    manager.activate(code);
    const raw = fs.readFileSync(path.join(root, "private-extensions", "access.json"), "utf8");
    assert.equal(raw.includes(code), false);
    assert.equal(manager.status().activated, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("only a recipient code can decrypt and install the plugin package", () => {
  const { root, manager } = fixture();
  try {
    const right = "LD-ABCDEF-123456-789ABC-DEF012";
    manager.activate("LD-WRONG1-WRONG2-WRONG3-WRONG4");
    assert.throws(() => manager.installPackage(packFor(right)), /没有此扩展版本/);

    manager.activate(right);
    const status = manager.installPackage(packFor(right));
    assert.equal(status.luckyDay.version, "0.1.0");
    assert.deepEqual(manager.call("luckyday", "getSummary", {}), { ok: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unsafe plugin paths are rejected after decryption", () => {
  const { root, manager } = fixture();
  try {
    const code = "LD-ABCDEF-123456-789ABC-DEF012";
    manager.activate(code);
    const contentKey = crypto.randomBytes(32);
    const salt = crypto.randomBytes(16);
    const wrapKey = crypto.scryptSync(code, salt, 32);
    const pack = JSON.stringify({
      format: 1,
      id: "luckyday",
      version: "0.1.0",
      payload: encrypt(contentKey, JSON.stringify({
        manifest: { id: "luckyday", version: "0.1.0", entry: "../evil.cjs" },
        files: { "../evil.cjs": "module.exports={}" },
      })),
      recipients: [{
        codeHash: crypto.createHash("sha256").update(code).digest("hex"),
        salt: salt.toString("base64"),
        ...encrypt(wrapKey, contentKey),
      }],
    });
    assert.throws(() => manager.installPackage(pack), /不安全|入口/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("LuckyDay IPC date validator accepts ISO date keys", () => {
  assert.equal(isIsoDateKey("2026-09-08"), true);
  assert.equal(isIsoDateKey("2026-9-8"), false);
  assert.equal(isIsoDateKey("\\d{4}-09-08"), false);
});

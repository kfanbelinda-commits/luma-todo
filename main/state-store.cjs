'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const META_KEY = '_lumaStore';
const META_SCHEMA = 1;

function stateError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function validateBusinessState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw stateError('STATE_INVALID', 'Luma 数据不是有效对象');
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.projects)) {
    throw stateError('STATE_INVALID', 'Luma 数据缺少 tasks 或 projects');
  }
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sanitizeOperation(input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw stateError('OPERATION_INVALID', '同步操作记录无效');
  const id = String(input.id || '').trim();
  const provider = String(input.provider || '').trim();
  const kind = String(input.kind || '').trim();
  const localItemId = String(input.localItemId || '').trim();
  if (!id || !provider || !kind || !localItemId) {
    throw stateError('OPERATION_INVALID', '同步操作缺少稳定身份');
  }
  return {
    id,
    provider,
    kind,
    localItemId,
    phase: String(input.phase || 'prepared'),
    source: clone(input.source || null),
    destination: clone(input.destination || null),
    sourceVersion: clone(input.sourceVersion || null),
    destinationIdentity: clone(input.destinationIdentity || null),
    recovery: clone(input.recovery || null),
    createdAt: Number(input.createdAt || now),
    updatedAt: Number(input.updatedAt || now),
    error: String(input.error || ''),
  };
}

function publicState(stored) {
  if (!stored) return null;
  const result = clone(stored);
  delete result[META_KEY];
  return result;
}

function createStateStore(options) {
  const fsImpl = options?.fs || fs;
  const home = path.resolve(String(options?.home || ''));
  const idFactory = options?.idFactory || (() => crypto.randomUUID());
  const now = options?.now || (() => Date.now());
  if (!home) throw new Error('state store home is required');

  let contextPath = '';
  let contextSessionId = '';
  let legacyStorageId = '';
  let recovery = null;

  function preferencesPath() {
    return path.join(home, 'local-preferences.json');
  }

  function resolveRoot() {
    const prefsFile = preferencesPath();
    let prefs = {};
    if (fsImpl.existsSync(prefsFile)) {
      try {
        prefs = JSON.parse(fsImpl.readFileSync(prefsFile, 'utf8')) || {};
      } catch (error) {
        throw stateError('STORAGE_CONFIG_INVALID', 'Luma 数据位置配置无法读取', error);
      }
    }
    return path.resolve(prefs.storagePath ? String(prefs.storagePath) : home);
  }

  function filePath() {
    return path.join(resolveRoot(), 'luma-data.json');
  }

  function context() {
    const currentPath = filePath();
    if (currentPath !== contextPath) {
      contextPath = currentPath;
      contextSessionId = idFactory();
      legacyStorageId = '';
    }
    return { filePath: currentPath, sessionId: contextSessionId };
  }

  function parseStored(raw, filename) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw stateError('STATE_PARSE_FAILED', `Luma 数据文件损坏：${filename}`, error);
    }
    validateBusinessState(parsed);
    const meta = parsed[META_KEY];
    if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) {
      throw stateError('STATE_META_INVALID', 'Luma 数据修订信息损坏');
    }
    const revision = Number(meta?.revision || 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw stateError('STATE_META_INVALID', 'Luma 数据修订号无效');
    }
    const businessRevision = Number(meta?.businessRevision ?? revision);
    if (!Number.isSafeInteger(businessRevision) || businessRevision < 0 || businessRevision > revision) {
      throw stateError('STATE_META_INVALID', 'Luma 业务数据修订号无效');
    }
    let storageId = String(meta?.storageId || '');
    if (!storageId) {
      legacyStorageId ||= idFactory();
      storageId = legacyStorageId;
    }
    const operations = Array.isArray(meta?.pendingOperations)
      ? meta.pendingOperations.map((item) => sanitizeOperation(item, now()))
      : [];
    return {
      stored: parsed,
      meta: { schema: META_SCHEMA, revision, businessRevision, storageId, pendingOperations: operations },
    };
  }

  function readCurrent({ allowMissing = true } = {}) {
    const ctx = context();
    if (!fsImpl.existsSync(ctx.filePath)) {
      if (!allowMissing) throw stateError('STATE_MISSING', 'Luma 数据文件不存在');
      return {
        state: null,
        meta: { schema: META_SCHEMA, revision: 0, businessRevision: 0, storageId: idFactory(), pendingOperations: [] },
        sessionId: ctx.sessionId,
        filePath: ctx.filePath,
      };
    }
    let raw;
    try {
      raw = fsImpl.readFileSync(ctx.filePath, 'utf8');
    } catch (error) {
      throw stateError('STATE_READ_FAILED', 'Luma 数据文件无法读取', error);
    }
    const parsed = parseStored(raw, ctx.filePath);
    return {
      state: publicState(parsed.stored),
      meta: parsed.meta,
      sessionId: ctx.sessionId,
      filePath: ctx.filePath,
    };
  }

  function load() {
    try {
      const result = readCurrent();
      recovery = null;
      return result;
    } catch (error) {
      recovery = {
        code: error.code || 'STATE_LOAD_FAILED',
        message: error.message,
        filePath: (() => { try { return filePath(); } catch { return ''; } })(),
        detectedAt: now(),
      };
      throw error;
    }
  }

  function assertStorageExpected(current, expected) {
    if (recovery) throw stateError('STATE_RECOVERY_REQUIRED', 'Luma 数据处于恢复状态，已禁止普通保存');
    if (!expected || expected.sessionId !== current.sessionId) {
      throw stateError('STATE_SESSION_STALE', '数据位置已变化或请求来自旧会话，请重新加载后再保存');
    }
    if (expected.storageId && expected.storageId !== current.meta.storageId) {
      throw stateError('STATE_STORAGE_MISMATCH', '当前数据文件身份已变化，请重新加载');
    }
  }

  function assertExpected(current, expected) {
    assertStorageExpected(current, expected);
    if (Number(expected.revision) !== Number(current.meta.revision)) {
      throw stateError('STATE_REVISION_CONFLICT', '本地数据已被更新，旧状态不能覆盖新状态');
    }
  }

  function assertBusinessExpected(current, expected) {
    assertStorageExpected(current, expected);
    if (Number(expected.businessRevision) !== Number(current.meta.businessRevision)) {
      throw stateError('STATE_REVISION_CONFLICT', '本地业务数据已被更新，旧快照不能覆盖新状态');
    }
  }

  function atomicWrite(filename, value) {
    fsImpl.mkdirSync(path.dirname(filename), { recursive: true });
    const temp = `${filename}.tmp-${process.pid}-${idFactory()}`;
    try {
      fsImpl.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
      fsImpl.renameSync(temp, filename);
    } catch (error) {
      try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch {}
      throw stateError('STATE_WRITE_FAILED', 'Luma 数据保存失败，原文件保持不变', error);
    }
  }

  function writeCommit(state, current, nextMeta) {
    nextMeta.pendingOperations = (nextMeta.pendingOperations || []).map((item) => sanitizeOperation(item, now()));
    const stored = clone(state);
    stored[META_KEY] = nextMeta;
    atomicWrite(current.filePath, stored);
    recovery = null;
    return {
      state: publicState(stored),
      meta: clone(nextMeta),
      sessionId: current.sessionId,
      filePath: current.filePath,
    };
  }

  function commit(state, expected, transformMeta) {
    validateBusinessState(state);
    const current = readCurrent();
    assertBusinessExpected(current, expected);
    const nextMeta = {
      schema: META_SCHEMA,
      revision: current.meta.revision + 1,
      businessRevision: current.meta.businessRevision + 1,
      storageId: current.meta.storageId,
      pendingOperations: current.meta.pendingOperations.map((item) => clone(item)),
    };
    if (transformMeta) transformMeta(nextMeta, current);
    return writeCommit(state, current, nextMeta);
  }

  function commitCurrentMeta(expected, transformMeta) {
    const current = readCurrent({ allowMissing: false });
    assertExpected(current, expected);
    const nextMeta = {
      schema: META_SCHEMA,
      revision: current.meta.revision + 1,
      businessRevision: current.meta.businessRevision,
      storageId: current.meta.storageId,
      pendingOperations: current.meta.pendingOperations.map((item) => clone(item)),
    };
    if (transformMeta) transformMeta(nextMeta, current);
    return writeCommit(current.state, current, nextMeta);
  }

  function operationInsert(meta, operation) {
    const prepared = sanitizeOperation({ ...operation, phase: operation?.phase || 'prepared' }, now());
    const existing = meta.pendingOperations.find((item) => item.id === prepared.id);
    if (existing) {
      if (existing.provider !== prepared.provider
        || existing.kind !== prepared.kind
        || existing.localItemId !== prepared.localItemId) {
        throw stateError('OPERATION_ID_REUSED', '同步操作 ID 已存在且身份不同');
      }
      return existing;
    }
    meta.pendingOperations.push(prepared);
    return prepared;
  }

  function operationAdvance(meta, operationId, patch) {
    const index = meta.pendingOperations.findIndex((item) => item.id === operationId);
    if (index < 0) throw stateError('OPERATION_MISSING', '找不到待恢复的同步操作');
    const current = meta.pendingOperations[index];
    meta.pendingOperations[index] = sanitizeOperation({
      ...current,
      ...clone(patch || {}),
      id: current.id,
      provider: current.provider,
      kind: current.kind,
      localItemId: current.localItemId,
      createdAt: current.createdAt,
      updatedAt: now(),
    }, now());
    return meta.pendingOperations[index];
  }

  function prepareOperation(state, expected, operation) {
    return commit(state, expected, (meta) => { operationInsert(meta, operation); });
  }

  function advanceOperation(state, expected, operationId, patch) {
    return commit(state, expected, (meta) => { operationAdvance(meta, operationId, patch); });
  }

  function completeOperation(state, expected, operationId) {
    return commit(state, expected, (meta) => {
      meta.pendingOperations = meta.pendingOperations.filter((item) => item.id !== operationId);
    });
  }

  function prepareOperationMeta(expected, operation) {
    return commitCurrentMeta(expected, (meta) => { operationInsert(meta, operation); });
  }

  function advanceOperationMeta(expected, operationId, patch) {
    return commitCurrentMeta(expected, (meta) => { operationAdvance(meta, operationId, patch); });
  }

  function completeOperationMeta(expected, operationId) {
    return commitCurrentMeta(expected, (meta) => {
      meta.pendingOperations = meta.pendingOperations.filter((item) => item.id !== operationId);
    });
  }

  function status() {
    let current = null;
    try { current = readCurrent(); } catch {}
    return {
      recovery: clone(recovery),
      filePath: current?.filePath || contextPath || '',
      revision: current?.meta?.revision ?? null,
      businessRevision: current?.meta?.businessRevision ?? null,
      storageId: current?.meta?.storageId || '',
      sessionId: current?.sessionId || contextSessionId || '',
      pendingOperations: clone(current?.meta?.pendingOperations || []),
    };
  }

  return {
    load,
    commit,
    prepareOperation,
    advanceOperation,
    completeOperation,
    prepareOperationMeta,
    advanceOperationMeta,
    completeOperationMeta,
    status,
    readCurrent,
  };
}

module.exports = {
  META_KEY,
  META_SCHEMA,
  createStateStore,
  validateBusinessState,
  sanitizeOperation,
};

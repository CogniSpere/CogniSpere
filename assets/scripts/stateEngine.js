/**
 * stateEngine.js - Ultra-Enhanced State Engine (Refactored)
 *
 * Improvements:
 * - Safe storage access (works when sessionStorage/localStorage unavailable)
 * - Explicit persisted envelope with compressed flag + expires
 * - Persisted-expiry checked on read (persisted-only entries supported)
 * - Safe dispatchEvent wrapper and pluggable emitter
 * - Faster history trimming (splice)
 * - batchSet supports concurrency and stopOnError
 * - Non-blocking subscriber callbacks (queueMicrotask / setTimeout fallback)
 * - Robust syncHash with guards
 * - getWithMeta helper, history meta, and other small hardenings
 *
 * Exports:
 * set, get, batchSet, batchGet, setStorage, addGlobalHook, addComponentHook,
 * getHistory, clearHistory, setHistoryCap, setDebug, getRegistry, listComponents,
 * listKeys, validateAllStates, filterStatesBy, subscribe, batchSubscribe,
 * unsubscribeAll, findKeys, forget, setEmitter, getWithMeta
 */

/* eslint-disable no-unused-vars */
const StateEngine = (() => {
  // Internal state maps
  const states = new Map(); // componentId -> Map(key -> { value, expires, meta })
  const subscribers = new Map(); // "componentId:key" -> [callbacks]
  const componentHooks = new Map(); // componentId -> { beforeSet:[], afterSet:[], error:[] }
  const globalHooks = { beforeSet: [], afterSet: [], error: [] };
  const stateHistory = [];

  // Config / runtime
  let maxHistoryLength = 500;
  let debug = false;
  let storageMode = 'session'; // 'session' or 'local' or 'none'
  let storage = getDefaultStorage(); // safe wrapper uses this
  const STORAGE_PREFIX = 'state:'; // persisted key prefix
  const eventPrefix = 'state:';
  let customEmitter = null; // optional (type, detail) => void

  // helpers to test environment
  const _hasWindow = typeof window !== 'undefined';
  const _hasDocument = typeof document !== 'undefined';
  const _hasPerformance = typeof performance !== 'undefined' && typeof performance.now === 'function';

  // Safe performance.now
  function now() {
    return _hasPerformance ? performance.now() : Date.now();
  }

  // Debug logger
  function log(...args) {
    if (debug) console.log('[StateEngine]', ...args);
  }
  function trace(...args) {
    if (debug) {
      try { console.trace('[StateEngine TRACE]', ...args); } catch { console.log('[StateEngine TRACE]', ...args); }
    }
  }

  // Determine default storage safely
  function getDefaultStorage() {
    try {
      if (_hasWindow && typeof sessionStorage !== 'undefined') return sessionStorage;
    } catch (e) {
      // access to sessionStorage can throw in some privacy modes
    }
    return null;
  }

  // Public: setStorage(true) -> localStorage, false -> sessionStorage, 'none' -> disable
  function setStorage(useLocal = false) {
    if (useLocal === 'none') {
      storageMode = 'none';
      storage = null;
      log('Storage disabled');
      return;
    }
    storageMode = useLocal ? 'local' : 'session';
    try {
      if (_hasWindow) {
        storage = useLocal ? localStorage : sessionStorage;
      } else storage = null;
      log('Storage mode set:', storageMode);
    } catch (e) {
      storage = null;
      log('Storage mode set but access failed (privacy/restrictions). Falling back to none.', e);
    }
  }

  // Safe storage operations (wrap exceptions)
  function safeSetItem(k, v) {
    if (!storage) return;
    try { storage.setItem(k, v); } catch (e) { log('storage.setItem failed', e); }
  }
  function safeGetItem(k) {
    if (!storage) return null;
    try { return storage.getItem(k); } catch (e) { log('storage.getItem failed', e); return null; }
  }
  function safeRemoveItem(k) {
    if (!storage) return;
    try { storage.removeItem(k); } catch (e) { log('storage.removeItem failed', e); }
  }

  // Base64 helpers with fallbacks
  function _btoa(str) {
    if (typeof btoa === 'function') return btoa(str);
    try { return Buffer.from(str, 'utf8').toString('base64'); } catch { return str; }
  }
  function _atob(str) {
    if (typeof atob === 'function') return atob(str);
    try { return Buffer.from(str, 'base64').toString('utf8'); } catch { return str; }
  }

  // Persist envelope helpers.
  // Stored JSON: { __v: 1, compressed: bool, value: string, expires: number|null }
  function persistEncode(value, { compressed = false, expires } = {}) {
    try {
      if (compressed) {
        const s = JSON.stringify(value);
        const b64 = _btoa(s);
        return JSON.stringify({ __v: 1, compressed: true, value: b64, expires: expires || null });
      } else {
        return JSON.stringify({ __v: 1, compressed: false, value: value, expires: expires || null });
      }
    } catch (e) {
      log('persistEncode failed, falling back to raw JSON', e);
      try { return JSON.stringify({ __v: 1, compressed: false, value: String(value), expires: expires || null }); } catch { return null; }
    }
  }

  function persistDecode(storedStr) {
    if (!storedStr) return null;
    try {
      const env = JSON.parse(storedStr);
      if (env && env.__v === 1) {
        if (env.compressed) {
          const s = _atob(env.value);
          return { value: JSON.parse(s), expires: env.expires || null };
        }
        return { value: env.value, expires: env.expires || null };
      }
    } catch (e) {
      log('persistDecode parse failed; attempting legacy parse', e);
      try {
        // Legacy fallback: raw JSON or base64 heuristics
        if (storedStr.startsWith('{') || storedStr.startsWith('[') || storedStr.startsWith('"')) {
          return { value: JSON.parse(storedStr), expires: null };
        } else {
          // not safe to assume base64 -> try decode safely
          try {
            const decoded = _atob(storedStr);
            return { value: JSON.parse(decoded), expires: null };
          } catch { return null; }
        }
      } catch (e2) {
        log('legacy parse failed', e2);
        return null;
      }
    }
    return null;
  }

  // Pluggable emitter for environments without document
  function setEmitter(fn) {
    customEmitter = typeof fn === 'function' ? fn : null;
  }

  function dispatchEvent(type, detail) {
    if (customEmitter) {
      try { customEmitter(type, detail); } catch (e) { log('customEmitter failed', e); }
      return;
    }
    if (_hasDocument && typeof CustomEvent === 'function') {
      try { document.dispatchEvent(new CustomEvent(type, { bubbles: true, detail })); }
      catch (e) { log('dispatchEvent failed', e); }
    } else {
      log('Event dispatch skipped (no document/customEmitter)', type, detail);
    }
  }

  // Validation helper (standardized signature)
  async function validateState(componentId, key, value, validator) {
    if (!validator) return true;
    try {
      // Support sync or async validators. Accept boolean true-ish return.
      const r = await validator(componentId, key, value);
      if (!r) throw new Error(`Invalid state value for ${componentId}:${key}`);
      return true;
    } catch (e) {
      log(`Validation error for ${componentId}:${key}`, e);
      throw e;
    }
  }

  // Expiration check for in-memory entry (returns true if expired and removed)
  function _checkExpirationInMemory(componentId, key) {
    const entry = states.get(componentId)?.get(key);
    if (entry && entry.expires && Date.now() > entry.expires) {
      forget(componentId, key);
      return true;
    }
    return false;
  }

  // Sync hash safe
  function syncHash(componentId, key, value, format) {
    try {
      if (!_hasWindow || !('location' in window) || typeof URLSearchParams === 'undefined') return;
      const hashStr = window.location.hash || '';
      const hash = new URLSearchParams(hashStr.slice(1));
      const serialized = format === 'json' ? JSON.stringify(value) : String(value);
      hash.set(`${componentId}:${key}`, serialized);
      window.location.hash = hash.toString();
    } catch (e) {
      log('syncHash failed', e);
    }
  }

  // Subscriber helpers (non-blocking)
  function notifySubscribers(componentId, key, value) {
    const subKey = `${componentId}:${key}`;
    if (!subscribers.has(subKey)) return;
    for (const cb of subscribers.get(subKey)) {
      try {
        // prefer microtask
        if (typeof queueMicrotask === 'function') {
          queueMicrotask(() => { try { cb(value); } catch (e) { log(`Subscriber error for ${subKey}:`, e); } });
        } else {
          setTimeout(() => { try { cb(value); } catch (e) { log(`Subscriber error for ${subKey}:`, e); } }, 0);
        }
      } catch (e) {
        // best-effort fallback
        setTimeout(() => { try { cb(value); } catch (e2) { log(`Subscriber error for ${subKey}:`, e2); } }, 0);
      }
    }
  }

  // Public: subscribe/unsubscribe
  function subscribe(componentId, key, callback) {
    const subKey = `${componentId}:${key}`;
    if (!subscribers.has(subKey)) subscribers.set(subKey, []);
    subscribers.get(subKey).push(callback);
    return () => {
      subscribers.set(subKey, subscribers.get(subKey).filter(cb => cb !== callback));
    };
  }
  function batchSubscribe(componentId, keys, callback) {
    return (keys || []).map(k => subscribe(componentId, k, callback));
  }

  function unsubscribeAll(componentId, key = null) {
    if (key) subscribers.delete(`${componentId}:${key}`);
    else {
      for (const k of Array.from(subscribers.keys()).filter(k => k.startsWith(componentId + ':'))) {
        subscribers.delete(k);
      }
    }
  }

  // Hook registration
  function addGlobalHook(phase, callback) {
    if (globalHooks[phase]) globalHooks[phase].push(callback);
    return () => { globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback); };
  }
  function addComponentHook(componentId, phase, callback) {
    if (!componentHooks.has(componentId)) componentHooks.set(componentId, { beforeSet: [], afterSet: [], error: [] });
    componentHooks.get(componentId)[phase].push(callback);
    return () => {
      componentHooks.get(componentId)[phase] = componentHooks.get(componentId)[phase].filter(cb => cb !== callback);
    };
  }

  async function fireHooks(componentId, phase, payload) {
    // run global hooks concurrently but settled
    const ghooks = Array.from(globalHooks[phase] || []);
    await Promise.allSettled(ghooks.map(cb => (async () => {
      try { return await cb(payload); } catch (e) { log(`Global ${phase} hook error`, e); throw e; }
    })()));

    if (componentHooks.has(componentId)) {
      const chooks = Array.from(componentHooks.get(componentId)[phase] || []);
      // run component hooks concurrently, but errors do not prevent others
      await Promise.allSettled(chooks.map(cb => (async () => {
        try { return await cb(payload); } catch (e) { log(`Component ${phase} hook error`, e); throw e; }
      })()));
    }
  }

  // Core: set a state value
  async function set(componentId, key, value, options = {}) {
    const startTime = now();
    if (!componentId || !key) throw new Error('componentId and key are required for set()');

    if (!states.has(componentId)) states.set(componentId, new Map());

    const { persist = false, compress = false, validator = null, hashFormat = 'json', expires } = options;

    try {
      await validateState(componentId, key, value, validator);
      await fireHooks(componentId, 'beforeSet', { componentId, key, value, persist, options });

      const expirationTimestamp = (typeof expires === 'number') ? (Date.now() + expires) : undefined;
      states.get(componentId).set(key, { value, expires: expirationTimestamp, meta: { options } });

      // push history entry
      stateHistory.push({
        componentId, key, value, persist, time: Date.now(), performance: { duration: now() - startTime }
      });
      if (stateHistory.length > maxHistoryLength) stateHistory.splice(0, stateHistory.length - maxHistoryLength);

      // persist with envelope
      if (persist) {
        const envStr = persistEncode(value, { compressed: !!compress, expires: expirationTimestamp || null });
        if (envStr !== null) safeSetItem(`${STORAGE_PREFIX}${componentId}:${key}`, envStr);
      }

      dispatchEvent(`${eventPrefix}changed`, { componentId, key, value });
      syncHash(componentId, key, value, hashFormat);
      notifySubscribers(componentId, key, value);

      await fireHooks(componentId, 'afterSet', {
        componentId, key, value, persist, performance: { duration: now() - startTime }
      });

      log(`State set: ${componentId}:${key}`, value);
      return { ok: true };
    } catch (e) {
      log(`Error setting state ${componentId}:${key}:`, e);
      await fireHooks(componentId, 'error', { componentId, key, value, error: e });
      dispatchEvent(`${eventPrefix}error`, { componentId, key, value, error: e });
      throw e;
    }
  }

  // Batch state updates with optional concurrency
  async function batchSet(componentId, updates = [], opts = {}) {
    const startTime = now();
    if (!Array.isArray(updates)) throw new Error('batchSet requires updates array');
    const { concurrency = 1, stopOnError = false } = opts;

    const queue = Array.from(updates); // shallow copy
    const results = [];

    const worker = async () => {
      while (queue.length) {
        const { key, value, options } = queue.shift();
        try {
          await set(componentId, key, value, options || {});
          results.push({ key, ok: true });
        } catch (err) {
          results.push({ key, ok: false, error: err });
          if (stopOnError) queue.length = 0;
        }
      }
    };

    const workers = Array.from({ length: Math.max(1, concurrency) }, worker);
    await Promise.allSettled(workers);

    log(`Batch update completed for ${componentId}`, { count: updates.length, duration: now() - startTime });
    dispatchEvent(`${eventPrefix}batchApplied`, { componentId, count: updates.length, duration: now() - startTime });
    return { duration: now() - startTime, results };
  }

  // getWithMeta returns value plus metadata
  function getWithMeta(componentId, key) {
    // check in-memory expiration first
    if (_checkExpirationInMemory(componentId, key)) return { value: undefined, persisted: false, expires: null };

    if (states.has(componentId) && states.get(componentId).has(key)) {
      const entry = states.get(componentId).get(key);
      return { value: entry.value, persisted: false, expires: entry.expires || null, source: 'memory', meta: entry.meta || null };
    }

    // check persisted storage
    const raw = safeGetItem(`${STORAGE_PREFIX}${componentId}:${key}`);
    const decoded = persistDecode(raw);
    if (!decoded) return { value: undefined, persisted: false, expires: null };
    if (decoded.expires && Date.now() > decoded.expires) {
      // expired persisted entry
      forget(componentId, key);
      return { value: undefined, persisted: false, expires: null };
    }
    // return persisted value (but not yet in memory)
    return { value: decoded.value, persisted: true, expires: decoded.expires || null, source: 'persist' };
  }

  // get() convenience - returns value or undefined
  function get(componentId, key) {
    const meta = getWithMeta(componentId, key);
    return meta.value;
  }

  // batchGet: keys array or all keys in component
  function batchGet(componentId, keys = null) {
    if (!componentId) return {};
    const result = {};
    if (keys && Array.isArray(keys)) {
      for (const k of keys) result[k] = get(componentId, k);
      return result;
    }
    // include in-memory keys and persisted keys that might not be in memory
    const seen = new Set();
    if (states.has(componentId)) {
      for (const [k, entry] of states.get(componentId).entries()) {
        result[k] = entry.value;
        seen.add(k);
      }
    }
    // try to enumerate persisted keys if storage available
    if (storage) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (!k) continue;
          if (k.startsWith(`${STORAGE_PREFIX}${componentId}:`)) {
            const keyPart = k.slice((STORAGE_PREFIX + componentId + ':').length);
            if (!seen.has(keyPart)) {
              const decoded = persistDecode(safeGetItem(k));
              if (decoded && (!decoded.expires || Date.now() <= decoded.expires)) result[keyPart] = decoded.value;
            }
          }
        }
      } catch (e) {
        log('batchGet storage enumeration failed', e);
      }
    }
    return result;
  }

  // Pattern-based lookup (supports wildcard suffix and RegExp string '/.../')
  function findKeys(componentId, pattern) {
    const keys = new Set();
    if (states.has(componentId)) {
      for (const k of states.get(componentId).keys()) keys.add(k);
    }
    // include persisted keys
    if (storage) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (!k) continue;
          if (k.startsWith(`${STORAGE_PREFIX}${componentId}:`)) {
            const keyPart = k.slice((STORAGE_PREFIX + componentId + ':').length);
            keys.add(keyPart);
          }
        }
      } catch (e) { log('findKeys storage enumeration failed', e); }
    }
    if (!pattern) return Array.from(keys);
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1);
      return Array.from(keys).filter(k => k.startsWith(prefix));
    }
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        const re = new RegExp(pattern.slice(1, -1));
        return Array.from(keys).filter(k => re.test(k));
      } catch (e) { return []; }
    }
    return Array.from(keys).filter(k => k === pattern);
  }

  // forget - remove from memory and persisted storage, notify
  function forget(componentId, key) {
    if (!componentId || !key) return;
    if (states.has(componentId)) {
      states.get(componentId).delete(key);
    }
    safeRemoveItem(`${STORAGE_PREFIX}${componentId}:${key}`);
    dispatchEvent(`${eventPrefix}forgot`, { componentId, key });
    notifySubscribers(componentId, key, undefined);
    log(`Forgot state: ${componentId}:${key}`);
  }

  // History accessors
  function getHistory(filter = {}) {
    let result = Array.from(stateHistory);
    if (filter.componentId) result = result.filter(e => e.componentId === filter.componentId);
    if (filter.key) result = result.filter(e => e.key === filter.key);
    if (filter.maxAge) result = result.filter(e => e.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter(e => !!e.error);
    if (filter.predicate) result = result.filter(filter.predicate);
    return result;
  }
  function clearHistory() { stateHistory.length = 0; log('State history cleared'); }
  function setHistoryCap(cap) {
    maxHistoryLength = Math.max(0, cap);
    if (stateHistory.length > maxHistoryLength) stateHistory.splice(0, stateHistory.length - maxHistoryLength);
    log('History cap set:', maxHistoryLength);
  }

  // Introspection
  function getRegistry() {
    const out = {};
    for (const [cid, kv] of states.entries()) {
      out[cid] = {};
      for (const [k, entry] of kv.entries()) {
        out[cid][k] = { value: entry.value, expires: entry.expires || null, meta: entry.meta || null };
      }
    }
    return out;
  }
  function listComponents() { return Array.from(states.keys()); }
  function listKeys(componentId) { return states.has(componentId) ? Array.from(states.get(componentId).keys()) : []; }
  function validateAllStates() {
    return Array.from(states.entries()).map(([cid, kv]) => ({
      componentId: cid,
      keys: Array.from(kv.entries()).map(([key, entry]) => ({ key, valid: true }))
    }));
  }
  function filterStatesBy(predicate) {
    const result = [];
    for (const [cid, kv] of states.entries()) {
      for (const [key, entry] of kv.entries()) {
        if (predicate(cid, key, entry.value)) result.push({ componentId: cid, key, value: entry.value });
      }
    }
    return result;
  }

  // Debug control
  function setDebug(val) { debug = !!val; }

  // Initialization: load hash state if present (safe)
  async function _initFromHash() {
    if (!_hasWindow || !window.location || !window.location.hash) return;
    try {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      for (const [param, value] of hash.entries()) {
        const [componentId, key] = param.split(':');
        if (!componentId || !key) continue;
        try {
          const parsed = (value.startsWith('{') || value.startsWith('[') || value.startsWith('"'))
            ? JSON.parse(value)
            : value;
          // persist loaded hash entries by default
          await set(componentId, key, parsed, { persist: true });
        } catch (e) { log(`Error loading state from hash ${param}:`, e); }
      }
    } catch (e) { log('initFromHash failed', e); }
  }

  // Attempt to initialize on DOMContentLoaded if available
  try {
    if (_hasDocument) {
      document.addEventListener('DOMContentLoaded', () => { _initFromHash().then(() => log('StateEngine initialized (DOM)')).catch(() => {}); });
    } else {
      // no document - try immediate init for non-DOM environment
      _initFromHash().then(() => log('StateEngine initialized (no DOM)')).catch(() => {});
    }
  } catch (e) {
    log('Initialization wrapper error', e);
  }

  // Exported API
  return {
    // core
    set,
    get,
    getWithMeta,
    batchSet,
    batchGet,
    forget,
    findKeys,

    // storage & emitter
    setStorage,
    setEmitter,

    // hooks
    addGlobalHook,
    addComponentHook,

    // history
    getHistory,
    clearHistory,
    setHistoryCap,

    // debug & introspection
    setDebug,
    getRegistry,
    listComponents,
    listKeys,
    validateAllStates,
    filterStatesBy,

    // subscriptions
    subscribe,
    batchSubscribe,
    unsubscribeAll,

    // meta
    __internal: { _persistEncode: persistEncode, _persistDecode: persistDecode } // for testing/debug only
  };
})();

export default StateEngine;

// MemoryEngine - enhanced: adapters (symbol, gesture, narrative), DOM binding, meta-context, transactions/undo-redo, per-key metrics
const MemoryEngine = (() => {
  const memory = new Map(); // key -> { value, expires, meta }
  let storage = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
  const hooks = new Map(); // key -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], after: [], error: [] };
  const history = []; // structured history entries
  const metrics = new Map(); // key -> { store:{count,avg}, recall:{count,avg}, forget:{count,avg} }
  const subs = new Map(); // key -> Set(cb)
  const metaContext = new Map(); // topic -> value
  const metaSubs = new Map(); // topic -> Set(cb)
  const transactions = []; // active transaction stack
  const txHistory = []; // committed transactions for undo/redo
  let txPointer = txHistory.length - 1;
  let debug = false;
  let historyCap = 300;
  let autoCleanupIntervalId = null;
  const eventPrefix = 'memory:';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // adapters (opt-in)
  let symbolAPI = null;   // { apply(context) => Promise }
  let gestureAPI = null;  // { registerAnchor, attachDetect, ... }
  let narrativeAPI = null; // { track, on, registerStoryboard...? }

  // Logging
  const log = (...a) => { if (debug) try { console.log('[MemoryEngine]', ...a); } catch(_){} };

  // Errors
  const createError = (m, c, d) => Object.assign(new Error(m), { code: c, details: d });

  // Metrics helper
  function _ensureMetrics(key) {
    if (!metrics.has(key)) metrics.set(key, { store: { count: 0, avg: 0 }, recall: { count: 0, avg: 0 }, forget: { count: 0, avg: 0 } });
    return metrics.get(key);
  }

  // History push
  function _pushHistory(entry) {
    history.push(entry);
    while (history.length > historyCap) history.shift();
  }

  // Hooks
  function addHook(key, phase, cb) {
    if (!hooks.has(key)) hooks.set(key, { before: [], after: [], error: [] });
    hooks.get(key)[phase].push(cb);
    return () => { hooks.get(key)[phase] = hooks.get(key)[phase].filter(x => x !== cb); };
  }
  function addGlobalHook(phase, cb) {
    if (!globalHooks[phase]) throw createError('invalid phase', 'INVALID_PHASE');
    globalHooks[phase].push(cb);
    return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); };
  }
  async function _fireHooks(key, phase, payload) {
    for (const g of globalHooks[phase] || []) try { await Promise.resolve(g({ key, payload })); } catch (e) { log('global hook err', e); }
    if (!hooks.has(key)) return;
    for (const cb of (hooks.get(key)[phase] || []).slice()) try { await Promise.resolve(cb(payload)); } catch (e) { log('hook err', e); }
  }

  // Subscriptions
  function subscribe(key, cb) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(cb);
    return () => subs.get(key).delete(cb);
  }
  function _notifySubs(key, value) {
    const s = subs.get(key);
    if (!s) return;
    for (const cb of Array.from(s)) try { cb(value); } catch (e) { log('sub cb err', e); }
  }

  // Meta-context (synergy)
  function publishMeta(topic, payload) {
    const prev = metaContext.has(topic) ? metaContext.get(topic) : undefined;
    metaContext.set(topic, payload);
    _recordTx({ type: 'meta', topic, prev, new: payload });
    const s = metaSubs.get(topic) || new Set();
    for (const cb of Array.from(s)) try { cb(payload, prev); } catch (e) { log('meta cb err', e); }
  }
  function onMeta(topic, cb) {
    if (!metaSubs.has(topic)) metaSubs.set(topic, new Set());
    metaSubs.get(topic).add(cb);
    return () => metaSubs.get(topic).delete(cb);
  }
  function readMeta(topic) { return metaContext.get(topic); }

  // Transactions / undo-redo
  function _recordTx(op) { if (!transactions.length) return; transactions[transactions.length - 1].ops.push(op); }
  function beginTransaction(label) {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label || '', ops: [], createdAt: Date.now(), committed: false };
    transactions.push(tx);
    log('tx begin', tx.id);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TRANSACTION');
    const tx = transactions.pop();
    tx.committed = true;
    txHistory.splice(txPointer + 1);
    txHistory.push(tx);
    txPointer = txHistory.length - 1;
    log('tx commit', tx.id);
    return tx.id;
  }
  async function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TRANSACTION');
    const tx = transactions.pop();
    // reverse ops in reverse order
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'store') {
          if (op.prev === undefined) memory.delete(op.key);
          else memory.set(op.key, op.prev);
        } else if (op.type === 'forget') {
          if (op.prev !== undefined) memory.set(op.key, op.prev);
          else memory.delete(op.key);
        } else if (op.type === 'meta') {
          if (op.prev === undefined) metaContext.delete(op.topic); else metaContext.set(op.topic, op.prev);
        } else if (op.type === 'persist') {
          // best-effort: restore storage state
          try {
            if (op.prevRaw === undefined) storage && storage.removeItem(eventPrefix + op.key);
            else storage && storage.setItem(eventPrefix + op.key, op.prevRaw);
          } catch (_) {}
        }
      } catch (e) { log('rollback op failed', e); }
    }
    log('tx rollback', tx.id);
    return tx.id;
  }
  async function undo(steps = 1) {
    let undone = 0;
    while (undone < steps && txPointer >= 0) {
      const tx = txHistory[txPointer];
      transactions.push({ ops: tx.ops.slice() });
      await rollbackTransaction();
      txPointer--;
      undone++;
    }
    return { undone };
  }
  async function redo(steps = 1) {
    let redone = 0;
    while (redone < steps && txPointer < txHistory.length - 1) {
      const next = txHistory[txPointer + 1];
      for (const op of next.ops) {
        try {
          if (op.type === 'store') {
            memory.set(op.key, op.new);
            _notifySubs(op.key, op.new.value);
          } else if (op.type === 'forget') {
            memory.delete(op.key);
            _notifySubs(op.key, undefined);
          } else if (op.type === 'meta') {
            metaContext.set(op.topic, op.new);
            const s = metaSubs.get(op.topic) || new Set();
            for (const cb of Array.from(s)) try { cb(op.new, op.prev); } catch (_) {}
          } else if (op.type === 'persist') {
            try { storage && storage.setItem(eventPrefix + op.key, op.newRaw); } catch (_) {}
          }
        } catch (e) { log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer + 1, txHistory.length - 1);
      redone++;
    }
    return { redone };
  }

  // Auto-cleanup expired
  function _isExpired(entry) { return entry && entry.expires && Date.now() > entry.expires; }
  function _cleanupExpired() {
    for (const [k, ent] of Array.from(memory.entries())) {
      if (_isExpired(ent)) {
        const prev = ent;
        memory.delete(k);
        _pushHistory({ op: 'expire', key: k, time: Date.now(), error: null, performance: { duration: 0 } });
        _notifySubs(k, undefined);
        _recordTx({ type: 'forget', key: k, prev });
      }
    }
  }
  function startAutoCleanup(ms = 60000) { stopAutoCleanup(); if (!ms || ms <= 0) return; autoCleanupIntervalId = setInterval(_cleanupExpired, ms); }
  function stopAutoCleanup() { if (autoCleanupIntervalId) { clearInterval(autoCleanupIntervalId); autoCleanupIntervalId = null; } }

  // Storage helpers with compress opt
  function _safeSetStorage(key, raw) {
    try { storage && storage.setItem(key, raw); } catch (e) { log('storage set failed', e); }
  }
  function _safeGetStorage(key) {
    try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
  }
  function compress(v) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(v)))); } catch (e) { if (typeof Buffer !== 'undefined') return Buffer.from(JSON.stringify(v)).toString('base64'); throw e; } }
  function decompress(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch (e) { if (typeof Buffer !== 'undefined') return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); throw e; } }

  // Core API: store
  async function store(key, value, options = {}) {
    const t0 = now();
    const { persist = false, compress: doCompress = false, validator = null, expires = 0, ariaLabel } = options;
    if (!key || typeof key !== 'string') throw createError('invalid key', 'INVALID_KEY');
    try {
      if (validator && typeof validator === 'function') {
        const ok = await Promise.resolve(validator(value));
        if (!ok) throw createError('validator rejected', 'VALIDATOR_REJECT');
      }
      await _fireHooks(key, 'before', { key, value, options });
      const prev = memory.has(key) ? memory.get(key) : undefined;
      const ent = { value, expires: expires ? Date.now() + expires : undefined, meta: options.meta || null };
      memory.set(key, ent);
      _recordTx({ type: 'store', key, prev, new: ent });
      if (persist && storage) {
        const raw = doCompress ? compress(value) : JSON.stringify(value);
        const prevRaw = _safeGetStorage(eventPrefix + key);
        _recordTx({ type: 'persist', key, prevRaw, newRaw: raw });
        _safeSetStorage(eventPrefix + key, raw);
      }
      _pushHistory({ op: 'store', key, value, persist: !!persist, time: Date.now(), error: null, performance: { duration: now() - t0 } });
      _ensureMetrics(key).store.count++; _ensureMetrics(key).store.avg = ( (_ensureMetrics(key).store.avg * (_ensureMetrics(key).store.count - 1)) + (now() - t0) ) / _ensureMetrics(key).store.count;
      _notifySubs(key, value);
      await _fireHooks(key, 'after', { key, value, options });
      if (ariaLabel && typeof document !== 'undefined' && document.body) {
        document.body.setAttribute('aria-label', ariaLabel);
        setTimeout(() => document.body.removeAttribute('aria-label'), 1000);
      }
      // adapter notifications
      if (symbolAPI && typeof symbolAPI.apply === 'function' && options.triggerSymbol) {
        try { await symbolAPI.apply({ key, value, context: options.symbolContext || {} }); } catch (e) { log('symbolAPI apply err', e); }
      }
      if (gestureAPI && options.publishMetaOnStore) {
        publishMeta(options.publishMetaOnStore.topic || `memory:store:${key}`, { key, value });
      }
      return { ok: true };
    } catch (e) {
      await _fireHooks(key, 'error', { key, value, error: e });
      _pushHistory({ op: 'store', key, value, persist: !!persist, time: Date.now(), error: e, performance: { duration: now() - t0 } });
      throw e;
    }
  }

  // Batch store (concurrency)
  async function batchStore(entries = [], { concurrency = 4, stopOnError = false } = {}) {
    if (!Array.isArray(entries)) throw createError('entries must be array', 'INVALID_ARG');
    const results = {};
    let i = 0;
    const workers = new Array(Math.min(concurrency, entries.length)).fill(0).map(async () => {
      while (i < entries.length) {
        const idx = i++;
        const { key, value, options } = entries[idx];
        try { await store(key, value, options); results[key] = { ok: true }; } catch (e) { results[key] = { ok: false, error: e }; if (stopOnError) throw e; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // recall
  function recall(key, { restorePersisted = true } = {}) {
    const t0 = now();
    if (!key || typeof key !== 'string') throw createError('invalid key', 'INVALID_KEY');
    if (memory.has(key)) {
      const ent = memory.get(key);
      if (_isExpired(ent)) {
        const prev = ent;
        memory.delete(key);
        _pushHistory({ op: 'recall', key, value: undefined, time: Date.now(), error: createError('expired','EXPIRED'), performance: { duration: now() - t0 } });
        _recordTx({ type: 'forget', key, prev });
        _notifySubs(key, undefined);
        return undefined;
      }
      _pushHistory({ op: 'recall', key, value: ent.value, time: Date.now(), error: null, performance: { duration: now() - t0 } });
      const m = _ensureMetrics(key); m.recall.count++; m.recall.avg = (m.recall.avg * (m.recall.count - 1) + (now() - t0)) / m.recall.count;
      return ent.value;
    }
    if (restorePersisted && storage) {
      const raw = _safeGetStorage(eventPrefix + key);
      if (!raw) return undefined;
      try {
        const val = (raw[0] === '{' || raw[0] === '[' || raw[0] === '"') ? JSON.parse(raw) : decompress(raw);
        memory.set(key, { value: val, expires: undefined, meta: { persisted: true } });
        _pushHistory({ op: 'recall', key, value: val, time: Date.now(), error: null, performance: { duration: now() - t0 } });
        _notifySubs(key, val);
        const m = _ensureMetrics(key); m.recall.count++; m.recall.avg = (m.recall.avg * (m.recall.count - 1) + (now() - t0)) / m.recall.count;
        return val;
      } catch (e) {
        const err = createError('recall parse error', 'RECALL_ERROR', { error: e });
        _pushHistory({ op: 'recall', key, value: null, time: Date.now(), error: err, performance: { duration: now() - t0 } });
        _fireHooks(key, 'error', { key, error: err }).catch(()=>{});
        return undefined;
      }
    }
    return undefined;
  }

  // batchRecall
  function batchRecall(keys = []) {
    if (!Array.isArray(keys)) throw createError('keys must be array', 'INVALID_ARG');
    const out = {};
    for (const k of keys) out[k] = recall(k);
    return out;
  }

  // influence: call callback with stored value
  async function influence(key, cb) {
    const t0 = now();
    try {
      await _fireHooks(key, 'before', { key });
      const val = recall(key);
      if (typeof cb === 'function') await Promise.resolve(cb(val));
      await _fireHooks(key, 'after', { key, value: val });
      _pushHistory({ op: 'influence', key, value: val, time: Date.now(), error: null, performance: { duration: now() - t0 } });
      return { ok: true };
    } catch (e) {
      await _fireHooks(key, 'error', { key, error: e });
      _pushHistory({ op: 'influence', key, time: Date.now(), error: e, performance: { duration: now() - t0 } });
      return { ok: false, error: e };
    }
  }

  // forget
  async function forget(key) {
    const t0 = now();
    if (!key || typeof key !== 'string') throw createError('invalid key', 'INVALID_KEY');
    const prev = memory.has(key) ? memory.get(key) : undefined;
    _recordTx({ type: 'forget', key, prev });
    try {
      await _fireHooks(key, 'before', { key });
      memory.delete(key);
      try { storage && storage.removeItem(eventPrefix + key); } catch (_) {}
      _notifySubs(key, undefined);
      await _fireHooks(key, 'after', { key });
      _pushHistory({ op: 'forget', key, time: Date.now(), error: null, performance: { duration: now() - t0 } });
      _ensureMetrics(key).forget.count++; _ensureMetrics(key).forget.avg = ( (_ensureMetrics(key).forget.avg * (_ensureMetrics(key).forget.count - 1)) + (now() - t0) ) / _ensureMetrics(key).forget.count;
      return { ok: true };
    } catch (e) {
      await _fireHooks(key, 'error', { key, error: e });
      _pushHistory({ op: 'forget', key, time: Date.now(), error: e, performance: { duration: now() - t0 } });
      throw e;
    }
  }

  // DOM binding: simple binder for elements with data-memory="key"
  const domBindings = new WeakMap();
  function bindElement(element, { key, attr = 'text', syncInput = true } = {}) {
    if (!(element instanceof Element)) throw createError('element required', 'INVALID_ELEMENT');
    domBindings.set(element, { key, attr, syncInput });
    const val = recall(key);
    try { if (syncInput && 'value' in element) element.value = val == null ? '' : val; else element.textContent = val == null ? '' : String(val); } catch(_) {}
    const handler = syncInput && 'value' in element ? (ev => { store(key, element.value).catch(e => log('dom->store failed', e)); }) : null;
    if (handler) element.addEventListener('input', handler);
    // subscribe to memory updates
    const unsub = subscribe(key, (v) => {
      try { if (syncInput && 'value' in element) element.value = v == null ? '' : v; else element.textContent = v == null ? '' : String(v); } catch(_) {}
    });
    _recordTx({ type: 'domBind', element, key, handler, unsub });
    return () => { unsub(); if (handler) element.removeEventListener('input', handler); domBindings.delete(element); };
  }

  // Adapters attach
  function attachSymbolAPI(api) { symbolAPI = api; return () => { symbolAPI = null; }; }
  function attachGestureAPI(api) { gestureAPI = api; return () => { gestureAPI = null; }; }
  function attachNarrativeAPI(api) { narrativeAPI = api; return () => { narrativeAPI = null; }; }

  // Load persisted values on init
  function init() {
    if (!storage) return;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (!k || !k.startsWith(eventPrefix)) continue;
        const key = k.slice(eventPrefix.length);
        try {
          const raw = storage.getItem(k);
          if (!raw) continue;
          const val = (raw[0] === '{' || raw[0] === '[' || raw[0] === '"') ? JSON.parse(raw) : decompress(raw);
          memory.set(key, { value: val });
          _pushHistory({ op: 'load', key, value: val, time: Date.now(), error: null, performance: { duration: 0 } });
        } catch (e) {
          _pushHistory({ op: 'load', key, value: null, time: Date.now(), error: createError('load failed', 'LOAD_ERROR', { error: e }), performance: { duration: 0 } });
        }
      }
    } catch (e) { log('init read failed', e); }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  // Utilities & getters
  function getRegistry() { return Object.fromEntries(Array.from(memory.entries()).map(([k, v]) => [k, Object.assign({}, v)])); }
  function getHistory(filter = {}) {
    let res = history.slice();
    if (filter.op) res = res.filter(r => r.op === filter.op);
    if (filter.key) res = res.filter(r => r.key === filter.key);
    if (filter.maxAge) res = res.filter(r => r.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(r => !!r.error);
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { history.length = 0; }
  function setHistoryCap(cap) { if (typeof cap !== 'number' || cap < 0) throw createError('invalid cap', 'INVALID_HISTORY_CAP'); historyCap = cap; while (history.length > historyCap) history.shift(); }
  function setStorage(useLocal = false) { if (typeof window === 'undefined') return; storage = useLocal ? window.localStorage : window.sessionStorage; log('storage', useLocal ? 'localStorage' : 'sessionStorage'); }
  function setDebug(v = true) { debug = !!v; log('debug', debug); }
  function getMetrics() { return Object.fromEntries(metrics.entries()); }

  // Expose API
  return {
    store,
    batchStore,
    recall,
    batchRecall,
    influence,
    forget,
    addHook,
    addGlobalHook,
    subscribe,
    bindElement,
    attachSymbolAPI,
    attachGestureAPI,
    attachNarrativeAPI,
    publishMeta,
    onMeta,
    readMeta,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    undo,
    redo,
    getRegistry,
    getHistory,
    clearHistory,
    setHistoryCap,
    setStorage,
    setDebug,
    getMetrics,
    startAutoCleanup,
    stopAutoCleanup,
    _internal: { memory, hooks, history, metrics, metaContext, txHistory }
  };
})();

export default MemoryEngine;
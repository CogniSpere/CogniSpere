// StateEngine - enhanced: DOM binding, per-key hooks, sequences, meta-context/synergy, undo/redo (global), transactions
const StateEngine = (() => {
  const states = new Map(); // componentId -> Map(key -> { value, meta })
  const subscribers = new Map(); // componentId:key -> Set(cb)
  const keyHooks = new Map(); // componentId -> key -> { before:[], after:[], error:[] }
  const globalHooks = { beforeSet: [], afterSet: [], error: [] };
  const history = []; // structured history of ops
  const metrics = new Map(); // componentId:key -> { setCount, avgTime, errors }
  const transactions = []; // active tx stack
  const txHistory = []; // committed txs for undo/redo
  let txPointer = txHistory.length - 1;
  let historyCap = 500;
  let debug = false;
  let storageMode = 'session'; // 'session'|'local'|'none'
  let storage = (typeof sessionStorage !== 'undefined') ? sessionStorage : null;
  const PREFIX = 'state:';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // meta-context / synergy
  const metaContext = new Map(); // topic -> value
  const metaSubs = new Map(); // topic -> Set(cb)
  const dependencies = new Map(); // targetKey -> { sources: [{componentId,key}], resolver }

  // DOM bindings (data-state="component:key" on elements)
  const domBindings = new WeakMap(); // element -> { componentId, key, attr, syncInput }

  // logging
  const log = (...a) => { if (debug) try { console.log('[StateEngine]', ...a); } catch (_) {} };

  // helpers
  function createError(m, c, d) { const e = new Error(m); e.code = c; e.details = d; return e; }
  function _ensureComp(componentId) { if (!states.has(componentId)) states.set(componentId, new Map()); return states.get(componentId); }
  function _histPush(entry) { history.push(entry); while (history.length > historyCap) history.shift(); }
  function setHistoryCap(cap) { if (typeof cap !== 'number' || cap < 0) throw createError('invalid cap','INVALID_HISTORY_CAP'); historyCap = cap; while (history.length > historyCap) history.shift(); }
  function _ensureMetrics(componentId, key) { const mk = `${componentId}:${key}`; if (!metrics.has(mk)) metrics.set(mk, { setCount: 0, avgTime: 0, errors: 0 }); return metrics.get(mk); }
  function _subKey(componentId, key) { return `${componentId}:${key}`; }

  // transaction ops recording
  function _recordTx(op) { if (!transactions.length) return; transactions[transactions.length - 1].ops.push(op); }
  function beginTransaction(label) { const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label||'', ops: [], createdAt: Date.now() }; transactions.push(tx); log('tx begin', tx.id); return tx.id; }
  function commitTransaction() { if (!transactions.length) throw createError('no active transaction','NO_TX'); const tx = transactions.pop(); tx.committedAt = Date.now(); txHistory.splice(txPointer+1); txHistory.push(tx); txPointer = txHistory.length-1; log('tx commit', tx.id); return tx.id; }
  function rollbackTransaction() { if (!transactions.length) throw createError('no active transaction','NO_TX'); const tx = transactions.pop(); for (let i = tx.ops.length-1; i >= 0; i--) { const op = tx.ops[i]; try { if (op.type === 'set') { const comp = _ensureComp(op.componentId); if (op.prev === undefined) comp.delete(op.key); else comp.set(op.key, op.prev); } else if (op.type === 'remove') { const comp = _ensureComp(op.componentId); if (op.prev !== undefined) comp.set(op.key, op.prev); else comp.delete(op.key); } else if (op.type === 'metaPublish') { if (op.prev === undefined) metaContext.delete(op.topic); else metaContext.set(op.topic, op.prev); } } catch(e){ log('rollback op failed', e); } } log('tx rollback', tx.id); return tx.id; }

  // global undo/redo using committed transactions
  async function undo(steps = 1) {
    let undone = 0;
    while (undone < steps && txPointer >= 0) {
      const tx = txHistory[txPointer];
      // create a fake tx on active stack for reuse of rollback logic
      transactions.push({ ops: tx.ops.slice() });
      rollbackTransaction();
      txPointer--;
      undone++;
    }
    return { undone };
  }
  async function redo(steps = 1) {
    let redone = 0;
    while (redone < steps && txPointer < txHistory.length - 1) {
      const next = txHistory[txPointer+1];
      // reapply ops in order
      for (const op of next.ops) {
        try {
          if (op.type === 'set') {
            const comp = _ensureComp(op.componentId);
            comp.set(op.key, { value: op.new.value, meta: op.new.meta });
            _notifySubs(op.componentId, op.key, op.new.value, op.new.meta);
          } else if (op.type === 'remove') {
            const comp = _ensureComp(op.componentId);
            comp.delete(op.key);
            _notifySubs(op.componentId, op.key, undefined);
          } else if (op.type === 'metaPublish') {
            metaContext.set(op.topic, op.new);
            _notifyMetaSubs(op.topic, op.new);
          }
        } catch (e) { log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer+1, txHistory.length-1);
      redone++;
    }
    return { redone };
  }

  // hooks per-key
  function addHook(componentId, key, phase, cb) {
    if (!componentId || !key || !phase || typeof cb !== 'function') throw createError('invalid args','INVALID_ARGS');
    if (!keyHooks.has(componentId)) keyHooks.set(componentId, new Map());
    const km = keyHooks.get(componentId);
    if (!km.has(key)) km.set(key, { before: [], after: [], error: [] });
    km.get(key)[phase].push(cb);
    return () => { km.get(key)[phase] = km.get(key)[phase].filter(fn => fn !== cb); };
  }

  async function _fireKeyHooks(componentId, key, phase, payload) {
    try { for (const g of globalHooks[phase] || []) try { await Promise.resolve(g({ componentId, key, payload })); } catch (e) { log('global hook error', e); } } catch(_) {}
    const km = keyHooks.get(componentId);
    if (!km) return;
    const bucket = km.get(key);
    if (!bucket || !bucket[phase]) return;
    for (const cb of bucket[phase].slice()) {
      try { await Promise.resolve(cb(payload)); } catch (e) { log('key hook err', e); }
    }
  }

  // subscriptions
  function subscribe(componentId, key, cb) { const sk = _subKey(componentId, key); if (!subscribers.has(sk)) subscribers.set(sk, new Set()); subscribers.get(sk).add(cb); return () => subscribers.get(sk).delete(cb); }
  function _notifySubs(componentId, key, value, meta) { const s = subscribers.get(_subKey(componentId,key)); if (!s) return; for (const cb of Array.from(s)) try { cb(value, meta); } catch (e) { log('sub error', e); } // update any DOM bindings for this key
    if (typeof document !== 'undefined') {
      // update bound elements synchronously
      for (const [el, info] of Array.from(domBindings.entries ? domBindings.entries() : []) ) {
        try {
          if (info.componentId === componentId && info.key === key) {
            if (info.syncInput && ('value' in el)) el.value = value == null ? '' : value;
            else el.textContent = value == null ? '' : String(value);
          }
        } catch(_) {}
      }
    }
  }

  // meta-context / synergy
  function publishMeta(topic, payload) {
    const prev = metaContext.has(topic) ? metaContext.get(topic) : undefined;
    metaContext.set(topic, payload);
    _recordTx({ type: 'metaPublish', topic, prev, new: payload });
    _notifyMetaSubs(topic, payload);
  }
  function onMeta(topic, cb) { if (!metaSubs.has(topic)) metaSubs.set(topic, new Set()); metaSubs.get(topic).add(cb); return () => metaSubs.get(topic).delete(cb); }
  function _notifyMetaSubs(topic, payload) { const s = metaSubs.get(topic); if (!s) return; for (const cb of Array.from(s)) try { cb(payload); } catch (e) { log('meta sub error', e); } }

  function registerDependency(targetComponentId, targetKey, sources = [], resolver) {
    const tkey = _subKey(targetComponentId, targetKey);
    dependencies.set(tkey, { sources: sources.slice(), resolver: typeof resolver === 'function' ? resolver : null });
    // subscribe to sources
    for (const s of sources) {
      subscribe(s.componentId, s.key, async () => {
        try {
          const dep = dependencies.get(tkey);
          if (!dep) return;
          const ctx = {};
          for (const src of dep.sources) ctx[`${src.componentId}:${src.key}`] = get(src.componentId, src.key);
          if (dep.resolver) {
            const newVal = await Promise.resolve(dep.resolver(ctx));
            await set(targetComponentId, targetKey, newVal);
          }
        } catch (e) { log('dependency resolver error', e); }
      });
    }
  }

  // storage helpers
  function setStorageMode(mode = 'session') { storageMode = mode; if (typeof window === 'undefined') storage = null; else if (mode === 'local') storage = window.localStorage; else if (mode === 'session') storage = window.sessionStorage; else storage = null; log('storageMode', storageMode); }
  function _persist(componentId, key, val, opts = {}) { if (!storage) return; try { const fullKey = PREFIX + componentId + ':' + key; const payload = opts.compress ? btoa(JSON.stringify(val)) : JSON.stringify(val); storage.setItem(fullKey, payload); } catch(e){ log('persist err', e); } }
  function _restore(componentId, key) { if (!storage) return undefined; try { const fullKey = PREFIX + componentId + ':' + key; const raw = storage.getItem(fullKey); if (!raw) return undefined; try { return JSON.parse(raw); } catch (e) { try { return JSON.parse(atob(raw)); } catch(_) { return undefined; } } } catch(e){ return undefined; } }

  // set (records tx, fires hooks, updates subs, persists)
  async function set(componentId, key, value, opts = {}) {
    const t0 = now();
    if (!componentId || !key) throw createError('componentId and key required','INVALID_ARGS');
    const comp = _ensureComp(componentId);
    const prevEntry = comp.has(key) ? comp.get(key) : undefined;
    const prev = prevEntry ? { value: prevEntry.value, meta: prevEntry.meta } : undefined;
    _recordTx({ type: 'set', componentId, key, prev, new: { value, meta: opts.meta || null } });
    try {
      await _fireKeyHooks(componentId, key, 'before', { componentId, key, prev, value, opts });
      for (const g of globalHooks.beforeSet) try { await Promise.resolve(g({ componentId, key, prev, value, opts })); } catch (e) { log('global beforeSet err', e); }
      if (opts.validator && typeof opts.validator === 'function') { const ok = await Promise.resolve(opts.validator(value)); if (!ok) throw createError('validator rejected value','VALIDATOR_REJECT'); }
      comp.set(key, { value, meta: { persisted: !!opts.persist, expires: opts.expires ? Date.now() + opts.expires : undefined } });
      if (opts.persist) _persist(componentId, key, value, opts);
      _notifySubs(componentId, key, value, comp.get(key).meta);
      await _fireKeyHooks(componentId, key, 'after', { componentId, key, prev, value, opts });
      for (const g of globalHooks.afterSet) try { await Promise.resolve(g({ componentId, key, prev, value, opts })); } catch (e) { log('global afterSet err', e); }
      const dur = now() - t0;
      const m = _ensureMetrics(componentId, key); m.setCount++; m.avgTime = (m.avgTime * (m.setCount - 1) + dur) / m.setCount;
      _histPush({ op: 'set', componentId, key, value, time: Date.now(), error: null, performance: { duration: dur } });
      // trigger dependencies (handled via registerDependency subscriptions too)
      return { ok: true };
    } catch (e) {
      const dur = now() - t0;
      _ensureMetrics(componentId, key).errors++;
      await _fireKeyHooks(componentId, key, 'error', { componentId, key, error: e });
      for (const g of globalHooks.error) try { await Promise.resolve(g({ componentId, key, error: e })); } catch (ee) { log('global error hook failed', ee); }
      _histPush({ op: 'set', componentId, key, value, time: Date.now(), error: e, performance: { duration: dur } });
      throw e;
    }
  }

  // get (restore persisted if needed)
  function get(componentId, key, { restore = true } = {}) {
    if (!componentId || !key) throw createError('componentId and key required','INVALID_ARGS');
    const comp = _ensureComp(componentId);
    if (comp.has(key)) {
      const ent = comp.get(key);
      if (ent.meta && ent.meta.expires && Date.now() > ent.meta.expires) {
        comp.delete(key);
        _histPush({ op: 'expire', componentId, key, time: Date.now(), error: createError('expired','EXPIRED') });
        _notifySubs(componentId, key, undefined);
        return undefined;
      }
      _histPush({ op: 'get', componentId, key, value: ent.value, time: Date.now(), error: null, performance: { duration: 0 } });
      return ent.value;
    }
    if (restore && storage) {
      const restored = _restore(componentId, key);
      if (restored !== undefined) {
        comp.set(key, { value: restored, meta: { persisted: true } });
        _histPush({ op: 'get', componentId, key, value: restored, time: Date.now(), error: null, performance: { duration: 0 } });
        _notifySubs(componentId, key, restored);
        return restored;
      }
    }
    return undefined;
  }

  // batch set with concurrency
  async function batchSet(componentId, updates = [], { concurrency = 4, stopOnError = false } = {}) {
    if (!Array.isArray(updates)) throw createError('updates must be array','INVALID_ARG');
    const results = {};
    let i = 0;
    const runners = new Array(Math.min(concurrency, updates.length)).fill(0).map(async () => {
      while (i < updates.length) {
        const idx = i++;
        const { key, value, opts } = updates[idx];
        try { results[key] = await set(componentId, key, value, opts); } catch (e) { results[key] = { error: e }; if (stopOnError) throw e; }
      }
    });
    await Promise.all(runners);
    return results;
  }

  function batchGet(componentId, keys = []) { if (!Array.isArray(keys)) throw createError('keys must be array','INVALID_ARG'); const out = {}; for (const k of keys) out[k] = get(componentId, k); return out; }

  // remove
  function remove(componentId, key) {
    const comp = _ensureComp(componentId);
    const prev = comp.has(key) ? comp.get(key) : undefined;
    _recordTx({ type: 'remove', componentId, key, prev });
    comp.delete(key);
    try { if (storage) storage.removeItem(PREFIX + componentId + ':' + key); } catch(_) {}
    _histPush({ op: 'remove', componentId, key, time: Date.now(), error: null });
    _notifySubs(componentId, key, undefined);
    return { ok: true };
  }

  // DOM binding: find elements with data-state="component:key" and bind them
  function bindElement(el, { componentId, key, attr = 'text', syncInput = true } = {}) {
    if (!(el instanceof Element)) throw createError('element required','INVALID_ARG');
    domBindings.set(el, { componentId, key, attr, syncInput });
    // initialize from state
    const val = get(componentId, key);
    try {
      if (syncInput && ('value' in el)) el.value = val == null ? '' : val;
      else el.textContent = val == null ? '' : String(val);
    } catch(_) {}
    // if input-like, listen for changes to reflect into state
    if (syncInput && ('value' in el)) {
      const handler = (ev) => {
        const newVal = el.value;
        set(componentId, key, newVal).catch(e => log('dom->state set error', e));
      };
      el.addEventListener('input', handler);
      _recordTx({ type: 'domBind', element: el, handler });
      return () => { el.removeEventListener('input', handler); domBindings.delete(el); };
    }
    return () => { domBindings.delete(el); };
  }

  // auto-bind all elements with data-state on DOMContentLoaded
  function _autoBind(root = document) {
    if (typeof document === 'undefined') return;
    try {
      const nodes = root.querySelectorAll('[data-state]');
      for (const n of Array.from(nodes)) {
        const attr = n.getAttribute('data-state') || '';
        const [componentId, key] = attr.split(':').map(s => s && s.trim());
        if (componentId && key) bindElement(n, { componentId, key, attr: 'text', syncInput: n.matches('input,textarea,[contenteditable]') });
      }
    } catch (e) { log('autoBind err', e); }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => _autoBind(document));

  // meta/context helpers
  function getMeta(topic) { return metaContext.get(topic); }
  function listDependencies() { return Object.fromEntries(Array.from(dependencies.entries())); }

  // history access
  function getHistory(filter = {}) {
    let res = history.slice();
    if (filter.componentId) res = res.filter(h => h.componentId === filter.componentId);
    if (filter.key) res = res.filter(h => h.key === filter.key);
    if (filter.op) res = res.filter(h => h.op === filter.op);
    if (filter.maxAge) res = res.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(h => !!h.error);
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { history.length = 0; }
  function getRegistry() { const out = {}; for (const [cid,map] of states.entries()) out[cid] = Object.fromEntries(map.entries()); return out; }
  function getMetrics() { return Object.fromEntries(metrics.entries()); }

  // debug toggle
  function setDebug(v = true) { debug = !!v; log('debug', debug); }

  // attach external API conveniences
  function attachStateAPI(api) { if (!api) return () => {}; // expects { set, get, subscribe, batchSet } optional
    if (api.set) StateEngine.set = api.set; if (api.get) StateEngine.get = api.get; if (api.subscribe) StateEngine.subscribe = api.subscribe; return () => { /* noop - cannot detach replaced fns */ }; }

  // public API
  const StateEngine = {
    set, get, batchSet, batchGet, remove,
    subscribe, addHook, addGlobalHook: (phase, cb) => { if (!globalHooks[phase]) throw createError('invalid phase','INVALID_PHASE'); globalHooks[phase].push(cb); return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); }; },
    beginTransaction, commitTransaction, rollbackTransaction, undo, redo,
    getRegistry, getHistory, clearHistory, setHistoryCap, getMetrics,
    setDebug, setStorageMode, attachStateAPI,
    // meta/synergy
    publishMeta, onMeta, getMeta, registerDependency, listDependencies,
    // DOM
    bindElement, _autoBind,
    // internals for inspection
    _internal: { states, subscribers, keyHooks, metaContext, dependencies, txHistory }
  };

  return StateEngine;
})();

export default StateEngine;
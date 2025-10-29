// EventEngine - enhanced: transactions/undo-redo, HookEngine integration, per-listener metrics, serialization, DOM integration
const EventEngine = (() => {
  const listeners = new Map(); // eventType -> [{ id, cb, once, priority, meta }]
  const wildcardListeners = []; // [{ id, patternRe, cb, once, priority, meta }]
  const archetypes = new Map(); // name -> { listeners, active, meta }
  const globalHooks = { before: [], after: [], error: [] };
  const eventHistory = []; // structured history entries
  const metrics = new Map(); // eventType -> { listenerId -> { count, avgTime, errors } }
  const transactions = []; // active tx stack
  const txHistory = []; // committed txs
  let txPointer = -1;
  let historyCap = 500;
  let debug = false;

  // adapters
  let stateAPI = null; // { set, get, subscribe, batchSet }
  let hookAPI = null;  // HookEngine instance: { trigger }
  let layoutAPI = null; // optional
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // utils
  let idCounter = 1;
  const genId = () => `l-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
  const log = (...a) => { if (debug) try { console.log('[EventEngine]', ...a); } catch(_) {} };

  function createError(message, code, details) { const e = new Error(message); e.code = code; e.details = details; return e; }

  function _pushHistory(entry) { eventHistory.push(entry); while (eventHistory.length > historyCap) eventHistory.shift(); }
  function setHistoryCap(cap) { if (typeof cap !== 'number' || cap < 0) throw createError('invalid cap','INVALID_HISTORY_CAP'); historyCap = cap; while (eventHistory.length > historyCap) eventHistory.shift(); }

  // transactions
  function beginTransaction(label) {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label||'', ops: [], startedAt: Date.now() };
    transactions.push(tx);
    log('tx begin', tx.id);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TX');
    const tx = transactions.pop();
    tx.committedAt = Date.now();
    txHistory.splice(txPointer + 1);
    txHistory.push(tx);
    txPointer = txHistory.length - 1;
    log('tx commit', tx.id);
    return tx.id;
  }
  function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TX');
    const tx = transactions.pop();
    // reverse ops best-effort
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'on') off(op.eventType, op.cbId);
        else if (op.type === 'off') (op.entry && on(op.eventType, op.entry.cb, { once: op.entry.once, priority: op.entry.priority, meta: op.entry.meta }));
        else if (op.type === 'registerArchetype') archetypes.delete(op.name);
        else if (op.type === 'unregisterArchetype') archetypes.set(op.name, op.prev);
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
      rollbackTransaction();
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
          if (op.type === 'on') on(op.eventType, op.cb, { once: op.once, priority: op.priority, meta: op.meta });
          else if (op.type === 'off') off(op.eventType, op.cbId);
          else if (op.type === 'registerArchetype') archetypes.set(op.name, op.payload);
        } catch (e) { log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer + 1, txHistory.length - 1);
      redone++;
    }
    return { redone };
  }

  // metrics helpers
  function _ensureMetrics(eventType) { if (!metrics.has(eventType)) metrics.set(eventType, new Map()); return metrics.get(eventType); }
  function _recordListenerMetric(eventType, listenerId, duration, isError = false) {
    const m = _ensureMetrics(eventType);
    if (!m.has(listenerId)) m.set(listenerId, { count: 0, avgTime: 0, errors: 0 });
    const entry = m.get(listenerId);
    entry.count++;
    entry.avgTime = (entry.avgTime * (entry.count - 1) + duration) / entry.count;
    if (isError) entry.errors++;
  }

  // registration
  function on(eventType, cb, { once = false, priority = 0, meta = {} } = {}) {
    if (!eventType || typeof cb !== 'function') throw createError('invalid args', 'INVALID_ARGS');
    const id = genId();
    if (eventType.includes('*') || eventType.includes('?')) {
      const re = new RegExp('^' + eventType.split('*').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
      wildcardListeners.push({ id, patternRe: re, cb, once, priority, meta });
      wildcardListeners.sort((a,b)=> (b.priority||0) - (a.priority||0));
    } else {
      if (!listeners.has(eventType)) listeners.set(eventType, []);
      listeners.get(eventType).push({ id, cb, once, priority, meta });
      listeners.get(eventType).sort((a,b)=> (b.priority||0) - (a.priority||0));
    }
    // record tx
    if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'on', eventType, cbId: id, cb, once, priority, meta });
    return id;
  }

  function off(eventType, cbOrId) {
    if (!eventType) return;
    const removeById = (arr, id) => {
      const idx = arr.findIndex(x => x.id === id);
      if (idx >= 0) {
        const removed = arr.splice(idx,1)[0];
        return removed;
      }
      return null;
    };
    if (eventType.includes('*') || eventType.includes('?')) {
      // remove wildcard by id or cb ref
      for (let i = wildcardListeners.length - 1; i >= 0; i--) {
        const item = wildcardListeners[i];
        if (typeof cbOrId === 'string' ? item.id === cbOrId : item.cb === cbOrId) {
          const removed = wildcardListeners.splice(i,1)[0];
          if (transactions.length) transactions[transactions.length - 1].ops.push({ type:'off', eventType, cbId: removed.id, entry: removed });
        }
      }
      return;
    }
    if (!listeners.has(eventType)) return;
    if (!cbOrId) { const removedAll = listeners.get(eventType).slice(); listeners.delete(eventType); if (transactions.length) transactions[transactions.length - 1].ops.push({ type:'off', eventType, removed: removedAll }); return; }
    // by id
    const arr = listeners.get(eventType);
    const removed = removeById(arr, cbOrId);
    if (removed && transactions.length) transactions[transactions.length - 1].ops.push({ type:'off', eventType, cbId: removed.id, entry: removed });
    if (arr.length === 0) listeners.delete(eventType);
  }

  function once(eventType, cb, opts = {}) { return on(eventType, cb, Object.assign({}, opts, { once: true })); }

  // global hooks
  function addGlobalHook(phase, cb) {
    if (!globalHooks[phase]) throw createError('invalid phase', 'INVALID_PHASE');
    globalHooks[phase].push(cb);
    return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); };
  }

  // DOM delegate convenience
  const domDelegates = new Set();
  function addDOMDelegate(selector, eventName, handler, { capture = false } = {}) {
    if (typeof document === 'undefined') throw createError('no DOM','NO_DOM');
    const h = (ev) => { if (ev.target && ev.target.matches && ev.target.matches(selector)) handler(ev); };
    document.addEventListener(eventName, h, capture);
    domDelegates.add({ selector, eventName, handler: h, capture });
    if (transactions.length) transactions[transactions.length - 1].ops.push({ type:'domDelegate', selector, eventName, handler:h, capture });
    return () => { document.removeEventListener(eventName, h, capture); domDelegates.delete({ selector, eventName, handler:h, capture }); };
  }

  // emit sync
  function emit(eventType, payload = {}) {
    if (!eventType || typeof eventType !== 'string') throw createError('eventType required','INVALID_EVENT');
    const start = now();
    const entry = { eventType, payload, time: Date.now(), results: [], error: null, performance: null };
    // call hookAPI.before if attached
    if (hookAPI && typeof hookAPI.trigger === 'function') {
      try { hookAPI.trigger(`event:before:${eventType}`, { eventType, payload }); } catch (e) { log('hookAPI before error', e); }
    }
    for (const g of globalHooks.before) try { g({ eventType, payload }); } catch (e) { log('global before hook err', e); }
    const matched = [];
    if (listeners.has(eventType)) matched.push(...listeners.get(eventType));
    for (const w of wildcardListeners) if (w.patternRe.test(eventType)) matched.push(w);
    matched.sort((a,b)=>(b.priority||0)-(a.priority||0));
    for (const ln of matched.slice()) {
      const t0 = now();
      try {
        const res = ln.cb(payload, { eventType });
        const dur = now() - t0;
        _recordListenerMetric(eventType, ln.id, dur, false);
        entry.results.push({ listenerId: ln.id, result: res, duration: dur });
        if (ln.once) off(eventType, ln.id);
      } catch (e) {
        const dur = now() - t0;
        _recordListenerMetric(eventType, ln.id, dur, true);
        entry.error = e;
        for (const g of globalHooks.error) try { g({ eventType, error: e }); } catch (_) {}
      }
    }
    for (const g of globalHooks.after) try { g({ eventType, payload, results: entry.results }); } catch (e) { log('global after hook err', e); }
    // call hookAPI.after if attached (async fire-and-forget)
    if (hookAPI && typeof hookAPI.trigger === 'function') {
      try { hookAPI.trigger(`event:after:${eventType}`, { eventType, payload, results: entry.results }); } catch (e) { log('hookAPI after error', e); }
    }
    entry.performance = { duration: now() - start };
    _pushHistory(entry);
    return entry.results.length > 0;
  }

  // emit async with options
  async function emitAsync(eventType, payload = {}, { parallel = true, timeout = 0 } = {}) {
    if (!eventType || typeof eventType !== 'string') throw createError('eventType required','INVALID_EVENT');
    const start = now();
    const entry = { eventType, payload, time: Date.now(), results: [], error: null, performance: null };
    for (const g of globalHooks.before) try { await Promise.resolve(g({ eventType, payload })); } catch (e) { log('global before hook err', e); }
    if (stateAPI && payload && payload._stateSet) {
      try { if (stateAPI.batchSet) await Promise.resolve(stateAPI.batchSet(payload._stateSet)); else Object.entries(payload._stateSet).forEach(([k,v])=>stateAPI.set(k,v)); } catch(e){ log('stateAPI set err', e); }
    }
    const matched = [];
    if (listeners.has(eventType)) matched.push(...listeners.get(eventType));
    for (const w of wildcardListeners) if (w.patternRe.test(eventType)) matched.push(w);
    matched.sort((a,b)=>(b.priority||0)-(a.priority||0));
    const tasks = matched.map(ln => async () => {
      const t0 = now();
      try {
        const r = await Promise.resolve(ln.cb(payload, { eventType }));
        const dur = now() - t0;
        _recordListenerMetric(eventType, ln.id, dur, false);
        if (ln.once) off(eventType, ln.id);
        return { ok: true, listenerId: ln.id, result: r, duration: dur };
      } catch (e) {
        const dur = now() - t0;
        _recordListenerMetric(eventType, ln.id, dur, true);
        for (const g of globalHooks.error) try { await Promise.resolve(g({ eventType, error: e })); } catch(_) {}
        return { ok: false, listenerId: ln.id, error: e, duration: dur };
      }
    });
    let results = [];
    if (parallel) {
      const p = Promise.all(tasks.map(t => t()));
      try { results = timeout && timeout>0 ? await Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(createError('timeout','TIMEOUT')), timeout))]) : await p; } catch (e) { entry.error = e; results = []; }
    } else {
      for (const t of tasks) {
        try { const r = timeout && timeout>0 ? await Promise.race([t(), new Promise((_,rej)=>setTimeout(()=>rej(createError('timeout','TIMEOUT')), timeout))]) : await t(); results.push(r); } catch (e) { entry.error = e; results.push({ ok:false, error: e }); }
      }
    }
    for (const g of globalHooks.after) try { await Promise.resolve(g({ eventType, payload, results })); } catch (e) { log('global after hook err', e); }
    entry.results = results;
    entry.performance = { duration: now() - start };
    _pushHistory(entry);
    // hookAPI.after
    if (hookAPI && typeof hookAPI.trigger === 'function') {
      try { hookAPI.trigger(`event:after:${eventType}`, { eventType, payload, results }); } catch (e) { log('hookAPI after error', e); }
    }
    return { results, duration: entry.performance.duration, error: entry.error || null };
  }

  // archetype helpers
  function registerArchetype(name, { listeners: archeListeners = [], validators = {}, meta = {} } = {}) {
    if (!name) throw createError('name required','INVALID_NAME');
    archetypes.set(name, { listeners: archeListeners.slice(), active: true, validators, meta });
    // attach archetype listeners
    const registered = [];
    for (const ln of archeListeners) {
      const id = on(ln.event, ln.cb, { priority: ln.priority || 0, meta: Object.assign({}, ln.meta || {}, { archetype: name }) });
      registered.push({ event: ln.event, id });
    }
    if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'registerArchetype', name, payload: { listeners: registered, validators, meta } });
    return () => unregisterArchetype(name);
  }
  function unregisterArchetype(name) {
    const arch = archetypes.get(name);
    if (!arch) return;
    // remove listeners registered with archetype meta
    for (const [ev, arr] of listeners.entries()) {
      listeners.set(ev, arr.filter(l => !(l.meta && l.meta.archetype === name)));
      if (!listeners.get(ev).length) listeners.delete(ev);
    }
    for (let i = wildcardListeners.length - 1; i >= 0; i--) if (wildcardListeners[i].meta && wildcardListeners[i].meta.archetype === name) wildcardListeners.splice(i,1);
    archetypes.delete(name);
  }
  function setArchetypeActive(name, state = true) { if (archetypes.has(name)) archetypes.get(name).active = !!state; }

  // adapters
  function attachStateAPI(api) { stateAPI = api; return () => { stateAPI = null; }; }
  function attachHookAPI(api) { hookAPI = api; return () => { hookAPI = null; }; }
  function attachLayoutAPI(api) { layoutAPI = api; return () => { layoutAPI = null; }; }

  // serialization: only metadata (callbacks can't be serialized)
  function serializeListeners() {
    const out = [];
    for (const [ev, arr] of listeners.entries()) {
      for (const l of arr) out.push({ event: ev, id: l.id, once: l.once, priority: l.priority, meta: l.meta, hasCallback: typeof l.cb === 'function' });
    }
    for (const w of wildcardListeners) out.push({ event: w.patternRe.source, id: w.id, once: w.once, priority: w.priority, meta: w.meta, wildcard: true, hasCallback: typeof w.cb === 'function' });
    return JSON.stringify({ listeners: out, archetypes: Array.from(archetypes.keys()) });
  }
  function deserializeListeners(serialized, callbackResolver = null) {
    try {
      const parsed = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
      for (const item of parsed.listeners || []) {
        if (callbackResolver && typeof callbackResolver === 'function') {
          const cb = callbackResolver(item);
          if (cb) on(item.event, cb, { once: item.once, priority: item.priority, meta: item.meta });
        }
      }
      return true;
    } catch (e) { log('deserialize err', e); return false; }
  }

  // history access and metrics
  function getHistory(filter = {}) {
    let res = eventHistory.slice();
    if (filter.eventType) res = res.filter(h => h.eventType === filter.eventType);
    if (filter.maxAge) res = res.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(h => !!h.error);
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { eventHistory.length = 0; }
  function getMetrics(eventType) {
    if (eventType) {
      const map = metrics.get(eventType) || new Map();
      return Object.fromEntries(Array.from(map.entries()).map(([id,m])=>[id, Object.assign({}, m)]));
    }
    const out = {};
    for (const [ev, map] of metrics.entries()) out[ev] = Object.fromEntries(Array.from(map.entries()).map(([id,m])=>[id,Object.assign({},m)]));
    return out;
  }

  function listListeners(ev) { return ev ? (listeners.get(ev) || []).map(l => ({ id: l.id, priority: l.priority, meta: l.meta })) : { events: Array.from(listeners.keys()), wildcards: wildcardListeners.length }; }

  // debug
  function setDebug(v = true) { debug = !!v; }

  return {
    on, off, once, emit, emitAsync,
    addGlobalHook, registerArchetype, unregisterArchetype, setArchetypeActive,
    attachStateAPI, attachHookAPI, attachLayoutAPI,
    beginTransaction, commitTransaction, rollbackTransaction, undo, redo, txHistory,
    serializeListeners, deserializeListeners,
    addDOMDelegate: addDOMDelegate, // alias for convenience
    getHistory, clearHistory, setHistoryCap, getMetrics, listListeners, setDebug,
    _internal: { listeners, wildcardListeners, archetypes, metrics, txHistory }
  };
})();

export default EventEngine;
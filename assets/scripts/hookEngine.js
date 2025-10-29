// HookEngine - enhanced with state/DOM, archetype/narrative, layout/rendering, transactions/undo-redo, synergy/meta-context
const HookEngine = (() => {
  const hooks = new Map(); // hookName -> [entry]
  const globalHooks = { before: [], after: [], error: [] };
  const hookHistory = []; // structured history
  const metrics = new Map(); // hookName -> { executionCount, averageTime, errorCount }
  const transactions = []; // active tx stack
  const txHistory = []; // committed txs
  let txPointer = -1;
  let historyCap = 500;
  let logLevel = 'info'; // debug|info|error|silent
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // adapters (opt-in)
  let stateAPI = null;      // { set/get/subscribe/batchSet }
  let domAPI = null;        // DOM adapter not required (uses document) but can be attached
  let narrativeAPI = null;  // { on(event, cb), track? }
  let layoutAPI = null;     // { build(container,type,items,ctx) }
  let symbolAPI = null;     // optional SymbolEngine adapter

  // synergy / meta-context
  const metaContext = new Map();
  const metaSubs = new Map();

  // logging
  function logger(level, ...args) {
    const order = { debug: 0, info: 1, error: 2, silent: 3 };
    if (order[level] === undefined) level = 'info';
    if (order[logLevel] <= order[level]) {
      const fn = level === 'error' ? console.error : console.log;
      try { fn('[HookEngine]', ...args); } catch (_) {}
    }
  }
  const debug = (...a) => logger('debug', ...a);
  const info = (...a) => logger('info', ...a);
  const error = (...a) => logger('error', ...a);

  function createError(message, code, details) { const e = new Error(message); e.code = code; e.details = details; return e; }

  // helpers
  function ensureMetrics(name) {
    if (!metrics.has(name)) metrics.set(name, { executionCount: 0, averageTime: 0, errorCount: 0 });
    return metrics.get(name);
  }
  function pushHistory(entry) {
    hookHistory.push(entry);
    while (hookHistory.length > historyCap) hookHistory.shift();
  }
  function setHistoryCap(cap) {
    if (typeof cap !== 'number' || cap < 0) throw createError('invalid cap', 'INVALID_HISTORY_CAP');
    historyCap = cap;
    while (hookHistory.length > historyCap) hookHistory.shift();
  }

  // transaction helpers
  function recordTx(op) { if (!transactions.length) return; transactions[transactions.length - 1].ops.push(op); }
  function beginTransaction(label) {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label || '', ops: [], createdAt: Date.now() };
    transactions.push(tx);
    info('tx:begin', tx.id, label);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TRANSACTION');
    const tx = transactions.pop();
    tx.committedAt = Date.now();
    txHistory.splice(txPointer + 1);
    txHistory.push(tx);
    txPointer = txHistory.length - 1;
    info('tx:commit', tx.id);
    return tx.id;
  }
  async function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TRANSACTION');
    const tx = transactions.pop();
    // reverse ops best-effort
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'register') {
          hooks.delete(op.hookName);
        } else if (op.type === 'deregister') {
          if (!hooks.has(op.hookName)) hooks.set(op.hookName, []);
          hooks.get(op.hookName).push(...(op.removed || []));
        } else if (op.type === 'addGlobalHook') {
          globalHooks[op.phase] = globalHooks[op.phase].filter(c => c !== op.cb);
        } else if (op.type === 'removeGlobalHook') {
          globalHooks[op.phase].push(op.cb);
        } else if (op.type === 'domDelegate') {
          if (op.remove && typeof document !== 'undefined') document.removeEventListener(op.eventName, op.handler);
        } else if (op.type === 'stateSubscribe') {
          if (stateAPI && stateAPI.unsubscribe && op.unsubscribe) op.unsubscribe();
        } else if (op.type === 'metaPublish') {
          metaContext.delete(op.topic);
        }
      } catch (e) { debug('rollback op failed', e); }
    }
    info('tx:rollback', tx.id);
    return tx.id;
  }
  async function undo(steps = 1) {
    let undone = 0;
    while (undone < steps && txPointer >= 0) {
      const tx = txHistory[txPointer];
      const fake = { ops: tx.ops.slice() };
      transactions.push(fake);
      await rollbackTransaction();
      txPointer--;
      undone++;
    }
    return { undone };
  }
  async function redo(steps = 1) {
    let redone = 0;
    while (redone < steps && txPointer < txHistory.length - 1) {
      const idx = txPointer + 1;
      const tx = txHistory[idx];
      for (const op of tx.ops) {
        try {
          if (op.type === 'register') {
            if (!hooks.has(op.hookName)) hooks.set(op.hookName, []);
            hooks.get(op.hookName).push(...(op.entry ? [op.entry] : []));
          } else if (op.type === 'deregister') {
            hooks.delete(op.hookName);
          } else if (op.type === 'addGlobalHook') {
            globalHooks[op.phase].push(op.cb);
          } else if (op.type === 'removeGlobalHook') {
            globalHooks[op.phase] = globalHooks[op.phase].filter(c => c !== op.cb);
          }
        } catch (e) { debug('redo op failed', e); }
      }
      txPointer = Math.min(txPointer + 1, txHistory.length - 1);
      redone++;
    }
    return { redone };
  }

  // register/deregister
  function register(hookName, callback, { priority = 0, meta = {} } = {}) {
    if (!hookName || typeof callback !== 'function') throw createError('invalid args', 'INVALID_ARGS');
    const entry = { callback, priority: Number(priority) || 0, meta: Object.assign({}, meta), lastCalled: 0, callCount: 0, version: meta.version || 1 };
    if (!hooks.has(hookName)) hooks.set(hookName, []);
    hooks.get(hookName).push(entry);
    hooks.get(hookName).sort((a, b) => b.priority - a.priority);
    debug('registered', hookName);
    recordTx({ type: 'register', hookName, entry });
    return () => deregister(hookName, callback);
  }
  function deregister(hookName, callback) {
    if (!hooks.has(hookName)) return;
    const removed = hooks.get(hookName).filter(e => !callback || e.callback === callback);
    if (!callback) hooks.delete(hookName); else hooks.set(hookName, hooks.get(hookName).filter(e => e.callback !== callback));
    recordTx({ type: 'deregister', hookName, removed });
    debug('deregistered', hookName);
  }
  function batchDeregister(filterFn) {
    for (const [name, entries] of Array.from(hooks.entries())) {
      const keep = entries.filter(e => !filterFn(e.meta, name));
      const removed = entries.filter(e => !keep.includes(e));
      if (keep.length) hooks.set(name, keep); else hooks.delete(name);
      if (removed.length) recordTx({ type: 'deregister', hookName: name, removed });
    }
    info('batchDeregister completed');
  }

  // global hook management
  function addGlobalHook(phase, cb) {
    if (!globalHooks[phase]) throw createError('invalid phase', 'INVALID_PHASE');
    globalHooks[phase].push(cb);
    recordTx({ type: 'addGlobalHook', phase, cb });
    return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); recordTx({ type: 'removeGlobalHook', phase, cb }); };
  }

  // execute with timeout
  async function executeWithTimeout(fnOrPromise, timeout) {
    if (!timeout || timeout <= 0) return typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise;
    const p = typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise;
    return Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(createError('timeout','TIMEOUT',{timeout})), timeout))]);
  }

  // condition check for hook
  async function checkCondition(entry, payload) {
    if (typeof entry.meta.condition !== 'function') return true;
    try { return !!(await entry.meta.condition(payload)); } catch (e) { debug('condition err', e); return false; }
  }

  // cleanup expired hooks
  function cleanupExpired() {
    const nowTs = Date.now();
    for (const [name, arr] of Array.from(hooks.entries())) {
      const keep = arr.filter(e => !e.meta.expires || e.meta.expires > nowTs);
      if (keep.length) hooks.set(name, keep); else hooks.delete(name);
    }
    debug('cleanupExpired');
  }

  // trigger single hook
  async function trigger(hookName, payload = {}) {
    cleanupExpired();
    if (!hookName || typeof hookName !== 'string') throw createError('invalid hookName', 'INVALID_HOOK_NAME');
    const entries = hooks.get(hookName) || [];
    const results = [];
    for (const g of globalHooks.before) try { await Promise.resolve(g({ hookName, payload })); } catch (e) { error('global before error', e); }
    for (const entry of entries) {
      const t0 = now();
      try {
        // rate limit
        if (entry.meta.rateLimit) {
          const minInterval = 60000 / entry.meta.rateLimit;
          if (entry.lastCalled && Date.now() - entry.lastCalled < minInterval) throw createError('rate limit', 'RATE_LIMIT', { rateLimit: entry.meta.rateLimit });
          entry.lastCalled = Date.now();
        }
        if (!(await checkCondition(entry, payload))) continue;
        const res = await executeWithTimeout(() => entry.callback(payload), entry.meta.timeout);
        const dur = now() - t0;
        entry.callCount = (entry.callCount || 0) + 1;
        const m = ensureMetrics(hookName);
        m.executionCount++;
        m.averageTime = (m.averageTime * (m.executionCount - 1) + dur) / m.executionCount;
        results.push(res);
        pushHistory({ hookName, meta: entry.meta, payload, result: res, time: Date.now(), error: null, performance: { duration: dur } });
      } catch (e) {
        const dur = now() - t0;
        const m = ensureMetrics(hookName);
        m.errorCount++;
        pushHistory({ hookName, meta: entry.meta, payload, result: null, time: Date.now(), error: e, performance: { duration: dur } });
        for (const gErr of globalHooks.error) try { await Promise.resolve(gErr({ hookName, error: e, payload })); } catch (ee) { error('global error hook failed', ee); }
        try { if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('hook:error', { bubbles: true, detail: { hookName, error: e, payload } })); } catch(_) {}
      }
    }
    for (const g of globalHooks.after) try { await Promise.resolve(g({ hookName, payload, results })); } catch (e) { error('global after error', e); }
    return results;
  }

  // batch trigger (parallel, concurrency control, batch timeout)
  async function batchTrigger(triggers = [], { concurrency = 4, batchTimeout = 0, stopOnError = false } = {}) {
    cleanupExpired();
    if (!Array.isArray(triggers)) throw createError('triggers must be array', 'INVALID_ARG');
    const results = {};
    let i = 0;
    const workers = new Array(Math.min(concurrency, triggers.length)).fill(0).map(async () => {
      while (i < triggers.length) {
        const idx = i++;
        const { hookName, payload } = triggers[idx];
        try {
          results[hookName] = await trigger(hookName, payload);
        } catch (e) {
          results[hookName] = { error: e };
          if (stopOnError) throw e;
        }
      }
    });
    const exec = Promise.all(workers);
    if (batchTimeout && batchTimeout > 0) {
      await Promise.race([exec, new Promise((_, rej) => setTimeout(() => rej(createError('batch timeout','BATCH_TIMEOUT',{batchTimeout})), batchTimeout))]).catch(e => error('batchTrigger timeout', e));
    } else {
      await exec;
    }
    info('batchTrigger completed', { count: triggers.length });
    return results;
  }

  // DOM integration: easy delegate + DOM-driven hooks
  const domDelegates = new Set();
  function addDOMDelegate(selector, eventName, hookName) {
    if (typeof document === 'undefined') throw createError('no DOM', 'NO_DOM');
    const handler = (ev) => {
      const tgt = ev.target;
      if (!tgt || !tgt.matches) return;
      if (tgt.matches(selector)) trigger(hookName, { event: ev, element: tgt }).catch(()=>{});
    };
    document.addEventListener(eventName, handler);
    domDelegates.add({ selector, eventName, hookName, handler });
    recordTx({ type: 'domDelegate', selector, eventName, hookName, handler });
    return () => {
      document.removeEventListener(eventName, handler);
      domDelegates.delete({ selector, eventName, hookName, handler });
    };
  }

  // State integration
  function attachStateAPI(api) {
    stateAPI = api;
    return () => { stateAPI = null; };
  }

  // Narrative / archetype awareness
  function attachNarrativeAPI(api) {
    narrativeAPI = api;
    if (narrativeAPI && typeof narrativeAPI.on === 'function') {
      // listen for narrative events and trigger hooks named narrative:<event>
      narrativeAPI.on('narrative:event', (payload) => {
        trigger(`narrative:${payload.event}`, payload).catch(()=>{});
      });
    }
    return () => { narrativeAPI = null; };
  }
  function addArchetypeHook(archetypeName, phase, cb) {
    // register hook under name archetype:<name>:<phase>
    const hookName = `archetype:${archetypeName}:${phase}`;
    return register(hookName, cb, { priority: 0, meta: { archetype: archetypeName, phase } });
  }

  // Layout/rendering integration
  function attachLayoutAPI(api) { layoutAPI = api; return () => { layoutAPI = null; }; }
  async function buildLayout(container, type, items, ctx) {
    if (!layoutAPI || typeof layoutAPI.build !== 'function') throw createError('layoutAPI not attached', 'NO_LAYOUT_API');
    return layoutAPI.build(container, type, items, ctx);
  }

  // Synergy/meta-context
  function publishMeta(topic, payload) {
    metaContext.set(topic, payload);
    const subs = metaSubs.get(topic) || [];
    for (const cb of subs.slice()) try { cb(payload); } catch (e) { debug('meta sub cb error', e); }
    recordTx({ type: 'metaPublish', topic, payload });
  }
  function onMeta(topic, cb) {
    if (!metaSubs.has(topic)) metaSubs.set(topic, []);
    metaSubs.get(topic).push(cb);
    recordTx({ type: 'metaSubscribe', topic });
    return () => { metaSubs.set(topic, metaSubs.get(topic).filter(x => x !== cb)); };
  }
  function readMeta(topic) { return metaContext.get(topic); }

  // stateful conveniences: persist hook registrations or versions into state store
  function persistHookMetadata(hookName, metaObj, opts = {}) {
    if (!stateAPI || typeof stateAPI.set !== 'function') return;
    try { stateAPI.set(`hook:${hookName}:meta`, metaObj, Object.assign({ persist: true }, opts)); } catch (e) { debug('persistHookMeta err', e); }
  }

  // expose small admin APIs
  function listHooks() { return Array.from(hooks.keys()); }
  function getHistory(filter = {}) {
    let res = hookHistory.slice();
    if (filter.hookName) res = res.filter(h => h.hookName === filter.hookName);
    if (filter.maxAge) res = res.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(h => !!h.error);
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { hookHistory.length = 0; info('history cleared'); }
  function getMetrics(hookName) { return hookName ? (metrics.get(hookName) || { executionCount: 0, averageTime: 0, errorCount: 0 }) : Object.fromEntries(metrics.entries()); }

  function setLogLevel(level) { if (['debug','info','error','silent'].includes(level)) { logLevel = level; info('loglevel', level); } }

  // auto-clean expired on each trigger/call
  function cleanupExpired() {
    const t = Date.now();
    for (const [name, arr] of Array.from(hooks.entries())) {
      const keep = arr.filter(e => !e.meta.expires || e.meta.expires > t);
      if (keep.length) hooks.set(name, keep); else hooks.delete(name);
    }
    debug('cleanupExpired');
  }

  return {
    register, deregister, batchDeregister,
    addGlobalHook, trigger, batchTrigger,
    addDOMDelegate, attachStateAPI, attachNarrativeAPI, attachLayoutAPI, attachSymbolAPI: (api)=>{ symbolAPI=api; return ()=>{symbolAPI=null} },
    publishMeta, onMeta, readMeta,
    beginTransaction, commitTransaction, rollbackTransaction, undo, redo, txHistory,
    listHooks, getHistory, clearHistory, setHistoryCap, getMetrics,
    setLogLevel, cleanupExpired
  };
})();

export default HookEngine;
const SymbolEngine = (() => {
  // core stores
  const patterns = new Map(); // pattern -> { logic, options, active, registered, meta }
  const patternHooks = new Map(); // pattern -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], after: [], error: [] };
  const history = []; // structured apply history
  const metrics = new Map(); // pattern -> { count, avgTime, errors, itemMetrics: Map(itemId->{last,avg,count}) }
  let debug = false;
  let historyCap = 500;

  // adapters (opt-in)
  let gestureAPI = null;   // { on(eventName, cb) }
  let layoutAPI = null;    // { build(container,type,items,ctx) }
  let memoryAPI = null;    // { store, recall, forget, addHook }
  let narrativeAPI = null; // { track, registerStoryboard, on }
  let hookAPI = null;      // HookEngine instance
  let stateAPI = null;     // StateEngine instance

  // meta-context / synergy
  const metaContext = new Map();
  const metaSubs = new Map();

  // transactions & undo/redo
  const transactions = [];
  const txHistory = [];
  let txPointer = -1;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const log = (...a) => { if (debug) try { console.log('[SymbolEngine]', ...a); } catch(_){}; };
  const createError = (m,c,d) => Object.assign(new Error(m), { code: c, details: d });

  // helpers
  function ensureMetrics(name) {
    if (!metrics.has(name)) metrics.set(name, { count:0, avgTime:0, errors:0, itemMetrics: new Map() });
    return metrics.get(name);
  }
  function pushHistory(entry) {
    history.push(entry);
    while (history.length > historyCap) history.shift();
  }
  function recordTx(op) { if (!transactions.length) return; transactions[transactions.length-1].ops.push(op); }

  // adapters attach
  function attachGestureAPI(api) { gestureAPI = api; // auto-subscribe if possible
    if (gestureAPI && typeof gestureAPI.on === 'function') gestureAPI.on('gesture:detected', ({ type, detail }) => {
      // run patterns that declare matchGesture:type or options.gesture = type
      for (const [pName, p] of patterns.entries()) {
        if (!p.active) continue;
        const opt = p.options || {};
        if (opt.gesture === type || (opt.gestures && opt.gestures.includes(type))) {
          apply({ event: 'gesture', gesture: type, detail, patternTriggered: pName }).catch(()=>{});
        }
      }
    });
    return () => { gestureAPI = null; };
  }
  function attachLayoutAPI(api) { layoutAPI = api; return () => { layoutAPI = null; }; }
  function attachMemoryAPI(api) { memoryAPI = api; return () => { memoryAPI = null; }; }
  function attachNarrativeAPI(api) { narrativeAPI = api; return () => { narrativeAPI = null; }; }
  function attachHookAPI(api) { hookAPI = api; return () => { hookAPI = null; }; }
  function attachStateAPI(api) { stateAPI = api; return () => { stateAPI = null; }; }

  // meta-context
  function publishMeta(topic, payload) {
    const prev = metaContext.has(topic) ? metaContext.get(topic) : undefined;
    metaContext.set(topic, payload);
    const subs = metaSubs.get(topic) || [];
    for (const cb of subs.slice()) try { cb(payload, prev); } catch(e){ log('meta cb err', e); }
    recordTx({ type: 'metaPublish', topic, prev, new: payload });
  }
  function onMeta(topic, cb) { if (!metaSubs.has(topic)) metaSubs.set(topic, []); metaSubs.get(topic).push(cb); return () => { metaSubs.set(topic, metaSubs.get(topic).filter(x=>x!==cb)); }; }
  function readMeta(topic) { return metaContext.get(topic); }

  // transactions
  function beginTransaction(label) {
    const tx = { id:`tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label||'', ops:[], createdAt: Date.now() };
    transactions.push(tx);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TRANSACTION');
    const tx = transactions.pop(); tx.committed = true;
    txHistory.splice(txPointer+1); txHistory.push(tx); txPointer = txHistory.length-1;
    return tx.id;
  }
  function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TRANSACTION');
    const tx = transactions.pop();
    // reverse ops best-effort
    for (let i = tx.ops.length-1; i>=0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'register') { patterns.delete(op.pattern); patternHooks.delete(op.pattern); }
        else if (op.type === 'unregister') patterns.set(op.pattern, op.prev);
        else if (op.type === 'metaPublish') { if (typeof op.prev === 'undefined') metaContext.delete(op.topic); else metaContext.set(op.topic, op.prev); }
      } catch(e){ log('rollback op failed', e); }
    }
    return tx.id;
  }
  async function undo(steps=1) {
    let undone=0;
    while (undone<steps && txPointer>=0) {
      const tx = txHistory[txPointer];
      transactions.push({ ops: tx.ops.slice() });
      rollbackTransaction();
      txPointer--;
      undone++;
    }
    return { undone };
  }
  async function redo(steps=1) {
    let redone=0;
    while (redone<steps && txPointer < txHistory.length-1) {
      const next = txHistory[txPointer+1];
      for (const op of next.ops) {
        try {
          if (op.type === 'register') patterns.set(op.pattern, op.new);
          else if (op.type === 'unregister') patterns.delete(op.pattern);
          else if (op.type === 'metaPublish') metaContext.set(op.topic, op.new);
        } catch(e){ log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer+1, txHistory.length-1);
      redone++;
    }
    return { redone };
  }

  // registration
  function register(pattern, logic, options = {}, meta = {}) {
    if (typeof pattern !== 'string' || !pattern) throw createError('pattern required','INVALID_PATTERN');
    if (typeof logic !== 'function') throw createError('logic must be function','INVALID_LOGIC');
    const opts = Object.assign({ priority:0, matcher:null, validator:null, active:true, tags:[], persist:false, expires:0, measurePerItem:false }, options);
    const entry = { logic, options: opts, active: opts.active !== false, registered: Date.now(), meta };
    patterns.set(pattern, entry);
    recordTx({ type: 'register', pattern, new: entry });
    log('registered pattern', pattern);
    // persist pattern metadata if memoryAPI attached and persist true
    if (memoryAPI && opts.persist) {
      try { memoryAPI.store(`pattern:${pattern}:meta`, { options: opts, meta }, { persist: true }); } catch(e){ log('memory persist err', e); }
    }
    return () => unregister(pattern);
  }
  function unregister(pattern) {
    if (!patterns.has(pattern)) return;
    const prev = patterns.get(pattern);
    patterns.delete(pattern);
    patternHooks.delete(pattern);
    recordTx({ type: 'unregister', pattern, prev });
    log('unregistered pattern', pattern);
  }
  function setPatternActive(pattern, state=true) {
    if (patterns.has(pattern)) {
      const prev = patterns.get(pattern).active;
      patterns.get(pattern).active = !!state;
      recordTx({ type: 'setActive', pattern, prev, new: !!state });
    }
  }

  // hooks
  function addHook(pattern, phase, cb) {
    if (!patternHooks.has(pattern)) patternHooks.set(pattern, { before:[], after:[], error:[] });
    patternHooks.get(pattern)[phase].push(cb);
    return () => { patternHooks.get(pattern)[phase] = patternHooks.get(pattern)[phase].filter(x=>x!==cb); };
  }
  function addGlobalHook(phase, cb) {
    if (!globalHooks[phase]) throw createError('invalid phase','INVALID_PHASE');
    globalHooks[phase].push(cb);
    return () => { globalHooks[phase] = globalHooks[phase].filter(x=>x!==cb); };
  }
  async function _fireHooks(pattern, phase, payload) {
    for (const g of globalHooks[phase] || []) try { await Promise.resolve(g({ pattern, payload })); } catch(e){ log('global hook err', e); }
    if (!patternHooks.has(pattern)) return;
    for (const cb of patternHooks.get(pattern)[phase] || []) try { await Promise.resolve(cb(payload)); } catch(e){ log('pattern hook err', e); }
  }

  // pattern matching util
  function matchPattern(pattern, value, customMatcher) {
    if (typeof customMatcher === 'function') {
      try { return !!customMatcher(pattern, value); } catch(e){ log('matcher err', e); return false; }
    }
    if (pattern.endsWith('*')) return String(value || '').startsWith(pattern.slice(0,-1));
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try { return new RegExp(pattern.slice(1,-1)).test(String(value)); } catch(e){ return false; }
    }
    return pattern === value;
  }

  // apply (single context)
  async function apply(context = {}) {
    const start = now();
    const val = context.symbol || context.type || context.intent || '';
    const out = {};
    // sort by priority desc
    const list = Array.from(patterns.entries()).filter(([,p]) => p.active)
      .sort(([,a],[,b]) => (b.options.priority || 0) - (a.options.priority || 0));
    for (const [pName, pEntry] of list) {
      const { logic, options, meta } = pEntry;
      try {
        // before hooks
        await _fireHooks(pName, 'before', { context });
        for (const g of globalHooks.before) try { await Promise.resolve(g({ pattern: pName, context })); } catch(_) {}
        // match check: either matcher or pattern name matching val
        const matched = options.matcher ? await Promise.resolve(options.matcher(val, context)) : matchPattern(pName, val, null);
        if (!matched) continue;
        // validate if provided
        if (options.validator && typeof options.validator === 'function') {
          const ok = await Promise.resolve(options.validator(context));
          if (!ok) continue;
        }
        const t0 = now();
        const res = await Promise.resolve(logic(context));
        const dur = now() - t0;
        ensureMetrics(pName);
        const m = ensureMetrics(pName);
        m.count++; m.avgTime = (m.avgTime * (m.count - 1) + dur) / m.count;
        out[pName] = res;
        // after hooks
        await _fireHooks(pName, 'after', { context, result: res });
        for (const g of globalHooks.after) try { await Promise.resolve(g({ pattern: pName, context, result: res })); } catch(_) {}
        // history & per-item metrics
        pushHistory({ pattern: pName, context, result: res, time: Date.now(), error: null, performance: { duration: dur }, tags: options.tags || meta.tags || [] });
        if (options.persistResult && memoryAPI) {
          try { await memoryAPI.store(`symbol:${pName}:last`, res, { persist: true, expires: options.resultExpires || 0 }); } catch(e){ log('memory store err', e); }
        }
        if (options.render && layoutAPI) {
          try { await layoutAPI.build(options.render.container, options.render.type || 'default', options.render.items || [res], Object.assign({}, context, { pattern: pName })); } catch(e){ log('layout build err', e); }
        }
        if (options.publishMeta) publishMeta(options.publishMeta.topic || `symbol:${pName}`, { pattern: pName, result: res, context });
      } catch (err) {
        const structured = createError(`pattern ${pName} error`, 'PATTERN_ERROR', { error: err });
        await _fireHooks(pName, 'error', { context, error: structured });
        for (const g of globalHooks.error) try { await Promise.resolve(g({ pattern: pName, error: structured })); } catch(_) {}
        pushHistory({ pattern: pName, context, result: null, time: Date.now(), error: structured, performance: { duration: now() - start } });
      }
    }
    // narration integration: if narrativeAPI and context signals progression
    if (narrativeAPI && typeof narrativeAPI.track === 'function' && context.event) {
      try { narrativeAPI.track(context).catch(()=>{}); } catch(_) {}
    }
    return out;
  }

  // batchApply with concurrency and stopOnError
  async function batchApply(contexts = [], { concurrency = 5, stopOnError = false } = {}) {
    if (!Array.isArray(contexts)) throw createError('contexts must be array','INVALID_ARG');
    const results = {};
    let i = 0;
    const workers = new Array(Math.min(concurrency, contexts.length)).fill(0).map(async () => {
      while (i < contexts.length) {
        const idx = i++;
        try { results[idx] = await apply(contexts[idx]); } catch (e) { results[idx] = { error: e }; if (stopOnError) throw e; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // introspection & utilities
  function getHistory(filter = {}) {
    let res = history.slice();
    if (filter.pattern) res = res.filter(h => h.pattern === filter.pattern);
    if (filter.maxAge) res = res.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(h => !!h.error);
    if (filter.tag) res = res.filter(h => h.tags && h.tags.includes(filter.tag));
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { history.length = 0; }
  function setHistoryCap(cap) { if (cap < 0) throw createError('invalid cap','INVALID_HISTORY_CAP'); historyCap = cap; while (history.length > historyCap) history.shift(); }
  function getRegistry() { return Object.fromEntries(Array.from(patterns.entries()).map(([p,v]) => [p, Object.assign({}, v)])); }
  function getPatterns() { return Array.from(patterns.keys()); }
  function filterPatternsByTag(tag) { return Array.from(patterns.entries()).filter(([,p]) => (p.options.tags||[]).includes(tag)).map(([k]) => k); }
  function validateAllPatterns() { return Array.from(patterns.entries()).map(([p,entry]) => ({ pattern: p, valid: !entry.options.validator || !!entry.options.validator(p) })); }
  function getMetrics(patternName) { return patternName ? (metrics.get(patternName) || { count:0, avgTime:0, errors:0 }) : Object.fromEntries(Array.from(metrics.entries()).map(([k,v])=>[k, { count:v.count, avgTime:v.avgTime, errors:v.errors }])); }

  function setDebug(v) { debug = !!v; }

  // wire shorthand adapters for convenience
  const adapter = { attachGestureAPI, attachLayoutAPI, attachMemoryAPI, attachNarrativeAPI, attachHookAPI, attachStateAPI };

  // init: optionally restore persisted pattern metadata
  async function init() {
    if (!memoryAPI) return;
    try {
      for (const [pName, p] of patterns.entries()) {
        if (p.options && p.options.persist) {
          try {
            const meta = await memoryAPI.recall(`pattern:${pName}:meta`);
            if (meta) { p.options = Object.assign({}, p.options, meta.options || {}); p.meta = Object.assign({}, p.meta || {}, meta.meta || {}); }
          } catch(e){ log('restore pattern meta err', e); }
        }
      }
    } catch (e) { log('init err', e); }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  return {
    register, unregister, setPatternActive, addHook, addGlobalHook,
    apply, batchApply, getHistory, clearHistory, setHistoryCap,
    getRegistry, getPatterns, filterPatternsByTag, validateAllPatterns,
    getMetrics, setDebug, adapter,
    // adapters & meta
    publishMeta, onMeta, readMeta,
    // transactions
    beginTransaction, commitTransaction, rollbackTransaction, undo, redo,
    // internals for debugging
    _internal: { patterns, patternHooks, history, metrics, txHistory, metaContext }
  };
})();

export default SymbolEngine;
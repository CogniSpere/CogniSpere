const NarrativeEngine = (() => {
  const chapters = new Map(); // name -> { condition, entered, options, registered, meta, active }
  const arcs = new Map(); // name -> { completion, completed, options, registered, meta, active }
  const hooks = new Map(); // key "chapter:name" or "arc:name" -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], after: [], error: [] };
  const history = []; // structured history entries
  const perf = new Map(); // key -> { latencies:[], count }
  const metaContext = new Map(); // topic -> value
  const metaSubs = new Map(); // topic -> Set(cb)
  const transactions = []; // active txs
  const txHistory = []; // committed txs for undo/redo
  let txPointer = txHistory.length - 1;
  let debug = false;
  let historyCap = 300;

  // adapters (opt-in)
  let layoutAPI = null; // { build(container,type,items,ctx) }
  let gpuBridge = null; // { render(canvas, items, drawFn) }
  let animator = null; // { animate(el, keyframes, opts) } or use requestAnimationFrame fallback

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const log = (...a) => { if (debug) try { console.log('[NarrativeEngine]', ...a); } catch (_) {} };

  function createError(m, c, d) { const e = new Error(m); e.code = c; e.details = d; return e; }

  function _recordPerf(key, ms) {
    if (!perf.has(key)) perf.set(key, { latencies: [], count: 0 });
    const p = perf.get(key);
    p.latencies.push(ms); if (p.latencies.length > 200) p.latencies.shift();
    p.count = (p.count || 0) + 1;
  }

  function _pushHistory(entry) {
    history.push(entry);
    while (history.length > historyCap) history.shift();
  }

  // transactions
  function beginTransaction(label = '') {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, ops: [], label, createdAt: Date.now(), committed: false };
    transactions.push(tx);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TX');
    const tx = transactions.pop();
    tx.committed = true;
    txHistory.splice(txPointer + 1);
    txHistory.push(tx);
    txPointer = txHistory.length - 1;
    return tx.id;
  }
  function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction','NO_TX');
    const tx = transactions.pop();
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'enterChapter') {
          const c = chapters.get(op.name); if (c) c.entered = op.prev;
        } else if (op.type === 'completeArc') {
          const a = arcs.get(op.name); if (a) a.completed = op.prev;
        } else if (op.type === 'registerChapter') { chapters.delete(op.name); }
        else if (op.type === 'registerArc') { arcs.delete(op.name); }
      } catch (e) { log('rollback op failed', e); }
    }
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
          if (op.type === 'registerChapter') chapters.set(op.name, op.payload);
          else if (op.type === 'registerArc') arcs.set(op.name, op.payload);
          else if (op.type === 'enterChapter') { const c = chapters.get(op.name); if (c) c.entered = op.new; }
          else if (op.type === 'completeArc') { const a = arcs.get(op.name); if (a) a.completed = op.new; }
        } catch (e) { log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer + 1, txHistory.length - 1);
      redone++;
    }
    return { redone };
  }

  // register
  function registerChapter(name, condition, options = {}, meta = {}) {
    if (!name || typeof condition !== 'function') throw createError('invalid chapter', 'INVALID_ARG');
    const entry = { condition, entered: false, options, registered: Date.now(), meta, active: options.active !== false };
    chapters.set(name, entry);
    if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'registerChapter', name, payload: entry });
    return () => unregisterChapter(name);
  }
  function unregisterChapter(name) { chapters.delete(name); hooks.delete(`chapter:${name}`); }

  function registerArc(name, completion, options = {}, meta = {}) {
    if (!name || typeof completion !== 'function') throw createError('invalid arc', 'INVALID_ARG');
    const entry = { completion, completed: false, options, registered: Date.now(), meta, active: options.active !== false };
    arcs.set(name, entry);
    if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'registerArc', name, payload: entry });
    return () => unregisterArc(name);
  }
  function unregisterArc(name) { arcs.delete(name); hooks.delete(`arc:${name}`); }

  // hooks
  function addHook(type, name, phase, cb) {
    const key = `${type}:${name}`;
    if (!hooks.has(key)) hooks.set(key, { before: [], after: [], error: [] });
    const bucket = hooks.get(key);
    if (!bucket[phase]) throw createError('invalid phase', 'INVALID_PHASE');
    bucket[phase].push(cb);
    return () => { bucket[phase] = bucket[phase].filter(x => x !== cb); };
  }
  function addGlobalHook(phase, cb) {
    if (!globalHooks[phase]) throw createError('invalid phase', 'INVALID_PHASE');
    globalHooks[phase].push(cb);
    return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); };
  }

  async function _fireHooks(type, name, phase, payload) {
    for (const g of (globalHooks[phase] || [])) try { await Promise.resolve(g({ type, name, payload })); } catch (e) { log('global hook error', e); }
    const key = `${type}:${name}`;
    const set = hooks.get(key);
    if (!set || !set[phase]) return;
    for (const cb of set[phase].slice()) try { await Promise.resolve(cb(payload)); } catch (e) { log('hook error', e); }
  }

  // meta-context
  function publishMeta(topic, payload) {
  const prev = metaContext.has(topic) ? metaContext.get(topic) : undefined;
  metaContext.set(topic, payload);

  const subs = metaSubs.get(topic) || new Set();
  for (const cb of Array.from(subs)) {
    try { cb(payload, prev); }
    catch (e) { log('meta sub error', e); }
  }

  if (transactions.length)
    transactions[transactions.length - 1].ops.push({ type: 'metaPublish', topic, prev, new: payload });
}

  // adapters attach
  function attachLayoutAPI(api) { layoutAPI = api; return () => { layoutAPI = null; }; }
  function attachGPUBridge(api) { gpuBridge = api; return () => { gpuBridge = null; }; }
  function attachAnimator(api) { animator = api; return () => { animator = null; }; }

  // rendering helper: if layoutAPI attached use it, else try simple DOM insertion
  async function render(container, type, items = [], context = {}) {
    if (!container) return;
    if (layoutAPI && typeof layoutAPI.build === 'function') return layoutAPI.build(container, type, items, context);
    // fallback simple rendering
    try {
      container.innerHTML = items.map(i => `<div class="n-item">${i.content ?? i}</div>`).join('');
    } catch (e) { log('fallback render failed', e); }
  }

  // GPU rendering helper
  function gpuRender(canvas, items, drawFn) {
    if (gpuBridge && typeof gpuBridge.render === 'function') return gpuBridge.render(canvas, items, drawFn);
    // fallback: if 2D context available
    try {
      const ctx = canvas.getContext && (canvas.getContext('2d') || canvas.getContext('webgl') || canvas.getContext('webgl2'));
      if (ctx && typeof drawFn === 'function') return drawFn(ctx, items);
    } catch (e) { log('gpu fallback error', e); }
  }

  // track single payload: evaluate chapters then arcs, with hooks, history, perf, transactions and meta notifications
  async function track(payload = {}) {
    const start = now();
    const results = { chapters: [], arcs: [] };
    for (const [name, c] of chapters.entries()) {
      if (!c.active || c.entered) continue;
      try {
        for (const g of globalHooks.before) try { await Promise.resolve(g({ type: 'chapter', name, payload })); } catch (e) {}
        await _fireHooks('chapter', name, 'before', { name, payload });
        const t0 = now();
        const ok = await Promise.resolve(c.condition(payload));
        const dur = now() - t0;
        _recordPerf(`chapter:${name}`, dur);
        if (ok) {
          if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'enterChapter', name, prev: c.entered, new: true });
          c.entered = true;
          await _fireHooks('chapter', name, 'after', { name, payload });
          for (const g of globalHooks.after) try { await Promise.resolve(g({ type: 'chapter', name, payload })); } catch (e) {}
          results.chapters.push(name);
          _pushHistory({ type: 'chapter', name, payload, time: Date.now(), error: null, performance: { duration: dur }, tags: c.options.tags || c.meta?.tags || [] });
          if (c.options.publishMeta) publishMeta(c.options.publishMeta.topic || `chapter:${name}`, { name, payload });
          if (c.options.render && c.options.container) await render(c.options.container, c.options.renderType || 'default', c.options.renderItems || [], { source: 'chapter', name, payload });
        }
      } catch (err) {
        const e = createError(`chapter ${name} error`, 'CHAPTER_ERROR', { error: err });
        await _fireHooks('chapter', name, 'error', { name, payload, error: e });
        for (const g of globalHooks.error) try { await Promise.resolve(g({ type: 'chapter', name, error: e })); } catch (ee) {}
        _pushHistory({ type: 'chapter', name, payload, time: Date.now(), error: e, performance: { duration: now() - start } });
      }
    }

    for (const [name, a] of arcs.entries()) {
      if (!a.active || a.completed) continue;
      try {
        for (const g of globalHooks.before) try { await Promise.resolve(g({ type: 'arc', name, payload })); } catch (e) {}
        await _fireHooks('arc', name, 'before', { name, payload });
        const t0 = now();
        const ok = await Promise.resolve(a.completion(payload));
        const dur = now() - t0;
        _recordPerf(`arc:${name}`, dur);
        if (ok) {
          if (transactions.length) transactions[transactions.length - 1].ops.push({ type: 'completeArc', name, prev: a.completed, new: true });
          a.completed = true;
          await _fireHooks('arc', name, 'after', { name, payload });
          for (const g of globalHooks.after) try { await Promise.resolve(g({ type: 'arc', name, payload })); } catch (e) {}
          results.arcs.push(name);
          _pushHistory({ type: 'arc', name, payload, time: Date.now(), error: null, performance: { duration: dur }, tags: a.options.tags || a.meta?.tags || [] });
          if (a.options.publishMeta) publishMeta(a.options.publishMeta.topic || `arc:${name}`, { name, payload });
          if (a.options.render && a.options.container) await render(a.options.container, a.options.renderType || 'default', a.options.renderItems || [], { source: 'arc', name, payload });
          if (a.options.animate && a.options.container) {
            try {
              if (animator && typeof animator.animate === 'function') animator.animate(a.options.container, a.options.animate.keyframes || [], a.options.animate.opts || {});
              else if (a.options.animate.keyframes && a.options.container.animate) a.options.container.animate(a.options.animate.keyframes, a.options.animate.opts || {});
            } catch (e) { log('animate failed', e); }
          }
          if (a.options.gpu && a.options.canvas) {
            try { gpuRender(a.options.canvas, a.options.gpu.items || [], a.options.gpu.draw); } catch (e) { log('gpu render err', e); }
          }
        }
      } catch (err) {
        const e = createError(`arc ${name} error`, 'ARC_ERROR', { error: err });
        await _fireHooks('arc', name, 'error', { name, payload, error: e });
        for (const g of globalHooks.error) try { await Promise.resolve(g({ type: 'arc', name, error: e })); } catch (ee) {}
        _pushHistory({ type: 'arc', name, payload, time: Date.now(), error: e, performance: { duration: now() - start } });
      }
    }

    _recordPerf('track', now() - start);
    return results;
  }

  // batchTrack with concurrency
  async function batchTrack(payloads = [], { concurrency = 5, stopOnError = false } = {}) {
    if (!Array.isArray(payloads)) throw createError('payloads must be array', 'INVALID_ARG');
    const results = [];
    let i = 0;
    const runners = new Array(Math.min(concurrency, payloads.length)).fill(0).map(async () => {
      while (i < payloads.length) {
        const idx = i++;
        try { results[idx] = await track(payloads[idx]); } catch (e) { results[idx] = { error: e }; if (stopOnError) throw e; }
      }
    });
    await Promise.all(runners);
    return results;
  }

  function resetProgress(type = null, name = null) {
    if (!type) {
      for (const c of chapters.values()) c.entered = false;
      for (const a of arcs.values()) a.completed = false;
      return;
    }
    if (type === 'chapter') {
      const c = chapters.get(name); if (!c) throw createError('chapter not found','NOT_FOUND'); c.entered = false;
    } else if (type === 'arc') {
      const a = arcs.get(name); if (!a) throw createError('arc not found','NOT_FOUND'); a.completed = false;
    } else throw createError('invalid type','INVALID_ARG');
  }

  function getHistory(filter = {}) {
    let r = history.slice();
    if (filter.type) r = r.filter(h => h.type === filter.type);
    if (filter.name) r = r.filter(h => h.name === filter.name);
    if (filter.maxAge) r = r.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) r = r.filter(h => !!h.error);
    if (filter.tag) r = r.filter(h => h.tags && h.tags.includes(filter.tag));
    if (filter.predicate) r = r.filter(filter.predicate);
    return r;
  }
  function clearHistory() { history.length = 0; }
  function setHistoryCap(cap) { historyCap = Math.max(0, cap); while (history.length > historyCap) history.shift(); }

  // introspection
  function listChapters() { return Array.from(chapters.keys()); }
  function listArcs() { return Array.from(arcs.keys()); }
  function getChapters() { return Object.fromEntries(chapters); }
  function getArcs() { return Object.fromEntries(arcs); }
  function getPerformanceMetrics() {
    const out = {};
    for (const [k, v] of perf.entries()) out[k] = { avg: v.latencies.length ? v.latencies.reduce((a,b)=>a+b,0)/v.latencies.length : 0, count: v.count || 0 };
    return out;
  }

  function setDebug(v = true) { debug = !!v; }
  function attachLayoutAPI(api) { layoutAPI = api; return () => { layoutAPI = null; }; }
  function attachGPUBridge(api) { gpuBridge = api; return () => { gpuBridge = null; }; }
  function attachAnimator(api) { animator = api; return () => { animator = null; }; }
  function publishMeta(topic, payload) { publishMeta(topic, payload); } // alias
  function onMeta(topic, cb) { return onMeta(topic, cb); } // alias

  return {
    registerChapter, unregisterChapter, registerArc, unregisterArc,
    addHook, addGlobalHook, track, batchTrack, resetProgress,
    listChapters, listArcs, getChapters, getArcs, getHistory, clearHistory, setHistoryCap,
    beginTransaction, commitTransaction, rollbackTransaction, undo, redo, txHistory,
    attachLayoutAPI, attachGPUBridge, attachAnimator, publishMeta, onMeta, readMeta,
    getPerformanceMetrics, setDebug
  };
})();
export default NarrativeEngine;
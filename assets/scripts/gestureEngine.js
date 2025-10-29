const GestureEngine = (() => {
  // core state
  const gestures = new Map(); // type -> { detector, options, active, registered, meta }
  const hooks = new Map(); // type -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], after: [], error: [] };
  const history = []; // detection & op history
  let debug = false;
  let historyCap = 200;

  // adapters (optional, attach via provided API)
  let symbolAPI = null; // expected: { apply(context) => Promise<results|boolean> }
  let stateAPI = null;  // expected: { set(key,val,opts), get(key), subscribe(key,cb), batchSet(obj) }
  let dom3d = null;     // expected: DOM3DManager-like { attach(domEl, obj, opts), detach(domEl) }
  const metaContext = new Map(); // topic -> value
  const metaSubs = new Map();

  // transactional support
  const transactions = [];
  const txHistory = [];
  let txPointer = -1;

  // anchors
  const anchors = new Map(); // element -> { type, opts }

  // helpers
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const log = (...a) => { if (debug) try { console.log('[GestureEngine]', ...a); } catch(e){}; };
  function createError(msg, code, details) { const e = new Error(msg); e.code = code; e.details = details; return e; }
  function pushHistory(entry) { history.push(entry); while (history.length > historyCap) history.shift(); }

  // attach adapters
  function attachSymbolAPI(api) { symbolAPI = api; return () => { symbolAPI = null; }; }
  function attachStateAPI(api) { stateAPI = api; return () => { stateAPI = null; }; }
  function attachDOM3D(api) { dom3d = api; return () => { dom3d = null; }; }

  // meta-context
  function publishMeta(topic, payload) {
    metaContext.set(topic, payload);
    const subs = metaSubs.get(topic) || [];
    for (const cb of subs.slice()) try { cb(payload); } catch (e) { log('meta sub error', e); }
  }
  function onMeta(topic, cb) {
    if (!metaSubs.has(topic)) metaSubs.set(topic, []);
    metaSubs.get(topic).push(cb);
    return () => { metaSubs.set(topic, metaSubs.get(topic).filter(x => x !== cb)); };
  }
  function readMeta(topic) { return metaContext.get(topic); }

  // transaction recording
  function recordTx(op) {
    if (!transactions.length) return;
    transactions[transactions.length - 1].ops.push(op);
  }
  function beginTransaction(label) {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label: label || '', ops: [], createdAt: Date.now(), committed: false };
    transactions.push(tx);
    log('tx begin', tx.id);
    return tx.id;
  }
  function commitTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TX');
    const tx = transactions.pop();
    tx.committed = true;
    txHistory.splice(txPointer + 1);
    txHistory.push(tx);
    txPointer = txHistory.length - 1;
    log('tx commit', tx.id);
    return tx.id;
  }
  async function rollbackTransaction() {
    if (!transactions.length) throw createError('no active transaction', 'NO_TX');
    const tx = transactions.pop();
    // reverse ops
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'register') { gestures.delete(op.typeName); hooks.delete(op.typeName); }
        else if (op.type === 'unregister') gestures.set(op.typeName, op.prev);
        else if (op.type === 'setActive') { if (gestures.has(op.typeName)) gestures.get(op.typeName).active = op.prev; }
        else if (op.type === 'anchorAdd') anchors.delete(op.element); 
        else if (op.type === 'anchorRemove') anchors.set(op.element, op.prev);
      } catch (e) { log('rollback op failed', e); }
    }
    log('tx rollback', tx.id);
    return tx.id;
  }
  async function undo(steps = 1) {
    let undone = 0;
    while (undone < steps && txPointer >= 0) {
      const tx = txHistory[txPointer];
      const fakeTx = { ops: tx.ops.slice() };
      transactions.push(fakeTx);
      await rollbackTransaction();
      txPointer--;
      undone++;
    }
    return { undone };
  }
  async function redo(steps = 1) {
    let redone = 0;
    while (redone < steps && txPointer < txHistory.length - 1) {
      const nextIdx = txPointer + 1;
      const tx = txHistory[nextIdx];
      for (const op of tx.ops) {
        try {
          if (op.type === 'register') gestures.set(op.typeName, op.new);
          else if (op.type === 'unregister') gestures.delete(op.typeName);
          else if (op.type === 'setActive') { if (gestures.has(op.typeName)) gestures.get(op.typeName).active = op.new; }
          else if (op.type === 'anchorAdd') anchors.set(op.element, op.new);
          else if (op.type === 'anchorRemove') anchors.delete(op.element);
        } catch (e) { log('redo op failed', e); }
      }
      txPointer = Math.min(txPointer + 1, txHistory.length - 1);
      redone++;
    }
    return { redone };
  }

  // register gesture
  function register(typeName, detector, options = {}, meta = {}) {
    if (!typeName || typeof typeName !== 'string') throw createError('type must be non-empty string', 'INVALID_TYPE');
    if (!detector) throw createError('detector required', 'INVALID_DETECTOR');
    // normalize detector: allow function, string pattern, or object { pattern, fn }
    let det = detector;
    if (typeof detector === 'string' || detector && detector.pattern) {
      det = async (ctx) => {
        // pattern string: use symbolAPI if attached, else simple match
        const pattern = typeof detector === 'string' ? detector : detector.pattern;
        if (symbolAPI && typeof symbolAPI.apply === 'function') {
          try {
            const res = await symbolAPI.apply({ pattern, context: ctx });
            // symbolAPI.apply returns truthy match or object
            return !!res;
          } catch (e) { log('symbolAPI error', e); return false; }
        }
        // builtin wildcard/regex matcher
        if (pattern.endsWith('*')) return String(ctx.value || '').startsWith(pattern.slice(0, -1));
        if (pattern.startsWith('/') && pattern.endsWith('/')) {
          try { return new RegExp(pattern.slice(1, -1)).test(String(ctx.value || '')); } catch(e){ return false; }
        }
        return String(pattern) === String(ctx.value);
      };
    }
    const entry = { detector: det, options: Object.assign({ active: true }, options), active: options.active !== false, registered: Date.now(), meta };
    gestures.set(typeName, entry);
    recordTx({ type: 'register', typeName, new: entry });
    log('registered gesture', typeName);
    // persist activation if requested
    if (stateAPI && entry.options.persistActivation) {
      try { stateAPI.set(`gesture:${typeName}`, { active: entry.active }, { persist: true, expires: entry.options.activationExpires }); } catch (e) { log('state persist err', e); }
    }
    return () => unregister(typeName);
  }

  // unregister
  function unregister(typeName) {
    if (!gestures.has(typeName)) return;
    const prev = gestures.get(typeName);
    gestures.delete(typeName);
    hooks.delete(typeName);
    recordTx({ type: 'unregister', typeName, prev });
    log('unregistered gesture', typeName);
  }

  function setGestureActive(typeName, state = true, opts = {}) {
    const g = gestures.get(typeName);
    if (!g) return;
    const prev = g.active;
    g.active = !!state;
    recordTx({ type: 'setActive', typeName, prev, new: g.active });
    if (stateAPI && g.options.persistActivation) {
      try { stateAPI.set(`gesture:${typeName}`, { active: g.active }, { persist: true, expires: g.options.activationExpires }); } catch (e) { log('state persist err', e); }
    }
  }

  // hooks
  function addHook(typeName, phase, cb) {
    if (!hooks.has(typeName)) hooks.set(typeName, { before: [], after: [], error: [] });
    const bucket = hooks.get(typeName)[phase];
    bucket.push(cb);
    return () => { hooks.get(typeName)[phase] = hooks.get(typeName)[phase].filter(x => x !== cb); };
  }
  function addGlobalHook(phase, cb) { if (!globalHooks[phase]) throw createError('invalid phase', 'INVALID_PHASE'); globalHooks[phase].push(cb); return () => { globalHooks[phase] = globalHooks[phase].filter(x => x !== cb); }; }

  async function fireHooks(typeName, phase, payload) {
    for (const cb of (globalHooks[phase] || [])) { try { await cb({ type: typeName, payload }); } catch (e) { log('global hook err', e); } }
    if (!hooks.has(typeName)) return;
    for (const cb of (hooks.get(typeName)[phase] || [])) { try { await cb(payload); } catch (e) { log('hook err', typeName, e); } }
  }

  // anchors: DOM anchoring + optional dom3d attachment
  function registerAnchor(element, opts = {}) {
    if (!(element instanceof Element)) throw createError('element required', 'INVALID_ELEMENT');
    const anchor = { element, opts, registered: Date.now() };
    anchors.set(element, anchor);
    recordTx({ type: 'anchorAdd', element, new: anchor });
    if (dom3d && typeof dom3d.attach === 'function') {
      try { dom3d.attach(element, opts.object3D || {}, opts); } catch (e) { log('dom3d attach err', e); }
    }
    return () => removeAnchor(element);
  }
  function removeAnchor(element) {
    const prev = anchors.get(element);
    if (!prev) return;
    anchors.delete(element);
    recordTx({ type: 'anchorRemove', element, prev });
    try { if (dom3d && typeof dom3d.detach === 'function') dom3d.detach(element); } catch (e) { log('dom3d detach err', e); }
  }

  // detect attachment
  function attachDetect(element) {
    if (!(element instanceof Element)) throw createError('invalid element', 'INVALID_ELEMENT');
    let sX = 0, sY = 0, sT = 0;
    let keyCombo = [];
    element.addEventListener('touchstart', (e) => {
      if (!e.touches || e.touches.length === 0) return;
      sX = e.touches[0].clientX; sY = e.touches[0].clientY; sT = Date.now();
      for (const g of gestures.keys()) fireHooks(g, 'before', { element, event: e }).catch(()=>{});
      for (const cb of globalHooks.before) try { cb({ event: e }); } catch (err) { log('global before err', err); }
    }, { passive: true });

    element.addEventListener('touchend', async (e) => {
      const perfStart = performance.now();
      if (!e.changedTouches || e.changedTouches.length === 0) return;
      const endX = e.changedTouches[0].clientX, endY = e.changedTouches[0].clientY;
      const elapsed = Date.now() - sT;
      const diffX = endX - sX, diffY = endY - sY;
      const touchCount = e.changedTouches.length;

      for (const [typeName, { detector, options, active }] of gestures.entries()) {
        if (!active) continue;
        try {
          const ctx = { diffX, diffY, elapsed, element, event: e, touchCount, value: options.matchValue };
          let match = false;
          if (typeof detector === 'function') match = await detector(ctx);
          else match = !!detector;
          if (match) {
            if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
            if (options.role) element.setAttribute('role', options.role);
            await fireHooks(typeName, 'after', { element, typeName, event: e, diffX, diffY, elapsed, touchCount });
            // publish meta
            if (options.publishMeta) publishMeta(options.publishMeta.topic || `gesture:${typeName}`, { element, typeName, ctx });
            // dispatch event
            try { element.dispatchEvent(new CustomEvent(`gesture:${typeName}`, { bubbles: true, detail: { diffX, diffY, elapsed, touchCount, event: e } })); } catch (_) {}
            const perfEntry = { type: 'detect', name: typeName, element, diffX, diffY, elapsed, touchCount, time: Date.now(), error: null, performance: { duration: performance.now() - perfStart } };
            pushHistory(perfEntry);
            if (options.ariaLabel) element.removeAttribute('aria-label');
            if (options.role) element.removeAttribute('role');
            // notify state store about detection
            if (stateAPI && options.persistDetection) {
              try { stateAPI.set(`gesture:detect:${typeName}`, { time: Date.now(), elementId: element.id || null }, { persist: true, expires: options.detectionExpires }); } catch (err) { log('state set err', err); }
            }
          }
        } catch (err) {
          const structured = createError(`Gesture ${typeName} error`, 'GESTURE_ERROR', { error: err });
          await fireHooks(typeName, 'error', { element, typeName, event: e, error: structured }).catch(()=>{});
          for (const cb of globalHooks.error) try { cb({ type: typeName, error: structured }); } catch (ee) { log('global error hook err', ee); }
          try { element.dispatchEvent(new CustomEvent('gesture:error', { bubbles: true, detail: { type: typeName, error: structured } })); } catch (_) {}
          pushHistory({ type: 'error', name: typeName, element, error: structured, time: Date.now(), performance: { duration: performance.now() - perfStart } });
        }
      }
    }, { passive: true });

    // keyboard support
    element.addEventListener('keydown', async (e) => {
      const perfStart = performance.now();
      keyCombo.push(e.key);
      for (const [typeName, { detector, options, active }] of gestures.entries()) {
        if (!active) continue;
        try {
          const ctx = { key: e.key, keyCombo: keyCombo.slice(), element, event: e, value: options.matchValue };
          let match = false;
          if (typeof detector === 'function') match = await detector(ctx);
          else match = !!detector;
          if (match) {
            if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
            if (options.role) element.setAttribute('role', options.role);
            await fireHooks(typeName, 'after', { element, typeName, event: e, key: e.key, keyCombo: ctx.keyCombo });
            try { element.dispatchEvent(new CustomEvent(`gesture:${typeName}`, { bubbles: true, detail: { key: e.key, keyCombo: ctx.keyCombo, event: e } })); } catch (_) {}
            pushHistory({ type: 'detect', name: typeName, key: e.key, keyCombo: ctx.keyCombo.slice(), time: Date.now(), error: null, performance: { duration: performance.now() - perfStart } });
            if (options.ariaLabel) element.removeAttribute('aria-label');
            if (options.role) element.removeAttribute('role');
          }
        } catch (err) {
          const structured = createError(`Keyboard gesture ${typeName} error`, 'KEYBOARD_GESTURE_ERROR', { error: err });
          await fireHooks(typeName, 'error', { element, typeName, event: e, error: structured }).catch(()=>{});
          for (const cb of globalHooks.error) try { cb({ type: typeName, error: structured }); } catch (ee) { log('global error hook err', ee); }
          try { element.dispatchEvent(new CustomEvent('gesture:error', { bubbles: true, detail: { type: typeName, error: structured } })); } catch (_) {}
          pushHistory({ type: 'error', name: typeName, key: e.key, keyCombo: keyCombo.slice(), time: Date.now(), error: structured, performance: { duration: performance.now() - perfStart } });
        }
      }
      setTimeout(() => { keyCombo = []; }, 1000);
    }, true);
  }

  async function batchDetect(elements = [], concurrency = 5) {
    if (!Array.isArray(elements)) throw createError('elements must be array', 'INVALID_ARG');
    let idx = 0;
    const results = [];
    const runners = new Array(Math.min(concurrency, elements.length)).fill(0).map(async () => {
      while (idx < elements.length) {
        const el = elements[idx++];
        try { attachDetect(el); results.push({ element: el, attached: true }); } catch (e) { results.push({ element: el, error: e }); }
      }
    });
    await Promise.all(runners);
    log('batchDetect completed', { count: elements.length });
    return results;
  }

  // history & registry
  function getHistory(filter = {}) {
    let res = history.slice();
    if (filter.type) res = res.filter(h => h.type === filter.type);
    if (filter.name) res = res.filter(h => h.name === filter.name);
    if (filter.maxAge) res = res.filter(h => h.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) res = res.filter(h => !!h.error);
    if (filter.predicate) res = res.filter(filter.predicate);
    return res;
  }
  function clearHistory() { history.length = 0; log('history cleared'); }
  function setHistoryCap(cap) { if (cap < 0) throw createError('invalid cap', 'INVALID_HISTORY_CAP'); historyCap = cap; while (history.length > historyCap) history.shift(); }

  function getRegistry() { return Object.fromEntries(Array.from(gestures.entries()).map(([k, v]) => [k, Object.assign({}, v)])); }
  function listGestures() { return Array.from(gestures.keys()); }
  function filterGesturesByTag(tag) { return Array.from(gestures.entries()).filter(([, g]) => (g.options.tags || []).includes(tag)).map(([k]) => k); }
  function validateAllGestures() { return Array.from(gestures.entries()).map(([k, v]) => ({ type: k, valid: true })); }

  // anchors introspection
  function listAnchors() { return Array.from(anchors.values()).map(a => ({ element: a.element, opts: a.opts })); }

  // debug
  function setDebug(v) { debug = !!v; log('debug', debug); }

  // initialization - restore activation states if stateAPI attached
  async function init() {
    if (stateAPI && typeof stateAPI.get === 'function') {
      for (const [typeName, g] of gestures.entries()) {
        try {
          const persisted = await stateAPI.get(`gesture:${typeName}`);
          if (persisted && typeof persisted.active !== 'undefined') g.active = !!persisted.active;
        } catch (e) { log('state restore err', e); }
      }
    }
    log('GestureEngine initialized');
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  return {
    register,
    unregister,
    setGestureActive,
    addHook,
    addGlobalHook,
    batchUnregister: (fn) => { for (const [k,v] of gestures.entries()) if (fn(v,k)) unregister(k); },
    attachDetect,
    batchDetect,
    getRegistry,
    listGestures,
    filterGesturesByTag,
    validateAllGestures,
    getHistory,
    clearHistory,
    setDebug,
    setHistoryCap,
    // adapters & meta
    attachSymbolAPI,
    attachStateAPI,
    attachDOM3D,
    publishMeta,
    onMeta,
    readMeta,
    // anchors
    registerAnchor,
    removeAnchor,
    listAnchors,
    // transactions
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    undo,
    redo,
    // internals for inspection if needed
    _internal: { gestures, hooks, history, anchors, txHistory }
  };
})();
export default GestureEngine;
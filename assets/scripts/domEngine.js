/**
 * domEngine.js - Ultra-Enhanced DOM Manipulation & Observation Engine
 * Added features:
 * - Synergy/meta-context integration (registerSynergy, setMetaContext, auto-trigger)
 * - Narrative/progression tracking (chapters/arcs: startChapter/endChapter/getChapters/getProgress)
 * - GPU/renderer bridge (registerRenderer, renderAll, requestRender)
 * - Expanded global hook phases (beforeAll, afterAll, conflict, resolve)
 * - Serialization & layout awareness (serialize/restore include layout; computeLayout APIs)
 * - Kept original features and interfaces; concise and compatible.
 */

const DomEngine = (() => {
  // Internal state
  const registry = new Map(); // id -> { element, tags, meta }
  const hooks = new Map();    // id -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], beforeAll: [], after: [], afterAll: [], error: [], conflict: [], resolve: [] };
  const mutationHooks = [];
  const history = [];
  let debug = false;
  let maxHistoryLength = 300;
  let transaction = null; // { operations: [], snapshot: null }

  // Mutation observer
  let mutationObserver = null;
  let observeActive = false;
  const mutationHistory = [];
  let mutationHistoryCap = 100;

  // Performance metrics
  const performanceMetrics = new Map(); // id -> { opCount, totalTime, avgTime }

  // Undo/redo stacks
  const undoStack = [];
  const redoStack = [];

  // Synergy/meta-context and renderer
  let synergyInstance = null;
  let metaContext = {};
  let renderer = null;

  // Narrative/progression
  const chapters = []; // { name, meta, startTime, endTime, ops }
  function currentChapter() { return chapters.length ? chapters[chapters.length - 1] : null; }

  // Debug logger
  function log(...args) { if (debug) console.log('[DomEngine]', ...args); }
  function trace(...args) { if (debug) console.trace('[DomEngine]', ...args); }

  // Structured error
  function createError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  // Performance tracking
  function trackPerformance(id, op, duration) {
    if (!performanceMetrics.has(id)) {
      performanceMetrics.set(id, { opCount: 0, totalTime: 0, avgTime: 0 });
    }
    const metrics = performanceMetrics.get(id);
    metrics.opCount++;
    metrics.totalTime += duration;
    metrics.avgTime = metrics.totalTime / metrics.opCount;
    metrics[`${op}Count`] = (metrics[`${op}Count`] || 0) + 1;
    metrics[`${op}Time`] = (metrics[`${op}Time`] || 0) + duration;
  }

  // Registry helpers
  function register(id, element, tags = [], meta = {}) {
    if (!element) throw createError('Element required for registration', 'NO_ELEMENT', {id});
    registry.set(id, { element, tags: Array.isArray(tags) ? tags : [tags], meta });
    log(`Registered element: ${id}`, element, tags, meta);
  }

  function unregister(id) {
    registry.delete(id);
    hooks.delete(id);
    performanceMetrics.delete(id);
    log(`Unregistered element: ${id}`);
  }

  // Synergy/meta-context integration
  function registerSynergy(s) {
    synergyInstance = s || null;
    return () => { synergyInstance = null; };
  }
  function setMetaContext(ctx) {
    metaContext = ctx || {};
  }

  // Renderer bridge
  function registerRenderer(r) {
    renderer = r || null;
    return () => { renderer = null; };
  }

  function requestRender(id) {
    const rec = registry.get(id);
    if (!rec || !renderer || typeof renderer.render !== 'function') return false;
    try {
      renderer.render(rec.element, { id, meta: rec.meta, tags: rec.tags, context: metaContext });
      return true;
    } catch (e) { _fireGlobal('error', { type: 'render', id, error: e }); return false; }
  }

  function renderAll() {
    if (!renderer || typeof renderer.renderBatch !== 'function') {
      // best-effort: call render for each
      for (const [id, r] of registry.entries()) requestRender(id);
      return true;
    }
    try {
      const batch = Array.from(registry.entries()).map(([id, r]) => ({ id, element: r.element, meta: r.meta, tags: r.tags }));
      renderer.renderBatch(batch, { context: metaContext });
      return true;
    } catch (e) { _fireGlobal('error', { type: 'renderBatch', error: e }); return false; }
  }

  // Transaction management
  function beginTransaction() {
    if (transaction) throw createError('Transaction already in progress', 'TRANSACTION_ACTIVE');
    transaction = { operations: [], snapshot: snapshot() };
    log('Transaction begun');
  }

  async function commitTransaction() {
    if (!transaction) throw createError('No transaction in progress', 'NO_TRANSACTION');
    transaction = null;
    log('Transaction committed');
  }

  async function rollbackTransaction() {
    if (!transaction) throw createError('No transaction in progress', 'NO_TRANSACTION');
    await restore(transaction.snapshot);
    transaction.operations.forEach(op => history.pop());
    transaction = null;
    log('Transaction rolled back');
  }

  // Hook system
  function addHook(id, phase, callback) {
    if (!hooks.has(id)) hooks.set(id, { before: [], after: [], error: [] });
    hooks.get(id)[phase].push(callback);
    return () => { hooks.get(id)[phase] = hooks.get(id)[phase].filter(cb => cb !== callback); };
  }

  function addGlobalHook(phase, callback) {
    if (!globalHooks[phase]) throw new Error(`Unknown global hook phase: ${phase}`);
    globalHooks[phase].push(callback);
    return () => { globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback); };
  }

  async function _fireGlobal(phase, payload) {
    const arr = globalHooks[phase] || [];
    for (const cb of arr) {
      try { const r = cb(payload); if (r instanceof Promise) await r; } catch (e) { console.error('[DomEngine] global hook error', phase, e); }
    }
  }

  async function fireHooks(id, phase, payload) {
    // global per-phase and per-element
    await _fireGlobal(phase, { id, payload, meta: metaContext });
    if (hooks.has(id)) {
      for (const cb of hooks.get(id)[phase] || []) {
        try { await cb(payload); } catch (e) { log(`Hook error for ${id} (${phase})`, e); }
      }
    }
  }

  // Narrative / progression
  function startChapter(name, meta = {}) {
    const ch = { name, meta, startTime: Date.now(), endTime: null, ops: 0, id: `ch-${Date.now()}-${Math.random().toString(36).slice(2,6)}` };
    chapters.push(ch);
    _fireGlobal('resolve', { type: 'chapter:start', chapter: ch });
    return ch.id;
  }
  function endChapter() {
    const ch = currentChapter();
    if (!ch) return null;
    ch.endTime = Date.now();
    _fireGlobal('resolve', { type: 'chapter:end', chapter: ch });
    return ch;
  }
  function getChapters() { return chapters.map(c => ({ ...c })); }
  function getProgress(chapterNameOrId) {
    const ch = chapters.find(c => c.name === chapterNameOrId || c.id === chapterNameOrId);
    if (!ch) return null;
    const duration = (ch.endTime || Date.now()) - ch.startTime;
    return { name: ch.name, id: ch.id, ops: ch.ops, duration };
  }

  // Batch operations (call global beforeAll/afterAll, increment chapter ops, trigger synergy/render)
  async function _withBeforeAll(payload) { await _fireGlobal('beforeAll', Object.assign({ meta: metaContext }, payload)); }
  async function _withAfterAll(payload) { await _fireGlobal('afterAll', Object.assign({ meta: metaContext }, payload)); }

  // Batch create / update / remove (unchanged concurrency approach but call global phases, synergy and renderer)
  async function batchCreate(entries, options = {}) {
    await _withBeforeAll({ op: 'batchCreate', count: entries.length, options });
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = options;
    let idx = 0, active = 0;
    const results = [];
    const queue = new Set();
    async function run({id, tag, attrs, classes, styles, parent}) {
      try {
        await fireHooks(id, 'before', {id, tag, attrs, classes, styles, parent});
        const el = document.createElement(tag || 'div');
        if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        if (classes) el.classList.add(...classes);
        if (styles) Object.assign(el.style, styles);
        if (parent) (typeof parent === 'string' ? document.querySelector(parent) : parent)?.appendChild(el);
        register(id, el, (parent && parent.tags) || [], {});
        await fireHooks(id, 'after', {id, element: el});
        const op = {op:'create', id, tag, time: Date.now(), error: null, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        // chapter tracking
        const ch = currentChapter(); if (ch) ch.ops++;
        trackPerformance(id, 'create', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
        undoStack.push({ type: 'create', id, parent });
        redoStack.length = 0;
        // renderer
        if (renderer) requestRender(id);
        // synergy trigger
        if (synergyInstance && typeof synergyInstance.trigger === 'function') {
          try { synergyInstance.trigger(Object.assign({ event: 'dom:create', id }, metaContext)); } catch (e) { /* ignore */ }
        }
        log(`Created element: ${id}`, el);
        results.push({id, ok:true, element:el});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'create', id, tag, time: Date.now(), error:e, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        log(`Error creating element ${id}:`, e);
        results.push({id, ok:false, error:e});
      }
    }
    while (idx < entries.length) {
      while (active < concurrency && idx < entries.length) {
        const entry = entries[idx++];
        const task = run(entry).finally(() => { active--; queue.delete(task); });
        active++; queue.add(task);
      }
      if (queue.size > 0) await Promise.race(queue);
    }
    await Promise.all(queue);
    while (history.length > maxHistoryLength) history.shift();
    await _withAfterAll({ op: 'batchCreate', results });
    _fireGlobal('resolve', { type: 'batchCreate', count: results.length });
    return results;
  }

  async function batchUpdate(updates, options = {}) {
    await _withBeforeAll({ op: 'batchUpdate', count: updates.length, options });
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = options;
    let idx = 0, active = 0;
    const results = [];
    const queue = new Set();
    async function run({id, attrs, classes, styles}) {
      try {
        await fireHooks(id, 'before', {id, attrs, classes, styles});
        const reg = registry.get(id);
        if (!reg) throw createError('Element not registered', 'NO_ELEMENT', {id});
        const el = reg.element;
        const prevState = {
          attrs: getAttributes(id),
          classes: getClasses(id),
          styles: getStyles(id)
        };
        if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        if (classes) { el.classList.remove(...el.classList); el.classList.add(...classes); }
        if (styles) Object.assign(el.style, styles);
        await fireHooks(id, 'after', {id, element: el});
        const op = {op:'update', id, time: Date.now(), error: null, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        const ch = currentChapter(); if (ch) ch.ops++;
        trackPerformance(id, 'update', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
        undoStack.push({ type: 'update', id, prevState });
        redoStack.length = 0;
        if (renderer) requestRender(id);
        if (synergyInstance && typeof synergyInstance.trigger === 'function') {
          try { synergyInstance.trigger(Object.assign({ event: 'dom:update', id }, metaContext)); } catch (e) { /* ignore */ }
        }
        log(`Updated element: ${id}`, el);
        results.push({id, ok:true});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'update', id, time: Date.now(), error:e, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        log(`Error updating element ${id}:`, e);
        results.push({id, ok:false, error:e});
      }
    }
    while (idx < updates.length) {
      while (active < concurrency && idx < updates.length) {
        const entry = updates[idx++];
        const task = run(entry).finally(() => { active--; queue.delete(task); });
        active++; queue.add(task);
      }
      if (queue.size > 0) await Promise.race(queue);
    }
    await Promise.all(queue);
    while (history.length > maxHistoryLength) history.shift();
    await _withAfterAll({ op: 'batchUpdate', results });
    _fireGlobal('resolve', { type: 'batchUpdate', count: results.length });
    return results;
  }

  async function batchRemove(ids, options = {}) {
    await _withBeforeAll({ op: 'batchRemove', count: ids.length, options });
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = options;
    let idx = 0, active = 0;
    const results = [];
    const queue = new Set();
    async function run(id) {
      try {
        await fireHooks(id, 'before', {id});
        const reg = registry.get(id);
        if (!reg) throw createError('Element not registered', 'NO_ELEMENT', {id});
        const el = reg.element;
        const parent = el.parentNode;
        if (parent) parent.removeChild(el);
        const state = { element: el, parent, tags: reg.tags, meta: reg.meta };
        unregister(id);
        await fireHooks(id, 'after', {id});
        const op = {op:'remove', id, time: Date.now(), error: null, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        const ch = currentChapter(); if (ch) ch.ops++;
        trackPerformance(id, 'remove', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
        undoStack.push({ type: 'remove', id, state });
        redoStack.length = 0;
        if (renderer) { /* attempt best-effort cleanup render request */ try { renderer.remove && renderer.remove(id); } catch (e) {} }
        if (synergyInstance && typeof synergyInstance.trigger === 'function') {
          try { synergyInstance.trigger(Object.assign({ event: 'dom:remove', id }, metaContext)); } catch (e) { /* ignore */ }
        }
        log(`Removed element: ${id}`);
        results.push({id, ok:true});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'remove', id, time: Date.now(), error:e, performance:{duration:(typeof performance !== 'undefined' ? performance.now() : Date.now())-start}, chapter: currentChapter()?.id || null};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        log(`Error removing element ${id}:`, e);
        results.push({id, ok:false, error:e});
      }
    }
    while (idx < ids.length) {
      while (active < concurrency && idx < ids.length) {
        const id = ids[idx++];
        const task = run(id).finally(() => { active--; queue.delete(task); });
        active++; queue.add(task);
      }
      if (queue.size > 0) await Promise.race(queue);
    }
    await Promise.all(queue);
    while (history.length > maxHistoryLength) history.shift();
    await _withAfterAll({ op: 'batchRemove', results });
    _fireGlobal('resolve', { type: 'batchRemove', count: results.length });
    return results;
  }

  // Animation support
  async function animate(id, keyframes, options = {}) {
    const el = registry.get(id)?.element;
    if (!el) throw createError('Element not registered', 'NO_ELEMENT', {id});
    return new Promise((resolve, reject) => {
      try {
        const animation = el.animate(keyframes, options);
        animation.onfinish = () => {
          log(`Animation finished for ${id}`);
          if (renderer && typeof renderer.onAnimationFinish === 'function') {
            try { renderer.onAnimationFinish(id, animation); } catch (e) {}
          }
          resolve(animation);
        };
        animation.oncancel = () => {
          log(`Animation cancelled for ${id}`);
          reject(createError('Animation cancelled', 'ANIMATION_CANCELLED', {id}));
        };
        log(`Animation started for ${id}`, keyframes, options);
      } catch (e) {
        reject(createError('Animation failed', 'ANIMATION_FAILED', {id, error: e}));
      }
    });
  }

  // Element relationships
  function getParent(id) {
    const el = registry.get(id)?.element;
    if (!el) return null;
    return Array.from(registry.entries()).find(([_, r]) => r.element === el.parentElement)?.[0] || null;
  }

  function getChildren(id) {
    const el = registry.get(id)?.element;
    if (!el) return [];
    return Array.from(el.children)
      .map(child => Array.from(registry.entries()).find(([_, r]) => r.element === child)?.[0])
      .filter(id => id);
  }

  function getSiblings(id) {
    const parentId = getParent(id);
    if (!parentId) return [];
    return getChildren(parentId).filter(siblingId => siblingId !== id);
  }

  // Batch query operations
  function queryElements(query) {
    return Array.from(document.querySelectorAll(query))
      .map(el => Array.from(registry.entries()).find(([_, r]) => r.element === el)?.[0])
      .filter(id => id);
  }

  function queryElementsByAttributes(attrs) {
    return Array.from(registry.entries())
      .filter(([_, r]) => {
        const el = r.element;
        return Object.entries(attrs).every(([k, v]) => el.getAttribute(k) === v);
      })
      .map(([id]) => id);
  }

  // Layout helpers / serialization awareness
  function computeLayout(id) {
    const el = registry.get(id)?.element;
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function computeLayoutAll() {
    const out = {};
    for (const id of registry.keys()) out[id] = computeLayout(id);
    return out;
  }

  // Query & introspection
  function getElement(id) { return registry.get(id)?.element; }
  function listElements() { return Array.from(registry.keys()); }
  function findByTag(tag) { return Array.from(registry.entries()).filter(([_, r]) => r.tags.includes(tag)).map(([id]) => id); }
  function getRegistry() { return Object.fromEntries(Array.from(registry.entries()).map(([id, r]) => [id, {...r}])); }
  function getAttributes(id) {
    const el = registry.get(id)?.element;
    if (!el) return {};
    return Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value]));
  }
  function getClasses(id) {
    const el = registry.get(id)?.element;
    if (!el) return [];
    return Array.from(el.classList);
  }
  function getStyles(id) {
    const el = registry.get(id)?.element;
    if (!el) return {};
    return Object.assign({}, el.style);
  }

  // Accessibility helpers
  function setAria(id, aria = {}) {
    const el = registry.get(id)?.element;
    if (!el) throw createError('Element not registered', 'NO_ELEMENT', {id});
    Object.entries(aria).forEach(([k, v]) => el.setAttribute(`aria-${k}`, v));
    log(`Set ARIA for ${id}`, aria);
  }
  function setRole(id, role) {
    const el = registry.get(id)?.element;
    if (!el) throw createError('Element not registered', 'NO_ELEMENT', {id});
    el.setAttribute('role', role);
    log(`Set role for ${id}: ${role}`);
  }
  function focus(id) {
    const el = registry.get(id)?.element;
    if (!el) throw createError('Element not registered', 'NO_ELEMENT', {id});
    el.focus();
    log(`Focused element: ${id}`);
  }

  // Custom event dispatch
  function dispatchEvent(id, type, detail) {
    const el = registry.get(id)?.element;
    if (!el) throw createError('Element not registered', 'NO_ELEMENT', {id});
    el.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    log(`Dispatched event: ${type} for ${id}`, detail);
  }

  // Event delegation with throttling
  function delegate(selector, event, handler, throttleMs = 0) {
    let timeout;
    const throttledHandler = e => {
      if (throttleMs && timeout) return;
      if (e.target.matches(selector)) {
        handler(e);
        if (throttleMs) timeout = setTimeout(() => timeout = null, throttleMs);
      }
    };
    document.addEventListener(event, throttledHandler);
    log(`Delegated event: ${event} for ${selector} with throttle ${throttleMs}ms`);
    return () => document.removeEventListener(event, throttledHandler);
  }

  // Mutation observation
  function observeMutations(target = document.body, config = { childList: true, subtree: true, attributes: true }) {
    if (observeActive) return;
    mutationObserver = new MutationObserver(muts => {
      muts.forEach(mutation => {
        mutationHooks.forEach(cb => cb(mutation));
        mutationHistory.push({mutation, time: Date.now()});
        while (mutationHistory.length > mutationHistoryCap) mutationHistory.shift();
        // emit conflict if a suspicious mutation occurs (simple heuristic)
        if (mutation.type === 'childList' && mutation.addedNodes && mutation.addedNodes.length > 50) {
          _fireGlobal('conflict', { type: 'mass-add', mutation });
        }
        log('Mutation observed:', mutation);
      });
    });
    mutationObserver.observe(target, config);
    observeActive = true;
    log('Mutation observation started');
  }
  function addMutationHook(callback) {
    mutationHooks.push(callback);
    return () => { mutationHooks.splice(mutationHooks.indexOf(callback), 1); };
  }
  function stopObservingMutations() {
    mutationObserver && mutationObserver.disconnect();
    observeActive = false;
    log('Mutation observation stopped');
  }
  function getMutationHistory(filter = {}) {
    let result = [...mutationHistory];
    if (filter.type) result = result.filter(e => e.mutation.type === filter.type);
    if (filter.maxAge) result = result.filter(e => e.time >= Date.now() - filter.maxAge);
    return result;
  }
  function setMutationHistoryCap(cap) {
    mutationHistoryCap = Math.max(0, cap);
    while (mutationHistory.length > mutationHistoryCap) mutationHistory.shift();
    log('Mutation history cap set:', mutationHistoryCap);
  }

  // State snapshot/restore (include layout if requested)
  function snapshot({ includeLayout = false } = {}) {
    return Array.from(registry.entries()).map(([id, r]) => ({
      id,
      tag: r.element.tagName,
      attrs: getAttributes(id),
      classes: getClasses(id),
      styles: getStyles(id),
      parentSelector: r.element.parentElement ? (r.element.parentElement.id || null) : null,
      tags: r.tags,
      meta: r.meta,
      layout: includeLayout ? computeLayout(id) : null
    }));
  }

  async function restore(snap) {
    if (!Array.isArray(snap)) return;
    // remove everything first (best-effort)
    await batchRemove(listElements());
    // create elements and reapply styles/layout when possible
    await batchCreate(snap.map(e => ({
      id: e.id,
      tag: e.tag,
      attrs: e.attrs,
      classes: e.classes,
      styles: e.styles,
      parent: e.parentSelector ? document.getElementById(e.parentSelector) : document.body,
      tags: e.tags,
      meta: e.meta
    })));
    // reapply layout if present (best-effort)
    for (const e of snap) {
      if (e.layout) {
        const el = getElement(e.id);
        if (el) {
          try {
            // attempt to position absolutely to match layout (best-effort)
            if (el.style) {
              el.style.position = el.style.position || 'absolute';
              el.style.left = `${Math.round(e.layout.left)}px`;
              el.style.top = `${Math.round(e.layout.top)}px`;
              el.style.width = `${Math.round(e.layout.width)}px`;
              el.style.height = `${Math.round(e.layout.height)}px`;
            }
          } catch (err) { /* ignore layout application errors */ }
        }
      }
    }
    log('Snapshot restored');
  }

  // Undo/redo
  async function undo() {
    if (!undoStack.length) return false;
    const op = undoStack.pop();
    redoStack.push(op);
    if (op.type === 'create') {
      await batchRemove([op.id]);
    } else if (op.type === 'remove') {
      await batchCreate([{
        id: op.id,
        tag: op.state.element.tagName,
        parent: op.state.parent,
        tags: op.state.tags,
        meta: op.state.meta
      }]);
    } else if (op.type === 'update') {
      await batchUpdate([{
        id: op.id,
        attrs: op.prevState.attrs,
        classes: op.prevState.classes,
        styles: op.prevState.styles
      }]);
    }
    log('Undo operation:', op);
    return true;
  }

  async function redo() {
    if (!redoStack.length) return false;
    const op = redoStack.pop();
    undoStack.push(op);
    if (op.type === 'create') {
      await batchCreate([{
        id: op.id,
        tag: op.tag,
        parent: op.parent
      }]);
    } else if (op.type === 'remove') {
      await batchRemove([op.id]);
    } else if (op.type === 'update') {
      log('Redo for update not fully implemented');
    }
    log('Redo operation:', op);
    return true;
  }

  // History access
  function getHistory(filter = {}) {
    let result = [...history];
    if (filter.op) result = result.filter(e => e.op === filter.op);
    if (filter.id) result = result.filter(e => e.id === filter.id);
    if (filter.maxAge) result = result.filter(e => e.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter(e => !!e.error);
    return result;
  }
  function clearHistory() { 
    history.length = 0; 
    undoStack.length = 0;
    redoStack.length = 0;
    log('History cleared');
  }
  function setHistoryCap(cap) {
    maxHistoryLength = Math.max(0, cap);
    while (history.length > maxHistoryLength) history.shift();
    log('History cap set:', maxHistoryLength);
  }

  // Performance metrics access
  function getPerformanceMetrics(id) {
    return performanceMetrics.get(id) || { opCount: 0, totalTime: 0, avgTime: 0 };
  }

  // Serialization helper (export registry + optional history/layout)
  function serialize({ includeHistory = true, includeLayout = false } = {}) {
    return JSON.stringify({
      registry: snapshot({ includeLayout }),
      history: includeHistory ? history.slice() : []
    });
  }

  function deserialize(serialized, { restoreLayout = false } = {}) {
    const obj = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!obj || !Array.isArray(obj.registry)) return { restored: 0 };
    restore(obj.registry); // best-effort, restore will handle layout if present
    if (obj.history && Array.isArray(obj.history)) {
      history.length = 0;
      obj.history.forEach(h => history.push(h));
    }
    return { restored: registry.size };
  }

  // Debug control
  function setDebug(val) { debug = !!val; }

  // Initialization
  function init() {
    observeMutations();
    log('DomEngine initialized');
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exported API
  return {
    // registry & basic ops
    register,
    unregister,
    // transactions
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    // hooks
    addHook,
    addGlobalHook,
    // batches & animation
    batchCreate,
    batchUpdate,
    batchRemove,
    animate,
    // relationships & queries
    getParent,
    getChildren,
    getSiblings,
    queryElements,
    queryElementsByAttributes,
    getElement,
    listElements,
    findByTag,
    getRegistry,
    getAttributes,
    getClasses,
    getStyles,
    // aria / focus / events
    setAria,
    setRole,
    focus,
    dispatchEvent,
    delegate,
    // mutation observation
    observeMutations,
    addMutationHook,
    stopObservingMutations,
    getMutationHistory,
    setMutationHistoryCap,
    // snapshot/restore/serialize
    snapshot,
    restore,
    serialize,
    deserialize,
    // undo/redo/history
    undo,
    redo,
    getHistory,
    clearHistory,
    setHistoryCap,
    // performance / debug
    getPerformanceMetrics,
    setDebug,
    // synergy & renderer bridges
    registerSynergy,
    setMetaContext,
    registerRenderer,
    requestRender,
    renderAll,
    // narrative
    startChapter,
    endChapter,
    getChapters,
    getProgress,
    // layout helpers
    computeLayout,
    computeLayoutAll,
    // internal (for testing/inspection)
    _internal: { registry, hooks, globalHooks, history, chapters }
  };
})();

export default DomEngine;
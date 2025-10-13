/**
 * domEngine.js - Ultra-Enhanced DOM Manipulation & Observation Engine
 * Enhanced Features:
 * - Transaction support (begin/commit/rollback)
 * - CSS animation handling with promises
 * - Element relationship navigation (parent/children/siblings)
 * - Batch query operations
 * - Detailed performance metrics
 * - Undo/redo support
 * - Event throttling
 * - Original features: element registry, batch operations, hooks, mutation observation, etc.
 */

const DomEngine = (() => {
  // Internal state
  const registry = new Map(); // id -> { element, tags, meta }
  const hooks = new Map();    // id -> { before:[], after:[], error:[] }
  const globalHooks = { before: [], after: [], error: [] };
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
    if (globalHooks[phase]) globalHooks[phase].push(callback);
    return () => { globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback); };
  }

  async function fireHooks(id, phase, payload) {
    for (const cb of globalHooks[phase]) {
      try { await cb({ id, payload }); } catch (e) { log(`Global ${phase} hook error`, e); }
    }
    if (hooks.has(id)) {
      for (const cb of hooks.get(id)[phase] || []) {
        try { await cb(payload); } catch (e) { log(`Hook error for ${id} (${phase})`, e); }
      }
    }
  }

  // Batch operations
  async function batchCreate(entries, options = {}) {
    const start = performance.now();
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
        register(id, el);
        await fireHooks(id, 'after', {id, element: el});
        const op = {op:'create', id, tag, time: Date.now(), error: null, performance:{duration:performance.now()-start}};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        trackPerformance(id, 'create', performance.now() - start);
        undoStack.push({ type: 'create', id, parent });
        redoStack.length = 0;
        log(`Created element: ${id}`, el);
        results.push({id, ok:true, element:el});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'create', id, tag, time: Date.now(), error:e, performance:{duration:performance.now()-start}};
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
    return results;
  }

  async function batchUpdate(updates, options = {}) {
    const start = performance.now();
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
        const op = {op:'update', id, time: Date.now(), error: null, performance:{duration:performance.now()-start}};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        trackPerformance(id, 'update', performance.now() - start);
        undoStack.push({ type: 'update', id, prevState });
        redoStack.length = 0;
        log(`Updated element: ${id}`, el);
        results.push({id, ok:true});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'update', id, time: Date.now(), error:e, performance:{duration:performance.now()-start}};
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
    return results;
  }

  async function batchRemove(ids, options = {}) {
    const start = performance.now();
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
        const op = {op:'remove', id, time: Date.now(), error: null, performance:{duration:performance.now()-start}};
        history.push(op);
        if (transaction) transaction.operations.push(op);
        trackPerformance(id, 'remove', performance.now() - start);
        undoStack.push({ type: 'remove', id, state });
        redoStack.length = 0;
        log(`Removed element: ${id}`);
        results.push({id, ok:true});
      } catch (e) {
        await fireHooks(id, 'error', {id, error:e});
        const op = {op:'remove', id, time: Date.now(), error:e, performance:{duration:performance.now()-start}};
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

  // State snapshot/restore
  function snapshot() {
    return Array.from(registry.entries()).map(([id, r]) => ({
      id,
      tag: r.element.tagName,
      attrs: getAttributes(id),
      classes: getClasses(id),
      styles: getStyles(id),
      parent: r.element.parentNode ? r.element.parentNode : null,
      tags: r.tags,
      meta: r.meta
    }));
  }
  async function restore(snap) {
    await batchRemove(listElements());
    await batchCreate(snap.map(e => ({
      id: e.id,
      tag: e.tag,
      attrs: e.attrs,
      classes: e.classes,
      styles: e.styles,
      parent: e.parent,
      tags: e.tags,
      meta: e.meta
    })));
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
      // Note: This assumes the update operation was stored with the new state
      // You may need to modify how updates are stored to support redo properly
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
    register,
    unregister,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    addHook,
    addGlobalHook,
    batchCreate,
    batchUpdate,
    batchRemove,
    animate,
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
    setAria,
    setRole,
    focus,
    dispatchEvent,
    delegate,
    observeMutations,
    addMutationHook,
    stopObservingMutations,
    getMutationHistory,
    setMutationHistoryCap,
    snapshot,
    restore,
    undo,
    redo,
    getHistory,
    clearHistory,
    setHistoryCap,
    getPerformanceMetrics,
    setDebug
  };
})();

export default DomEngine;
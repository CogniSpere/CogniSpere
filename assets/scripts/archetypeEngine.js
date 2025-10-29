/**
 * archetypeEngine.js - Uber Ultimate Adaptive Archetype Engine
 * Enhanced Features:
 * - Transaction support (begin/commit/rollback)
 * - Performance metrics tracking (per-archetype)
 * - Undo/redo support (exposed)
 * - Event throttling for synergy and meta hooks
 * - Batch validation of archetypes
 * - Automatic dependency resolution
 * - State versioning
 * - Global hook system utilities (add/remove/list)
 * - Validator/condition setters per archetype
 * - Serialization / introspection (serialize/deserialize/getIntrospection)
 * - Original features: contextual adaptation, hybrid archetypes, synergy, AI-driven behaviors, etc.
 */

const ArchetypeEngine = (() => {
  // Internal state
  const archetypes = new Map(); // name -> { meta, options, active, behaviors, dependencies, tags, aiAdapter, version }
  const hooks = new Map(); // name -> { before:[], after:[], error:[], meta:[] }
  const globalHooks = { before: [], after: [], error: [], meta: [] };
  const synergyHooks = []; // cross-archetype collaboration
  const history = [];
  let debug = false;
  let maxHistoryLength = 500;
  let transaction = null; // { operations: [], snapshot: null }
  const performanceMetrics = new Map(); // name -> { opCount, totalTime, avgTime, ops: { register: {...}, adapt: {...} } }
  const undoStack = [];
  const redoStack = [];

  // Debug logger
  function log(...args) { if (debug) console.log('[ArchetypeEngine]', ...args); }
  function trace(...args) { if (debug) console.trace('[ArchetypeEngine TRACE]', ...args); }

  // Structured error
  function createError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  // Performance helpers
  function _ensureMetrics(name) {
    if (!performanceMetrics.has(name)) performanceMetrics.set(name, { opCount: 0, totalTime: 0, avgTime: 0, ops: {} });
    return performanceMetrics.get(name);
  }
  function trackPerformance(name, op, duration) {
    if (!name) return;
    const metrics = _ensureMetrics(name);
    metrics.opCount++;
    metrics.totalTime += duration;
    metrics.avgTime = metrics.totalTime / metrics.opCount;
    metrics.ops[op] = metrics.ops[op] || { count: 0, totalTime: 0, avgTime: 0 };
    metrics.ops[op].count++;
    metrics.ops[op].totalTime += duration;
    metrics.ops[op].avgTime = metrics.ops[op].totalTime / metrics.ops[op].count;
  }

  // Archetype registration
  function register(name, behaviors = {}, options = {}, meta = {}) {
    if (typeof name !== 'string' || !name) throw createError('Archetype name must be non-empty string', 'INVALID_NAME');
    if (archetypes.has(name)) log(`Overwriting archetype: ${name}`);
    const defaults = {
      priority: 0,
      active: true,
      dependencies: [],
      tags: [],
      roles: [],
      validator: null,
      matcher: null,
      influence: null,
      condition: null,
      ariaLabel: null,
      description: '',
      aiAdapter: null,
      synergy: [],
      metaLevel: null,
      version: 1
    };
    const opts = Object.assign({}, defaults, options);
    archetypes.set(name, {
      behaviors: behaviors || {},
      options: opts,
      active: opts.active !== false,
      registered: Date.now(),
      meta: meta || {},
      version: opts.version || 1
    });
    // initialize metrics entry
    _ensureMetrics(name);
    log('Registered archetype:', name, opts, meta);
    // Activate dependencies
    for (const dep of opts.dependencies || []) {
      if (archetypes.has(dep) && !archetypes.get(dep).active) {
        setActive(dep, true);
        log(`Activated dependency ${dep} for ${name}`);
      }
    }
    const opStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    history.push({ op: 'register', name, time: Date.now(), error: null, performance: { duration: 0 } });
    trackPerformance(name, 'register', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - opStart);
    undoStack.push({ type: 'register', name });
    redoStack.length = 0;
  }

  // Batch registration (unchanged largely)
  async function batchRegister(entries, opts = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = opts;
    let idx = 0, active = 0;
    const results = [];
    const queue = new Set();
    async function run({ name, behaviors, options, meta }) {
      try {
        await fireHooks(name, 'before', { name, behaviors, options, meta });
        register(name, behaviors, options, meta);
        await fireHooks(name, 'after', { name });
        const op = { op: 'register', name, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
        history.push(op);
        if (transaction) transaction.operations.push(op);
        trackPerformance(name, 'register', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
        results.push({ name, ok: true });
      } catch (e) {
        await fireHooks(name, 'error', { name, error: e });
        const op = { op: 'register', name, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
        history.push(op);
        if (transaction) transaction.operations.push(op);
        results.push({ name, ok: false, error: e });
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

  // Unregister archetype
  function unregister(name) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const saved = archetypes.has(name) ? { ...archetypes.get(name) } : null;
      archetypes.delete(name);
      hooks.delete(name);
      performanceMetrics.delete(name);
      const op = { op: 'unregister', name, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
      history.push(op);
      if (transaction) transaction.operations.push(op);
      trackPerformance(name, 'unregister', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
      undoStack.push({ type: 'unregister', name, state: saved });
      redoStack.length = 0;
      log('Unregistered archetype:', name);
    } catch (e) {
      history.push({ op: 'unregister', name, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      throw e;
    }
  }

  // Activate/deactivate
  function setActive(name, state = true) {
    if (archetypes.has(name)) {
      archetypes.get(name).active = !!state;
      log('Archetype', name, 'active:', !!state);
    }
  }
  function toggleAllActive(state = true) {
    for (const name of archetypes.keys()) setActive(name, state);
    log('All archetypes active:', state);
  }

  // Hybrid archetypes
  function hybrid(names, newName, extraBehaviors = {}, extraOptions = {}, extraMeta = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const behaviors = {};
    const options = {};
    const meta = {};
    for (const name of names) {
      const arch = archetypes.get(name);
      if (!arch) throw createError(`Archetype not found: ${name}`, 'NOT_FOUND');
      Object.assign(behaviors, arch.behaviors);
      Object.assign(options, arch.options);
      Object.assign(meta, arch.meta);
    }
    Object.assign(behaviors, extraBehaviors);
    Object.assign(options, extraOptions);
    Object.assign(meta, extraMeta);
    options.synergy = [...(options.synergy || []), ...names];
    options.version = (options.version || 0) + 1;
    register(newName, behaviors, options, meta);
    const op = { op: 'hybrid', name: newName, sourceNames: names, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
    history.push(op);
    if (transaction) transaction.operations.push(op);
    trackPerformance(newName, 'hybrid', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    undoStack.push({ type: 'hybrid', name: newName, sourceNames: names });
    redoStack.length = 0;
    log(`Hybrid archetype ${newName} created from`, names);
  }

  // Cross-archetype synergy
  function addSynergyHook(callback, throttleMs = 0) {
    let timeout;
    const throttledCallback = async (...args) => {
      if (throttleMs && timeout) return;
      await callback(...args);
      if (throttleMs) timeout = setTimeout(() => timeout = null, throttleMs);
    };
    synergyHooks.push(throttledCallback);
    return () => { synergyHooks.splice(synergyHooks.indexOf(throttledCallback), 1); };
  }
  async function applySynergy(context = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const cb of synergyHooks) {
      try { 
        await cb(context, getRegistry()); 
        history.push({ op: 'synergy', context, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      } catch (e) { 
        log('Synergy hook error', e);
        history.push({ op: 'synergy', context, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      }
    }
  }

  // Hook system (global helpers)
  function addHook(name, phase, callback) {
    if (!hooks.has(name)) hooks.set(name, { before: [], after: [], error: [], meta: [] });
    hooks.get(name)[phase].push(callback);
    return () => { hooks.get(name)[phase] = hooks.get(name)[phase].filter(cb => cb !== callback); };
  }
  function addGlobalHook(phase, callback) {
    if (!globalHooks[phase]) throw new Error(`Unknown global hook phase: ${phase}`);
    globalHooks[phase].push(callback);
    return () => { globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback); };
  }
  function removeGlobalHook(phase, callback) {
    if (!globalHooks[phase]) return false;
    const idx = globalHooks[phase].indexOf(callback);
    if (idx >= 0) { globalHooks[phase].splice(idx, 1); return true; }
    return false;
  }
  function listGlobalHooks() {
    return Object.fromEntries(Object.keys(globalHooks).map(k => [k, globalHooks[k].slice()]));
  }
  async function fireHooks(name, phase, payload) {
    for (const cb of globalHooks[phase] || []) {
      try { await cb({ name, payload }); } catch (e) { log(`Global ${phase} hook error`, e); }
    }
    if (hooks.has(name)) {
      for (const cb of hooks.get(name)[phase] || []) {
        try { await cb(payload); } catch (e) { log(`Hook error for ${name} (${phase})`, e); }
      }
    }
  }
  function addMetaHook(name, callback, throttleMs = 0) {
    if (!hooks.has(name)) hooks.set(name, { before: [], after: [], error: [], meta: [] });
    const throttledCallback = async (...args) => {
      if (throttleMs && name in this && this[name].timeout) return;
      await callback(...args);
      if (throttleMs) this[name] = { timeout: setTimeout(() => delete this[name], throttleMs) };
    };
    hooks.get(name).meta.push(throttledCallback);
    return () => { hooks.get(name).meta = hooks.get(name).meta.filter(cb => cb !== throttledCallback); };
  }
  function addGlobalMetaHook(callback, throttleMs = 0) {
    const throttledCallback = async (...args) => {
      if (throttleMs && this.globalMetaTimeout) return;
      await callback(...args);
      if (throttleMs) this.globalMetaTimeout = setTimeout(() => delete this.globalMetaTimeout, throttleMs);
    };
    globalHooks.meta.push(throttledCallback);
    return () => { globalHooks.meta = globalHooks.meta.filter(cb => cb !== throttledCallback); };
  }
  async function fireMetaHooks(metaContext) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const cb of globalHooks.meta) {
      try { 
        await cb(metaContext, getRegistry()); 
        history.push({ op: 'meta-hook', metaContext, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      } catch (e) { 
        log('Global meta hook error', e);
        history.push({ op: 'meta-hook', metaContext, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      }
    }
    for (const [name, metaHooksArr] of hooks.entries()) {
      for (const cb of metaHooksArr.meta || []) {
        try { 
          await cb(metaContext, archetypes.get(name)); 
          history.push({ op: 'meta-hook', name, metaContext, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
        } catch (e) { 
          log(`Meta hook error for ${name}`, e);
          history.push({ op: 'meta-hook', name, metaContext, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
        }
      }
    }
  }

  // Adaptive behaviors
  async function adapt(name, context = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch) throw createError('Archetype not found', 'NOT_FOUND', { name });
    const adapter = arch.options.aiAdapter;
    if (typeof adapter === 'function') {
      try {
        const prevBehaviors = { ...arch.behaviors };
        arch.behaviors = await adapter(context, arch.behaviors, arch.options);
        arch.version = (arch.version || 0) + 1;
        log('Archetype adapted by AI:', name, arch.behaviors);
        const op = { op: 'adapt', name, context, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
        history.push(op);
        if (transaction) transaction.operations.push(op);
        trackPerformance(name, 'adapt', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
        undoStack.push({ type: 'adapt', name, prevBehaviors });
        redoStack.length = 0;
      } catch (e) {
        history.push({ op: 'adapt', name, context, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
        log(`AI adaptation error for ${name}:`, e);
        throw e;
      }
    }
  }

  // Meta-level interaction
  async function metaInteract(metaContext = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    await fireMetaHooks(metaContext);
    if (metaContext.spawnSuper) {
      const { name, behaviors, options, meta } = metaContext.spawnSuper;
      register(name, behaviors, options, meta);
      log('Super-archetype spawned:', name);
      const op = { op: 'meta-spawn', name, metaContext, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
      history.push(op);
      if (transaction) transaction.operations.push(op);
      trackPerformance(name, 'meta-spawn', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
      undoStack.push({ type: 'meta-spawn', name });
      redoStack.length = 0;
    }
  }

  // Influence/apply logic
  async function influence(name, context = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!archetypes.has(name)) throw createError('Archetype not found', 'NOT_FOUND', { name });
    const arch = archetypes.get(name);
    let result = null;
    try {
      await fireHooks(name, 'before', { name, context });
      await adapt(name, context);
      if (arch.options.synergy && arch.options.synergy.length) {
        for (const synergyName of arch.options.synergy) {
          await influence(synergyName, context);
        }
        await applySynergy(context);
      }
      if (arch.options.metaLevel && typeof arch.options.metaLevel === 'function') {
        await arch.options.metaLevel({ name, context, registry: getRegistry() });
      }
      if (arch.options.influence && typeof arch.options.influence === 'function') {
        result = await arch.options.influence(context, arch.behaviors);
      }
      Object.assign(context, arch.behaviors);
      await fireHooks(name, 'after', { name, context, result });
      const op = { op: 'influence', name, context, result, time: Date.now(), error: null, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } };
      history.push(op);
      if (transaction) transaction.operations.push(op);
      trackPerformance(name, 'influence', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
      undoStack.push({ type: 'influence', name, context });
      redoStack.length = 0;
      log('Influence applied:', name, context, result);
      return result;
    } catch (e) {
      await fireHooks(name, 'error', { name, context, error: e });
      history.push({ op: 'influence', name, context, result: null, time: Date.now(), error: e, performance: { duration: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start } });
      log(`Error influencing archetype ${name}:`, e);
      throw e;
    }
  }

  // Batch influence
  async function batchInfluence(names, context = {}, opts = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = opts;
    let idx = 0, active = 0;
    const results = {};
    const queue = new Set();
    async function run(name) {
      try {
        results[name] = await influence(name, context);
      } catch (e) {
        results[name] = { error: e };
      }
    }
    while (idx < names.length) {
      while (active < concurrency && idx < names.length) {
        const name = names[idx++];
        const task = run(name).finally(() => { active--; queue.delete(task); });
        active++; queue.add(task);
      }
      if (queue.size > 0) await Promise.race(queue);
    }
    await Promise.all(queue);
    trackPerformance('batchInfluence', 'batch', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    return results;
  }

  // Batch validation
  async function batchValidate(names, context = {}, opts = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const { concurrency = 5 } = opts;
    let idx = 0, active = 0;
    const results = [];
    const queue = new Set();
    async function run(name) {
      try {
        await validate(name, context);
        results.push({ name, valid: true });
      } catch (e) {
        results.push({ name, valid: false, error: e });
      }
    }
    while (idx < names.length) {
      while (active < concurrency && idx < names.length) {
        const name = names[idx++];
        const task = run(name).finally(() => { active--; queue.delete(task); });
        active++; queue.add(task);
      }
      if (queue.size > 0) await Promise.race(queue);
    }
    await Promise.all(queue);
    trackPerformance('batchValidate', 'batch', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    return results;
  }

  // Validator/matcher/condition
  async function validate(name, context = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch) throw createError('Archetype not found', 'NOT_FOUND', { name });
    if (arch?.options?.validator) {
      const valid = await arch.options.validator(context, arch.behaviors);
      if (!valid) throw createError(`Invalid archetype: ${name}`, 'INVALID', { context });
      trackPerformance(name, 'validate', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    }
    return true;
  }
  function match(name, value, matcher) {
    const arch = archetypes.get(name);
    if (matcher && typeof matcher === 'function') return matcher(name, value);
    if (arch?.options?.matcher) return arch.options.matcher(name, value);
    return name === value;
  }
  async function checkCondition(name, context = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (arch?.options?.condition) {
      const valid = await arch.options.condition(context, arch.behaviors);
      if (!valid) throw createError(`Condition failed: ${name}`, 'CONDITION_FAIL', { context });
      trackPerformance(name, 'condition', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
    }
    return true;
  }

  // Expose setters for validator/condition so external code can attach them cleanly
  function setValidator(name, fn) {
    if (!archetypes.has(name)) throw createError('Archetype not found', 'NOT_FOUND', { name });
    archetypes.get(name).options.validator = fn;
    return true;
  }
  function setCondition(name, fn) {
    if (!archetypes.has(name)) throw createError('Archetype not found', 'NOT_FOUND', { name });
    archetypes.get(name).options.condition = fn;
    return true;
  }

  // Accessibility helpers
  function setAria(name, aria = {}) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch?.meta?.element) throw createError('No element for archetype', 'NO_ELEMENT', { name });
    Object.entries(aria).forEach(([k, v]) => arch.meta.element.setAttribute(`aria-${k}`, v));
    log(`Set ARIA for archetype ${name}`, aria);
    trackPerformance(name, 'setAria', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
  }
  function setRole(name, role) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch?.meta?.element) throw createError('No element for archetype', 'NO_ELEMENT', { name });
    arch.meta.element.setAttribute('role', role);
    log(`Set role for archetype ${name}: ${role}`);
    trackPerformance(name, 'setRole', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
  }
  function focus(name) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch?.meta?.element) throw createError('No element for archetype', 'NO_ELEMENT', { name });
    arch.meta.element.focus();
    log(`Focused archetype element: ${name}`);
    trackPerformance(name, 'focus', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
  }

  // Custom event dispatch
  function dispatchEvent(name, type, detail) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const arch = archetypes.get(name);
    if (!arch?.meta?.element) throw createError('No element for archetype', 'NO_ELEMENT', { name });
    arch.meta.element.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    log(`Dispatched event: ${type} for archetype ${name}`, detail);
    trackPerformance(name, 'dispatchEvent', (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);
  }

  // Undo/redo (exposed)
  async function undo() {
    if (!undoStack.length) return false;
    const op = undoStack.pop();
    redoStack.push(op);
    if (op.type === 'register') {
      unregister(op.name);
    } else if (op.type === 'unregister') {
      const { name, state } = op;
      if (state) register(name, state.behaviors, state.options, state.meta);
    } else if (op.type === 'hybrid') {
      unregister(op.name);
    } else if (op.type === 'adapt') {
      const arch = archetypes.get(op.name);
      if (arch && op.prevBehaviors) {
        arch.behaviors = op.prevBehaviors;
        arch.version = (arch.version || 1) - 1;
      }
    } else if (op.type === 'meta-spawn') {
      unregister(op.name);
    } else if (op.type === 'influence') {
      log('Undo for influence not fully implemented');
    }
    log('Undo operation:', op);
    return true;
  }

  async function redo() {
    if (!redoStack.length) return false;
    const op = redoStack.pop();
    undoStack.push(op);
    if (op.type === 'register') {
      register(op.name, op.state?.behaviors, op.state?.options, op.state?.meta);
    } else if (op.type === 'unregister') {
      unregister(op.name);
    } else if (op.type === 'hybrid') {
      hybrid(op.sourceNames, op.name);
    } else if (op.type === 'adapt') {
      await adapt(op.name, op.context);
    } else if (op.type === 'meta-spawn') {
      const { name, behaviors, options, meta } = op.metaContext?.spawnSuper || {};
      if (name) register(name, behaviors, options, meta);
    } else if (op.type === 'influence') {
      await influence(op.name, op.context);
    }
    log('Redo operation:', op);
    return true;
  }

  // Introspection
  function getRegistry() { return Object.fromEntries(Array.from(archetypes.entries()).map(([name, meta]) => [name, { ...meta }])); }
  function listArchetypes() { return Array.from(archetypes.keys()); }
  function filterByTag(tag) {
    return Array.from(archetypes.entries()).filter(([_, meta]) => (meta.options || {}).tags && meta.options.tags.includes(tag)).map(([name]) => name);
  }
  function filterByRole(role) {
    return Array.from(archetypes.entries()).filter(([_, meta]) => (meta.options || {}).roles && meta.options.roles.includes(role)).map(([name]) => name);
  }
  function getDependencies(name) {
    const arch = archetypes.get(name);
    return arch?.options?.dependencies || [];
  }
  function getMeta(name) { return archetypes.get(name)?.meta; }
  function getOptions(name) { return archetypes.get(name)?.options; }
  function getBehaviors(name) { return archetypes.get(name)?.behaviors; }
  function getActive(name) { return archetypes.get(name)?.active; }
  function getVersion(name) { return archetypes.get(name)?.version || 1; }
  function validateAll() {
    return Array.from(archetypes.entries()).map(([name, meta]) => ({
      name, valid: !meta.options.validator || meta.options.validator({}, meta.behaviors)
    }));
  }
  function getPerformanceMetrics(name) {
    if (name) return performanceMetrics.get(name) || { opCount: 0, totalTime: 0, avgTime: 0, ops: {} };
    // all metrics
    return Object.fromEntries(Array.from(performanceMetrics.entries()).map(([k, v]) => [k, { ...v }]));
  }
  function getArchetypeMetrics(name) { return getPerformanceMetrics(name); }
  function getAllArchetypeMetrics() { return getPerformanceMetrics(); }

  // History access
  function getHistory(filter = {}) {
    let result = [...history];
    if (filter.op) result = result.filter(e => e.op === filter.op);
    if (filter.name) result = result.filter(e => e.name === filter.name);
    if (filter.maxAge) result = result.filter(e => e.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter(e => !!e.error);
    if (filter.tag) result = result.filter(e => archetypes.get(e.name)?.options?.tags?.includes(filter.tag));
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

  // Snapshot/restore & serialization
  function snapshot() {
    return Array.from(archetypes.entries()).map(([name, meta]) => ({
      name,
      behaviors: { ...meta.behaviors },
      options: { ...meta.options },
      meta: { ...meta.meta },
      active: meta.active,
      version: meta.version
    }));
  }
  async function restore(snap) {
    if (!Array.isArray(snap)) return;
    for (const { name } of snapshot()) unregister(name);
    await batchRegister(snap);
    log('Archetype snapshot restored');
  }
  function serialize({ includeHistory = true } = {}) {
    return JSON.stringify({
      archetypes: snapshot(),
      history: includeHistory ? history.slice() : [],
      metrics: Object.fromEntries(Array.from(performanceMetrics.entries()))
    });
  }
  function deserialize(serialized) {
    const obj = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!obj || !Array.isArray(obj.archetypes)) return { restored: 0 };
    restore(obj.archetypes);
    if (obj.history && Array.isArray(obj.history)) {
      history.length = 0;
      obj.history.forEach(h => history.push(h));
    }
    if (obj.metrics && typeof obj.metrics === 'object') {
      performanceMetrics.clear();
      for (const [k, v] of Object.entries(obj.metrics)) performanceMetrics.set(k, v);
    }
    return { restored: archetypes.size };
  }
  function getIntrospection() {
    return {
      archetypeCount: archetypes.size,
      hooks: { archetypeHooks: Array.from(hooks.keys()).length, globalHookPhases: Object.keys(globalHooks) },
      historyLength: history.length,
      metricsCount: performanceMetrics.size
    };
  }

  // Debug control
  function setDebug(val) { debug = !!val; }

  // Initialization
  function init() {
    register(
      'explorer',
      { search: ctx => log('Exploring', ctx) },
      { 
        priority: 10, 
        tags: ['explore', 'default'], 
        roles: ['user'], 
        description: 'Explorer archetype.',
        aiAdapter: (context, behaviors, options) => {
          if (context.trend === 'fast') behaviors.search = ctx => log('Fast exploring', ctx);
          return behaviors;
        },
        synergy: ['observer'],
        metaLevel: ({ name, context, registry }) => {
          log(`Meta-level triggered for ${name}`, context);
          if (context.triggerSuper) {
            registry['super-explorer'] = {
              behaviors: { superSearch: ctx => log('Super exploring', ctx) },
              options: { tags: ['super'], description: 'Super explorer spawned.', version: 1 },
              meta: {},
              active: true,
              registered: Date.now(),
              version: 1
            };
          }
        }
      },
      { element: null }
    );
    register(
      'observer',
      { watch: ctx => log('Observing', ctx) },
      { priority: 5, tags: ['observe', 'default'], roles: ['user'], description: 'Observer archetype.', version: 1 },
      { element: null }
    );
    hybrid(['explorer', 'observer'], 'hybrid-explorver', 
      { hybridAct: ctx => log('Hybrid acting', ctx) }, 
      { tags: ['hybrid'], version: 1 }, 
      {}
    );
    log('ArchetypeEngine initialized');
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exported API
  return {
    register,
    batchRegister,
    unregister,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    setActive,
    toggleAllActive,
    hybrid,
    addSynergyHook,
    applySynergy,
    addHook,
    addGlobalHook,
    removeGlobalHook,
    listGlobalHooks,
    addMetaHook,
    addGlobalMetaHook,
    fireMetaHooks,
    adapt,
    metaInteract,
    influence,
    batchInfluence,
    batchValidate,
    validate,
    match,
    checkCondition,
    setValidator,
    setCondition,
    setAria,
    setRole,
    focus,
    dispatchEvent,
    getRegistry,
    listArchetypes,
    filterByTag,
    filterByRole,
    getDependencies,
    getMeta,
    getOptions,
    getBehaviors,
    getActive,
    getVersion,
    validateAll,
    getPerformanceMetrics: getArchetypeMetrics,
    getAllArchetypeMetrics,
    getHistory,
    clearHistory,
    setHistoryCap,
    snapshot,
    restore,
    serialize,
    deserialize,
    getIntrospection,
    undo,
    redo,
    setDebug
  };
})();
export default ArchetypeEngine;
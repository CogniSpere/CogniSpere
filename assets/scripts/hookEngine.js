/**
 * hookEngine.js - Ultimate Modular Hook System (Enhanced)
 * 
 * Features:
 * - Rate limiting for triggers
 * - Hook versioning
 * - Metrics collection (execution count, avg time, error count)
 * - Conditional hooks based on payload
 * - Parallel batch trigger execution
 * - Auto-cleanup of expired hooks
 * - Enhanced global hooks with async support
 * - Logging levels (debug, info, error)
 * - Maintains all previous features
 */

/**
 * @typedef {Object} HookMeta
 * @property {string} [category]
 * @property {string[]} [dependencies]
 * @property {number} [timeout]
 * @property {Object} [custom]
 * @property {number} [version]
 * @property {number} [expires]
 * @property {number} [rateLimit]
 * @property {Function} [condition]
 */

/**
 * @typedef {Object} HookEntry
 * @property {Function} callback
 * @property {number} priority
 * @property {HookMeta} meta
 * @property {number} [lastCalled]
 * @property {number} [callCount]
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} hookName
 * @property {HookMeta} meta
 * @property {Object} payload
 * @property {any} [result]
 * @property {number} time
 * @property {HookError} [error]
 * @property {{duration: number}} [performance]
 */

/**
 * @typedef {Object} HookError
 * @property {string} message
 * @property {string} code
 * @property {any} [details]
 */

/**
 * @typedef {Object} Metrics
 * @property {number} executionCount
 * @property {number} averageTime
 * @property {number} errorCount
 */

const HookEngine = (() => {
  const hooks = new Map();
  const hookHistory = [];
  const globalHooks = { before: [], after: [], error: [] };
  const metrics = new Map();

  let logLevel = 'info'; // debug | info | error
  let historyCap = 500;

  // Logging
  function logger(level, ...args) {
    if (
      logLevel === 'debug' ||
      (logLevel === 'info' && level !== 'debug') ||
      (logLevel === 'error' && level === 'error')
    ) {
      console[level === 'error' ? 'error' : 'log']('[HookEngine]', ...args);
    }
  }

  const log = (...args) => logger('info', ...args);
  const debug = (...args) => logger('debug', ...args);
  const error = (...args) => logger('error', ...args);

  function setLogLevel(level) {
    if (['debug', 'info', 'error'].includes(level)) {
      logLevel = level;
      log('Log level set to', level);
    }
  }

  // Structured error creation
  function createError(message, code, details) {
    const err = new Error(message);
    err.code = code;
    err.details = details;
    return err;
  }

  // Metrics handling
  function updateMetrics(hookName, duration, isError = false) {
    if (!metrics.has(hookName)) {
      metrics.set(hookName, { executionCount: 0, averageTime: 0, errorCount: 0 });
    }
    const m = metrics.get(hookName);
    m.executionCount++;
    m.averageTime = (m.averageTime * (m.executionCount - 1) + duration) / m.executionCount;
    if (isError) m.errorCount++;
  }

  const getMetrics = (hookName) => metrics.get(hookName) || { executionCount: 0, averageTime: 0, errorCount: 0 };

  // Register a hook
  function register(hookName, callback, { priority = 0, meta = {} } = {}) {
    if (typeof hookName !== 'string' || !hookName)
      throw createError('hookName must be a non-empty string', 'INVALID_HOOK_NAME');
    if (typeof callback !== 'function')
      throw createError('callback must be a function', 'INVALID_CALLBACK');

    if (!hooks.has(hookName)) hooks.set(hookName, []);
    const entry = { callback, priority, meta, callCount: 0 };
    hooks.get(hookName).push(entry);
    hooks.get(hookName).sort((a, b) => b.priority - a.priority);

    debug('Registered hook:', hookName, entry);
    return () => deregister(hookName, callback);
  }

  // Deregister single hook
  function deregister(hookName, callback) {
    if (!hooks.has(hookName)) return;
    hooks.set(hookName, hooks.get(hookName).filter((cb) => cb.callback !== callback));
    if (hooks.get(hookName).length === 0) hooks.delete(hookName);
    debug('Deregistered hook:', hookName);
  }

  // Batch deregister
  function batchDeregister(filterFn) {
    for (const [hookName, entries] of hooks.entries()) {
      hooks.set(hookName, entries.filter((entry) => !filterFn(entry.meta, hookName)));
      if (hooks.get(hookName).length === 0) hooks.delete(hookName);
    }
    log('Batch deregister completed');
  }

  // Global hooks
  function addGlobalHook(phase, callback) {
    if (globalHooks[phase]) globalHooks[phase].push(callback);
    return () => {
      globalHooks[phase] = globalHooks[phase].filter((cb) => cb !== callback);
    };
  }

  // Async execution with timeout
  async function executeWithTimeout(promise, timeout) {
    if (!timeout) return promise;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(createError('Hook timed out', 'TIMEOUT', { timeout })), timeout)
    );
    return Promise.race([promise, timeoutPromise]);
  }

  // Dependency validation
  function validateDependencyGraph() {
    const visited = new Set();
    const stack = new Set();

    function visit(name) {
      if (!hooks.has(name)) return false;
      if (stack.has(name)) return true;
      if (visited.has(name)) return false;

      visited.add(name);
      stack.add(name);

      for (const entry of hooks.get(name)) {
        for (const dep of entry.meta.dependencies || []) {
          if (visit(dep)) return true;
        }
      }
      stack.delete(name);
      return false;
    }

    for (const name of hooks.keys()) {
      if (visit(name)) throw createError('Circular dependency detected', 'CIRCULAR_DEPENDENCY', { name });
    }
    return true;
  }

  // Rate limiting
  function checkRateLimit(entry) {
    if (!entry.meta.rateLimit) return;
    const now = Date.now();
    if (entry.lastCalled && now - entry.lastCalled < 60000 / entry.meta.rateLimit) {
      throw createError('Rate limit exceeded', 'RATE_LIMIT', { rateLimit: entry.meta.rateLimit });
    }
    entry.lastCalled = now;
  }

  // Conditional hook check
  async function checkCondition(entry, payload) {
    if (entry.meta.condition) {
      try {
        return await entry.meta.condition(payload);
      } catch (e) {
        debug('Condition check error:', e);
        return false;
      }
    }
    return true;
  }

  // Expiration cleanup
  function cleanupExpired() {
    const now = Date.now();
    for (const [name, entries] of hooks.entries()) {
      hooks.set(
        name,
        entries.filter((entry) => !entry.meta.expires || entry.meta.expires > now)
      );
      if (hooks.get(name).length === 0) hooks.delete(name);
    }
    debug('Expired hooks cleaned');
  }

  // Trigger single hook
  async function trigger(hookName, payload = {}) {
    cleanupExpired();
    if (typeof hookName !== 'string' || !hookName)
      throw createError('hookName must be a non-empty string', 'INVALID_HOOK_NAME');

    const callbacks = hooks.get(hookName) || [];
    const results = [];
    const startTime = performance.now();

    // Dependency validation
    for (const entry of callbacks) {
      for (const dep of entry.meta.dependencies || []) {
        if (!hooks.has(dep)) throw createError(`Missing dependency ${dep}`, 'MISSING_DEPENDENCY', { hookName });
      }
    }

    for (const cb of globalHooks.before) {
      try {
        await cb({ hookName, payload });
      } catch (e) {
        error('Global before hook error:', e);
      }
    }

    for (const entry of callbacks) {
      const t0 = performance.now();
      try {
        checkRateLimit(entry);
        if (!(await checkCondition(entry, payload))) continue;

        const result = await executeWithTimeout(entry.callback(payload), entry.meta.timeout);
        const duration = performance.now() - t0;

        results.push(result);
        hookHistory.push({
          hookName,
          meta: entry.meta,
          payload,
          result,
          time: Date.now(),
          error: null,
          performance: { duration },
        });
        updateMetrics(hookName, duration);
      } catch (e) {
        const duration = performance.now() - t0;
        error(`Error in hook ${hookName}:`, e);
        hookHistory.push({
          hookName,
          meta: entry.meta,
          payload,
          result: null,
          time: Date.now(),
          error: e,
          performance: { duration },
        });
        updateMetrics(hookName, duration, true);
        for (const gErr of globalHooks.error) {
          try {
            await gErr({ hookName, error: e, payload });
          } catch (ee) {
            error('Global error hook error:', ee);
          }
        }
        dispatchEvent('hook:error', { hookName, error: e, payload });
      }
    }

    for (const cb of globalHooks.after) {
      try {
        await cb({ hookName, payload, results });
      } catch (e) {
        error('Global after hook error:', e);
      }
    }

    while (hookHistory.length > historyCap) hookHistory.shift();
    return results;
  }

  // Batch trigger (parallel)
  async function batchTrigger(triggers, batchTimeout = 0) {
    cleanupExpired();
    const startTime = performance.now();
    const results = {};
    let timedOut = false;

    const tasks = triggers.map(async ({ hookName, payload = {} }) => {
      try {
        results[hookName] = await trigger(hookName, payload);
      } catch (e) {
        results[hookName] = { error: e };
      }
    });

    if (batchTimeout) {
      await Promise.race([
        Promise.all(tasks),
        new Promise((_, reject) =>
          setTimeout(() => {
            timedOut = true;
            reject(createError('Batch trigger timed out', 'BATCH_TIMEOUT', { batchTimeout }));
          }, batchTimeout)
        ),
      ]);
    } else {
      await Promise.all(tasks);
    }

    log('Batch trigger completed', { count: triggers.length, timedOut, duration: performance.now() - startTime });
    return results;
  }

  // Dispatch event
  function dispatchEvent(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    debug('Dispatched event:', type, detail);
  }

  // Listing and filtering
  const listHooks = () => Array.from(hooks.keys());
  const findHooksByMeta = (filterFn) =>
    Array.from(hooks.entries())
      .filter(([_, cbs]) => cbs.some((cb) => filterFn(cb.meta)))
      .map(([name]) => name);

  const listHooksByCategory = (cat) => findHooksByMeta((m) => m.category === cat);
  const listHooksByDependency = (dep) => findHooksByMeta((m) => (m.dependencies || []).includes(dep));
  const listHooksByVersion = (v) => findHooksByMeta((m) => m.version === v);

  // History
  function getHistory(filter = {}) {
    let result = [...hookHistory];
    if (filter.category) result = result.filter((e) => e.meta.category === filter.category);
    if (filter.hookName) result = result.filter((e) => e.hookName === filter.hookName);
    if (filter.maxAge) result = result.filter((e) => e.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter((e) => !!e.error);
    if (filter.predicate) result = result.filter(filter.predicate);
    return result;
  }

  const clearHistory = () => {
    hookHistory.length = 0;
    debug('Hook history cleared');
  };

  function setHistoryCap(cap) {
    if (cap < 0) throw createError('History cap must be non-negative', 'INVALID_HISTORY_CAP');
    historyCap = cap;
    while (hookHistory.length > historyCap) hookHistory.shift();
    log('History cap set:', historyCap);
  }

  // Full clear
  const clear = () => {
    hooks.clear();
    debug('Cleared all hooks');
  };

  return {
    register,
    deregister,
    batchDeregister,
    addGlobalHook,
    trigger,
    batchTrigger,
    listHooks,
    findHooksByMeta,
    listHooksByCategory,
    listHooksByDependency,
    listHooksByVersion,
    getHistory,
    clearHistory,
    setHistoryCap,
    getMetrics,
    setLogLevel,
    clear,
  };
})();

export default HookEngine;

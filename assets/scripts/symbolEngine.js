/**
 * symbolEngine.js - Ultra-Enhanced Symbolic Pattern Engine (Grok + Copilot)
 * Features:
 * - Priority, metadata, validator, matcher per pattern
 * - Pattern activation/deactivation (per-pattern, global)
 * - Global and per-pattern hooks (before/after/error, unregisterable)
 * - Batch apply: async, concurrency, error handling, per-pattern/context results
 * - History: structured, filterable, capped, errors, durations, tags
 * - Introspection: pattern listing, priorities, tags, validation
 * - Structured error events (DOM)
 * - Debug/trace logging
 * - Maintains all previous features
 */

/**
 * @typedef {Object} SymbolOptions
 * @property {number} [priority=0]
 * @property {Function} [matcher]
 * @property {Function} [validator]
 * @property {boolean} [active=true]
 * @property {string[]} [tags]
 * @property {string} [description]
 */

/**
 * @typedef {Object} PatternMeta
 * @property {Function} logic
 * @property {SymbolOptions} options
 * @property {boolean} active
 * @property {number} registered
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} pattern
 * @property {Object} context
 * @property {any} [result]
 * @property {number} time
 * @property {SymbolError} [error]
 * @property {{duration: number}} [performance]
 * @property {string[]} [tags]
 */

/**
 * @typedef {Object} SymbolError
 * @property {string} message
 * @property {string} code
 * @property {any} [details]
 * @property {string} [pattern]
 * @property {Object} [context]
 */

const SymbolEngine = (() => {
  const symbols = new Map();
  const hooks = new Map();
  const globalHooks = { before: [], after: [], error: [] };
  const applyHistory = [];
  let active = true;
  let debug = false;
  let maxHistoryLength = 500;

  // Debug logger
  function log(...args) {
    if (debug) console.log('[SymbolEngine]', ...args);
  }

  // Trace logger
  function trace(...args) {
    if (debug) console.trace('[SymbolEngine]', ...args);
  }

  // Structured error
  function createError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  // Register symbol pattern
  /**
   * @param {string} pattern
   * @param {Function} logic
   * @param {SymbolOptions} [options]
   * @param {Object} [meta]
   */
  function register(pattern, logic, options = {}, meta = {}) {
    if (typeof pattern !== 'string' || !pattern) throw createError('pattern must be a non-empty string', 'INVALID_PATTERN');
    if (typeof logic !== 'function') throw createError('logic must be a function', 'INVALID_LOGIC');
    if (options.validator && typeof options.validator === 'function' && !options.validator(pattern)) {
      throw createError('Pattern validation failed', 'INVALID_PATTERN_VALIDATION');
    }
    symbols.set(pattern, {
      logic,
      options: Object.assign({ priority: 0, active: true }, options),
      active: options.active !== false,
      registered: Date.now(),
      meta
    });
    log('Registered symbol:', pattern, options, meta);
  }

  // Unregister pattern
  function unregister(pattern) {
    symbols.delete(pattern);
    hooks.delete(pattern);
    log('Unregistered symbol:', pattern);
  }

  // Activate/deactivate pattern (individual)
  function setPatternActive(pattern, state = true) {
    if (symbols.has(pattern)) {
      symbols.get(pattern).active = !!state;
      log('Pattern', pattern, 'active:', !!state);
    }
  }

  // Add per-pattern hook
  function addHook(pattern, phase, callback) {
    if (!hooks.has(pattern)) hooks.set(pattern, { before: [], after: [], error: [] });
    hooks.get(pattern)[phase].push(callback);
    return () => {
      hooks.get(pattern)[phase] = hooks.get(pattern)[phase].filter(cb => cb !== callback);
    };
  }

  // Add global hook
  function addGlobalHook(phase, callback) {
    if (globalHooks[phase]) globalHooks[phase].push(callback);
    return () => { globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback); };
  }

  // Fire hooks
  async function fireHooks(pattern, phase, payload) {
    for (const cb of globalHooks[phase]) {
      try { await cb(payload); } catch (e) { log(`Global ${phase} hook error`, e); }
    }
    if (hooks.has(pattern)) {
      for (const cb of hooks.get(pattern)[phase] || []) {
        try { await cb(payload); } catch (e) { log(`Hook error for ${pattern} (${phase})`, e); }
      }
    }
  }

  // Match patterns
  function matchPattern(pattern, value, customMatcher) {
    if (customMatcher && typeof customMatcher === 'function') {
      try { return customMatcher(pattern, value); }
      catch (e) { log('Custom matcher error:', pattern, e); return false; }
    }
    if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try { return new RegExp(pattern.slice(1, -1)).test(value); }
      catch (e) { log('Invalid RegExp pattern:', pattern, e); return false; }
    }
    return pattern === value;
  }

  // Apply symbolic logic (per context)
  /**
   * @param {Object} [context]
   * @returns {Promise<Object>} results per pattern
   */
  async function apply(context = {}) {
    if (!active) return {};
    const startTime = performance.now();
    const value = context.archetype || context.intent || context.type || '';
    const results = {};
    const sortedSymbols = Array.from(symbols.entries())
      .filter(([, meta]) => meta.active)
      .sort(([, a], [, b]) => (b.options.priority || 0) - (a.options.priority || 0));

    for (const [pattern, { logic, options, meta }] of sortedSymbols) {
      if (matchPattern(pattern, value, options.matcher)) {
        let error = undefined;
        try {
          await fireHooks(pattern, 'before', { context, pattern });
          const result = await logic(context);
          await fireHooks(pattern, 'after', { context, pattern, result });
          results[pattern] = result;
          log(`Applied symbol: ${pattern}`, context);
          applyHistory.push({
            pattern,
            context,
            result,
            time: Date.now(),
            error: null,
            performance: { duration: performance.now() - startTime },
            tags: options.tags || (meta && meta.tags) || []
          });
        } catch (e) {
          error = createError(`Error applying symbol ${pattern}`, 'APPLY_ERROR', { error: e });
          await fireHooks(pattern, 'error', { context, pattern, error });
          log(`Error applying symbol ${pattern}:`, error);
          applyHistory.push({
            pattern,
            context,
            result: null,
            time: Date.now(),
            error,
            performance: { duration: performance.now() - startTime },
            tags: options.tags || (meta && meta.tags) || []
          });
          // Fire structured error event for integrations
          dispatchEvent('symbol:error', { pattern, context, error });
        }
        while (applyHistory.length > maxHistoryLength) applyHistory.shift();
      }
    }
    return results;
  }

  // Batch apply contexts (async, concurrency, error handling)
  /**
   * @param {Object[]} contexts
   * @param {Object} [options]
   * @param {number} [options.concurrency=5]
   * @param {boolean} [options.stopOnError=false]
   * @returns {Promise<Object>} results per context, per pattern
   */
  async function batchApply(contexts, options = {}) {
    const startTime = performance.now();
    const { concurrency = 5, stopOnError = false } = options;
    const results = {};
    let errorCount = 0;
    let activeTasks = 0;
    let idx = 0;

    async function processContext(context) {
      try {
        const res = await apply(context);
        results[JSON.stringify(context)] = res;
      } catch (err) {
        results[JSON.stringify(context)] = { error: err };
        errorCount++;
        if (stopOnError) throw err;
      }
    }

    // Simple concurrency control
    const queue = [];
    while (idx < contexts.length) {
      while (activeTasks < concurrency && idx < contexts.length) {
        activeTasks++;
        const context = contexts[idx++];
        queue.push(processContext(context).finally(() => { activeTasks--; }));
      }
      await Promise.race(queue);
    }
    await Promise.all(queue);

    log('Batch apply completed', { count: contexts.length, errors: errorCount, duration: performance.now() - startTime });
    dispatchEvent('symbol:batchApplied', { count: contexts.length, errors: errorCount, duration: performance.now() - startTime });
    return results;
  }

  // Dispatch structured error event
  function dispatchEvent(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    log('Dispatched event:', type, detail);
  }

  // Activate/deactivate engine (global)
  function toggleActive(state = true) {
    active = !!state;
    log('SymbolEngine global active:', active);
  }

  // Set history cap
  function setHistoryCap(cap) {
    maxHistoryLength = Math.max(0, cap);
    while (applyHistory.length > maxHistoryLength) applyHistory.shift();
    log('History cap set:', maxHistoryLength);
  }

  // Registry and history
  function getRegistry() {
    return Object.fromEntries(Array.from(symbols.entries()).map(([pattern, meta]) => [pattern, { ...meta }]));
  }

  function getPatterns() {
    return Array.from(symbols.keys());
  }

  function getPatternMeta(pattern) {
    return symbols.get(pattern);
  }

  function getPriorities() {
    return Array.from(symbols.entries()).map(([pattern, meta]) => ({ pattern, priority: meta.options.priority || 0 }));
  }

  function filterPatternsByTag(tag) {
    return Array.from(symbols.entries()).filter(([, meta]) =>
      (meta.options.tags || []).includes(tag)
    ).map(([pattern]) => pattern);
  }

  function validateAllPatterns() {
    return Array.from(symbols.entries()).map(([pattern, meta]) => ({
      pattern,
      valid: !meta.options.validator || meta.options.validator(pattern)
    }));
  }

  /**
   * @param {{pattern?: string, maxAge?: number, errorOnly?: boolean, tag?: string}} [filter]
   * @returns {HistoryEntry[]}
   */
  function getHistory(filter = {}) {
    let result = [...applyHistory];
    if (filter.pattern) result = result.filter(entry => entry.pattern === filter.pattern);
    if (filter.maxAge) result = result.filter(entry => entry.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter(entry => !!entry.error);
    if (filter.tag) result = result.filter(entry => entry.tags && entry.tags.includes(filter.tag));
    return result;
  }

  function clearHistory() {
    applyHistory.length = 0;
    log('Apply history cleared');
  }

  function unregisterHook(pattern, phase, callback) {
    if (hooks.has(pattern)) {
      hooks.get(pattern)[phase] = hooks.get(pattern)[phase].filter(cb => cb !== callback);
    }
  }

  function unregisterGlobalHook(phase, callback) {
    globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback);
  }

  // Debug
  function setDebug(val) {
    debug = !!val;
  }

  // Demo/init: register default symbols with metadata
  function init() {
    register(
      'explorer*',
      ctx => { log('Explorer mode activated', ctx); },
      { priority: 10, tags: ['explore', 'default'], description: 'For explorer archetypes.' }
    );
    register(
      'observer',
      ctx => { log('Observer mode activated', ctx); },
      { priority: 5, tags: ['observe', 'default'], description: 'For observer archetypes.' }
    );
    toggleActive(true);
    log('SymbolEngine initialized');
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    register,
    unregister,
    setPatternActive,
    addHook,
    addGlobalHook,
    unregisterHook,
    unregisterGlobalHook,
    apply,
    batchApply,
    toggleActive,
    setDebug,
    getRegistry,
    getPatterns,
    getPatternMeta,
    getPriorities,
    filterPatternsByTag,
    validateAllPatterns,
    getHistory,
    clearHistory,
    setHistoryCap
  };
})();

export default SymbolEngine;
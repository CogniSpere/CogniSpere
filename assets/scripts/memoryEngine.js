/**
 * memoryEngine.js - Advanced Symbolic Memory Engine
 * Features:
 * - Memory validation with custom validators
 * - Performance monitoring
 * - Batch store/recall operations
 * - Compressed persistence
 * - Structured error handling
 * - JSDoc type safety
 * - Configurable history cap
 * - Memory expiration
 * - Maintains all previous features
 */

/**
 * @typedef {Object} MemoryOptions
 * @property {boolean} [persist=false] - Whether to persist memory
 * @property {boolean} [compress=false] - Whether to compress persisted data
 * @property {Function} [validator] - Custom validator for memory value
 * @property {number} [expires] - Expiration time in ms
 * @property {string} [ariaLabel] - ARIA label for accessibility
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {'store'|'recall'|'forget'|'load'} op
 * @property {string} key
 * @property {any} [value]
 * @property {boolean} [persist]
 * @property {number} time
 * @property {MemoryError} [error]
 * @property {{duration: number}} [performance]
 */

/**
 * @typedef {Object} MemoryError
 * @property {string} message
 * @property {string} code
 * @property {any} [details]
 */

/**
 * @typedef {Object} BatchEntry
 * @property {string} key
 * @property {any} value
 * @property {MemoryOptions} [options]
 */

const MemoryEngine = (() => {
  const memory = new Map();
  let storage = sessionStorage;
  const hooks = new Map();
  const memoryHistory = [];
  let debug = false;
  let maxHistoryLength = 300;
  const eventPrefix = 'memory:';

  // Debug logger
  function log(...args) {
    if (debug) console.log('[MemoryEngine]', ...args);
  }
  // chatgpt add
  function setDebug(enable = true) {
  debug = enable;
  log('Debug mode:', enable ? 'ON' : 'OFF');
}

  // Create structured error
  function createError(message, code, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  // Set storage mode
  /**
   * @param {boolean} [useLocal=false]
   */
  function setStorage(useLocal = false) {
    storage = useLocal ? localStorage : sessionStorage;
    log('Storage mode set:', useLocal ? 'localStorage' : 'sessionStorage');
  }

  // Compress/decompress for persistence
  function compress(value) {
    return btoa(JSON.stringify(value));
  }

  function decompress(value) {
    return JSON.parse(atob(value));
  }

  // Validate memory
  async function validateMemory(key, value, validator) {
    if (validator) {
      try {
        const valid = await validator(value);
        if (!valid) throw createError(`Invalid memory value for ${key}`, 'INVALID_VALUE');
        return true;
      } catch (e) {
        log(`Validation error for ${key}:`, e);
        throw e;
      }
    }
    return true;
  }

  // Check expiration
  function checkExpiration(key, expires) {
    const entry = memory.get(key);
    if (entry?.expires && Date.now() > entry.expires) {
      forget(key);
      return true;
    }
    return false;
  }

  // Add hook
  /**
   * @param {string} key
   * @param {'before'|'after'|'error'} phase
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  function addHook(key, phase, callback) {
    if (!hooks.has(key)) hooks.set(key, { before: [], after: [], error: [] });
    hooks.get(key)[phase].push(callback);
    return () => {
      hooks.get(key)[phase] = hooks.get(key)[phase].filter(cb => cb !== callback);
    };
  }

  // Fire hooks
  async function fireHooks(key, phase, payload) {
    if (hooks.has(key)) {
      for (const cb of hooks.get(key)[phase] || []) {
        try { await cb(payload); } catch (e) { log(`Hook error for ${key} (${phase})`, e); }
      }
    }
  }

  // Store memory
  /**
   * @param {string} key
   * @param {any} value
   * @param {MemoryOptions} [options]
   */
  async function store(key, value, options = {}) {
    const startTime = performance.now();
    const { persist = false, compress: shouldCompress = false, validator, expires, ariaLabel } = options;
    
    try {
      await validateMemory(key, value, validator);
      await fireHooks(key, 'before', { key, value, persist });
      
      memory.set(key, { value, expires: expires ? Date.now() + expires : undefined });
      memoryHistory.push({ 
        op: 'store', 
        key, 
        value, 
        persist, 
        time: Date.now(), 
        error: null,
        performance: { duration: performance.now() - startTime }
      });
      if (memoryHistory.length > maxHistoryLength) memoryHistory.shift();
      
      if (persist) {
        const storedValue = shouldCompress ? compress(value) : JSON.stringify(value);

        storage.setItem(`memory:${key}`, storedValue);
      }
      
      if (ariaLabel) document.body.setAttribute('aria-label', ariaLabel);
      dispatchEvent(`${eventPrefix}stored`, { key, value, persist });
      await fireHooks(key, 'after', { key, value, persist });
      log('Stored memory:', key, value, persist ? '(persisted)' : '');
      
      if (ariaLabel) document.body.removeAttribute('aria-label');
    } catch (e) {
      const error = createError(`Error storing memory ${key}`, 'STORE_ERROR', { error: e });
      log(`Error storing memory ${key}:`, error);
      await fireHooks(key, 'error', { key, value, persist, error });
      dispatchEvent(`${eventPrefix}error`, { key, value, error });
      memoryHistory.push({ 
        op: 'store', 
        key, 
        value, 
        persist, 
        time: Date.now(), 
        error,
        performance: { duration: performance.now() - startTime }
      });
      throw error;
    }
  }

  // Batch store
  /**
   * @param {BatchEntry[]} entries
   * @returns {Promise<Object>}
   */
  async function batchStore(entries) {
    const startTime = performance.now();
    const results = {};
    for (const { key, value, options } of entries) {
      try {
        await store(key, value, options);
        results[key] = { success: true };
      } catch (e) {
        results[key] = { success: false, error: e };
      }
    }
    log('Batch store completed', { count: entries.length, duration: performance.now() - startTime });
    return results;
  }

  // Retrieve memory
  /**
   * @param {string} key
   * @returns {any}
   */
  function recall(key) {
    const startTime = performance.now();
    if (checkExpiration(key)) return undefined;
    
    if (memory.has(key)) {
      const { value } = memory.get(key);
      memoryHistory.push({ 
        op: 'recall', 
        key, 
        value, 
        time: Date.now(), 
        error: null,
        performance: { duration: performance.now() - startTime }
      });
      dispatchEvent(`${eventPrefix}recalled`, { key, value });
      return value;
    }
    
    const stored = storage.getItem(`memory:${key}`);
    if (stored) {
      try {
        const val = stored.startsWith('{') || stored.startsWith('[') 
          ? JSON.parse(stored) 
          : decompress(stored);
        memory.set(key, { value: val });
        memoryHistory.push({ 
          op: 'recall', 
          key, 
          value: val, 
          time: Date.now(), 
          error: null,
          performance: { duration: performance.now() - startTime }
        });
        dispatchEvent(`${eventPrefix}recalled`, { key, value: val });
        return val;
      } catch (e) {
        const error = createError(`Error recalling memory ${key}`, 'RECALL_ERROR', { error: e });
        log(`Error recalling memory ${key}:`, error);
        memoryHistory.push({ 
          op: 'recall', 
          key, 
          value: null, 
          time: Date.now(), 
          error,
          performance: { duration: performance.now() - startTime }
        });
        dispatchEvent(`${eventPrefix}error`, { key, error });
        return undefined;
      }
    }
    return undefined;
  }

  // Batch recall
  /**
   * @param {string[]} keys
   * @returns {Object}
   */
  function batchRecall(keys) {
    const startTime = performance.now();
    const results = {};
    for (const key of keys) {
      results[key] = recall(key);
    }
    log('Batch recall completed', { count: keys.length, duration: performance.now() - startTime });
    return results;
  }

  // Apply memory influence
  /**
   * @param {string} key
   * @param {Function} callback
   */
  async function influence(key, callback) {
    const startTime = performance.now();
    try {
      await fireHooks(key, 'before', { key });
      const value = recall(key);
      if (value && typeof callback === 'function') {
        await callback(value);
      }
      await fireHooks(key, 'after', { key, value });
      log('Influence applied for memory:', key, value);
    } catch (e) {
      const error = createError(`Error influencing with memory ${key}`, 'INFLUENCE_ERROR', { error: e });
      log(`Error influencing with memory ${key}:`, error);
      await fireHooks(key, 'error', { key, error });
      dispatchEvent(`${eventPrefix}error`, { key, error });
      memoryHistory.push({
        op: 'influence',
        key,
        time: Date.now(),
        error,
        performance: { duration: performance.now() - startTime }
      });
    }
  }

  // Clear memory
  /**
   * @param {string} key
   */
  async function forget(key) {
    const startTime = performance.now();
    try {
      await fireHooks(key, 'before', { key });
      memory.delete(key);
      storage.removeItem(`memory:${key}`);
      memoryHistory.push({ 
        op: 'forget', 
        key, 
        time: Date.now(), 
        error: null,
        performance: { duration: performance.now() - startTime }
      });
      dispatchEvent(`${eventPrefix}forgotten`, { key });
      await fireHooks(key, 'after', { key });
      log('Forgot memory:', key);
    } catch (e) {

      const error = createError(`Error forgetting memory ${key}`, 'FORGET_ERROR', { error: e });
      log(`Error forgetting memory ${key}:`, error);
      await fireHooks(key, 'error', { key, error });
      dispatchEvent(`${eventPrefix}error`, { key, error });
      memoryHistory.push({ 
        op: 'forget', 
        key, 
        time: Date.now(), 
        error,
        performance: { duration: performance.now() - startTime }
      });
      throw error;
    }
  }

  // Dispatch custom event
  /**
   * @param {string} type
   * @param {Object} detail
   */
  function dispatchEvent(type, detail) {
    document.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
    log('Dispatched event:', type, detail);
  }

  // Set history cap
  /**
   * @param {number} cap
   */
  function setHistoryCap(cap) {
    if (cap < 0) throw createError('History cap must be non-negative', 'INVALID_HISTORY_CAP');
    maxHistoryLength = cap;
    while (memoryHistory.length > maxHistoryLength) memoryHistory.shift();
    log('History cap set:', maxHistoryLength);
  }

  // Registry and history
  /**
   * @returns {Object}
   */
  function getRegistry() {
    return Object.fromEntries(Array.from(memory.entries()).map(([key, entry]) => [key, { ...entry }]));
  }

  /**
   * @param {{op?: 'store'|'recall'|'forget'|'load', key?: string, maxAge?: number, errorOnly?: boolean}} [filter]
   * @returns {HistoryEntry[]}
   */
  function getHistory(filter = {}) {
    let result = [...memoryHistory];
    if (filter.op) result = result.filter(entry => entry.op === filter.op);
    if (filter.key) result = result.filter(entry => entry.key === filter.key);
    if (filter.maxAge) result = result.filter(entry => entry.time >= Date.now() - filter.maxAge);
    if (filter.errorOnly) result = result.filter(entry => !!entry.error);
    return result;
  }

  function clearHistory() {
    memoryHistory.length = 0;
    log('Memory history cleared');
  }

  // Load persisted on init
  function init() {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith('memory:')) {
        const key = k.slice(7);
        try {
          const val = storage.getItem(k).startsWith('{') || storage.getItem(k).startsWith('[') 
            ? JSON.parse(storage.getItem(k)) 
            : decompress(storage.getItem(k));
          memory.set(key, { value: val });
          memoryHistory.push({ 
            op: 'load', 
            key, 
            value: val, 
            time: Date.now(), 
            error: null,
            performance: { duration: 0 }
          });
        } catch (e) {
          const error = createError(`Error loading memory ${key}`, 'LOAD_ERROR', { error: e });
          log(`Error loading memory ${k}:`, error);
          memoryHistory.push({ 
            op: 'load', 
            key, 
            value: null, 
            time: Date.now(), 
            error,
            performance: { duration: 0 }
          });
        }
      }
    }
    log('MemoryEngine initialized');
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    store,
    batchStore,
    recall,
    batchRecall,
    influence,
    forget,
    setStorage,
    addHook,
    getRegistry,
    getHistory,
    clearHistory,
    setDebug,
    setHistoryCap
  };
})();
export default MemoryEngine;
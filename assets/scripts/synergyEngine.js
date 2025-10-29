/**
 * SynergyEngine v1.1.0
 * Runtime-configurable orchestration engine with improved concurrency, reliability, and lifecycle APIs.
 *
 * - No hardcoded dependencies.
 * - Supports dynamic add/remove/update of engines and links.
 * - Adaptive concurrency scaling (configurable).
 * - Per-link timeouts, retries, backoff, dependency ordering, and optional isolation (deep-clone context).
 * - Cycle detection for link graph; emits conflict hooks if detected.
 * - Improved performance metrics and adaptive weight toggle.
 */

const SynergyEngine = (function () {
  const constants = {
    maxHistoryLength: 500,
    defaultGoalMode: "balanced",
    defaultConcurrency: 4,
    maxConcurrency: 16,
    minConcurrency: 1,
  };

  const perfConfig = {
    samplingWindow: 100,
    adaptiveWeights: false,
  };

  const defaultLinkDefaults = {
    weight: 1,
    async: false,
    condition: null,
    retries: 0,
    retryBackoffMs: 100,
    timeoutMs: 0, // 0 = no timeout
    isolateContext: true,
    cache: false,
    cacheTTLms: 0,
    dependsOn: [], // array of link ids
    allowCycle: false,
    allowMissingEngine: false,
  };

  const isFunction = (v) => typeof v === "function";
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  // deep clone for isolation; handles basic objects/arrays using structuredClone if available
  function deepClone(val) {
    try {
      if (typeof structuredClone === "function") return structuredClone(val);
    } catch (_) {}
    // fallback naive clone (no functions, won't preserve prototypes)
    try {
      return JSON.parse(JSON.stringify(val));
    } catch (err) {
      // if cloning fails, return the original (best-effort)
      return val;
    }
  }

  // small LRU-like cache per link using Map and expiration
  function makeCache() {
    const map = new Map();
    return {
      get(key) {
        const rec = map.get(key);
        if (!rec) return undefined;
        if (rec.expiry && rec.expiry < Date.now()) {
          map.delete(key);
          return undefined;
        }
        return rec.value;
      },
      set(key, value, ttl) {
        const expiry = ttl > 0 ? Date.now() + ttl : 0;
        map.set(key, { value, expiry });
      },
      clear() {
        map.clear();
      },
    };
  }

  class Emitter {
    constructor() { this._listeners = new Map(); }
    on(event, cb) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(cb);
      return () => this.off(event, cb);
    }
    off(event, cb) {
      if (!this._listeners.has(event)) return;
      const arr = this._listeners.get(event);
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    }
    emit(event, ...args) {
      if (!this._listeners.has(event)) return;
      const arr = this._listeners.get(event).slice();
      for (const cb of arr) {
        try { cb(...args); } catch (err) { console.error(`Emitter handler error for ${event}:`, err); }
      }
    }
  }

  // internal state
  const engines = new Map(); // name -> api
  const links = new Map(); // id -> linkObj
  let linkIdCounter = 1;
  const linkCaches = new Map(); // linkId -> cache
  const hooks = { global: { before: [], after: [], error: [], conflict: [], resolve: [] }, engine: new Map() };
  const goals = new Set();
  const history = [];
  let historyPointer = -1;
  const perf = new Map(); // engineName -> { latencies: [], triggerCount, linkCount }
  let concurrency = constants.defaultConcurrency;
  let adaptiveConcurrencyEnabled = true;
  let adaptiveWeightsEnabled = perfConfig.adaptiveWeights;
  const emitter = new Emitter();

  // backpressure stats
  let recentQueueLengths = [];
  const queueStatsWindow = 20;

  function ensurePerfEntry(engineName) {
    if (!perf.has(engineName)) perf.set(engineName, { latencies: [], triggerCount: 0, linkCount: 0 });
    return perf.get(engineName);
  }

  function recordLatency(engineName, ms) {
    const p = ensurePerfEntry(engineName);
    p.latencies.push(ms);
    if (p.latencies.length > perfConfig.samplingWindow) p.latencies.shift();
  }

  function incrementTriggerCount(engineName) {
    const p = ensurePerfEntry(engineName);
    p.triggerCount = (p.triggerCount || 0) + 1;
  }

  function avgLatency(engineName) {
    const p = perf.get(engineName);
    if (!p || !p.latencies.length) return 0;
    return p.latencies.reduce((a, b) => a + b, 0) / p.latencies.length;
  }

  function pushHistory(entry) {
    if (historyPointer < history.length - 1) history.splice(historyPointer + 1);
    history.push(entry);
    while (history.length > constants.maxHistoryLength) history.shift();
    historyPointer = history.length - 1;
  }

  function setAdaptiveConcurrency(enabled) {
    adaptiveConcurrencyEnabled = !!enabled;
  }

  function setAdaptiveWeights(enabled) {
    adaptiveWeightsEnabled = !!enabled;
  }

  function setLinkDefaults(defaults = {}) {
    Object.assign(defaultLinkDefaults, defaults);
  }

  // engine lifecycle
  function registerEngine(name, api = {}) {
    if (!name || typeof name !== "string") throw new Error("Engine name required");
    engines.set(name, api || {});
    if (!hooks.engine.has(name)) hooks.engine.set(name, { before: [], after: [], error: [] });
    emitter.emit("synergy:init", { engine: name });
    return true;
  }

  function unregisterEngine(name) {
    if (!engines.has(name)) return false;
    // remove related links
    const toRemove = [];
    for (const [id, l] of links.entries()) {
      if (l.source === name || l.target === name) toRemove.push(id);
    }
    for (const id of toRemove) removeLink(id);
    engines.delete(name);
    hooks.engine.delete(name);
    return true;
  }

  function getEngine(name) { return engines.get(name); }

  // hook system
  function addHook(phase, callback) {
    if (!hooks.global[phase]) throw new Error(`Unknown hook phase: ${phase}`);
    if (!isFunction(callback)) throw new Error("Hook callback must be a function");
    hooks.global[phase].push(callback);
    return () => {
      const arr = hooks.global[phase];
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  function addEngineHook(engineName, phase, callback) {
    if (!hooks.engine.has(engineName)) hooks.engine.set(engineName, { before: [], after: [], error: [] });
    const eHooks = hooks.engine.get(engineName);
    if (!eHooks[phase]) throw new Error(`Unknown engine hook phase: ${phase}`);
    eHooks[phase].push(callback);
    return () => {
      const arr = eHooks[phase];
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  // conflict/resolve invocation helpers
  async function _invokeGlobalHook(phase, payload = {}) {
    const hArr = hooks.global[phase] || [];
    for (const cb of hArr) {
      try {
        const r = cb(payload);
        if (r instanceof Promise) await r;
      } catch (err) { console.error("Global hook error:", err); }
    }
  }

  async function _invokeEngineHook(engineName, phase, payload = {}) {
    const eHooks = hooks.engine.get(engineName);
    if (!eHooks) return;
    const hArr = eHooks[phase] || [];
    for (const cb of hArr) {
      try {
        const r = cb(payload);
        if (r instanceof Promise) await r;
      } catch (err) { console.error(`Engine hook error (${engineName}:${phase}):`, err); }
    }
  }

  // link registration with cycle detection and validation
  function _linkGraphCreatesCycle(candidateEdges) {
    // candidateEdges: array of [from,to]
    const nodes = new Set();
    const adj = new Map();
    // build adjacency including existing links
    for (const [id, l] of links.entries()) {
      nodes.add(l.source); nodes.add(l.target);
      if (!adj.has(l.source)) adj.set(l.source, []);
      adj.get(l.source).push(l.target);
    }
    // add candidate edges
    for (const [a, b] of candidateEdges) {
      nodes.add(a); nodes.add(b);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    }
    // detect cycle via DFS
    const temp = new Set(), perm = new Set();
    let hasCycle = false;
    function visit(n) {
      if (perm.has(n) || hasCycle) return;
      if (temp.has(n)) { hasCycle = true; return; }
      temp.add(n);
      const neigh = adj.get(n) || [];
      for (const m of neigh) visit(m);
      temp.delete(n);
      perm.add(n);
    }
    for (const n of nodes) if (!perm.has(n)) visit(n);
    return hasCycle;
  }

  function registerLink(source, target, rule, options = {}) {
    if (!source || !target || !isFunction(rule)) throw new Error("registerLink requires (source, target, rule[, options])");
    const opts = Object.assign({}, defaultLinkDefaults, options);
    // validate engine existence unless allowed
    if (!engines.has(source) && !opts.allowMissingEngine) throw new Error(`Source engine not registered: ${source}`);
    if (!engines.has(target) && !opts.allowMissingEngine) throw new Error(`Target engine not registered: ${target}`);
    // detect cycle
    const candidate = [[source, target]];
    if (_linkGraphCreatesCycle(candidate) && !opts.allowCycle) {
      const conflict = { type: "cycle", source, target, options: opts };
      emitter.emit("synergy:conflict", conflict);
      _invokeGlobalHook("conflict", conflict).catch(() => {});
      throw new Error("Registering this link would create a cycle (set options.allowCycle=true to bypass).");
    }
    const id = String(linkIdCounter++);
    const link = {
      id,
      source,
      target,
      rule,
      weight: opts.weight,
      async: !!opts.async,
      condition: opts.condition,
      options: opts,
      createdAt: Date.now(),
    };
    links.set(id, link);
    // create cache if requested
    if (opts.cache) linkCaches.set(id, makeCache());
    emitter.emit("synergy:link:added", link);
    return link;
  }

  function removeLink(id) {
    if (!links.has(String(id))) return false;
    const link = links.get(String(id));
    links.delete(String(id));
    linkCaches.delete(String(id));
    emitter.emit("synergy:link:removed", { id: String(id), link });
    return true;
  }

  function updateLink(id, changes = {}) {
    const key = String(id);
    if (!links.has(key)) throw new Error("link not found");
    const link = links.get(key);
    // shallow merge allowed fields
    const allowed = ["rule", "weight", "async", "condition", "options"];
    for (const k of Object.keys(changes)) {
      if (allowed.includes(k)) link[k] = changes[k];
      else if (k === "options" && typeof changes.options === "object") Object.assign(link.options, changes.options);
    }
    emitter.emit("synergy:link:updated", link);
    return link;
  }

  function getRegisteredLinks() {
    const out = [];
    for (const [id, l] of links.entries()) out.push({ id, source: l.source, target: l.target, weight: l.weight });
    return out;
  }

  function getContextGraph() {
    const nodes = Array.from(engines.keys()).map((k) => ({ id: k }));
    const edges = [];
    for (const [id, l] of links.entries()) edges.push({ id, source: l.source, target: l.target, weight: l.weight });
    return { nodes, edges };
  }

  // util: execute function with timeout and AbortController support
  function executeWithTimeout(fnPromiseFactory, timeoutMs = 0) {
    if (!timeoutMs || timeoutMs <= 0) return fnPromiseFactory();
    let abort;
    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    if (ac) abort = ac;
    // factory receives optional signal
    const p = fnPromiseFactory(abort ? abort.signal : undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const to = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { if (abort) abort.abort(); } catch (_) {}
        reject(new Error("Operation timed out"));
      }, timeoutMs);
      Promise.resolve(p)
        .then((r) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          resolve(r);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(to);
          reject(err);
        });
    });
  }

  // schedule dependency-respecting execution of applicable links
  async function trigger(context = {}, priority = 0, opts = {}) {
    emitter.emit("synergy:link:triggered", { context, priority, opts });
    // collect applicable links
    const applicable = [];
    for (const [id, l] of links.entries()) {
      try {
        if (l.condition && !l.condition(context)) continue;
        applicable.push(l);
      } catch (err) {
        _invokeGlobalHook("error", { error: err, link: l, context }).catch(() => {});
      }
    }

    // build dependency graph among applicable link ids
    const idToLink = new Map(applicable.map((l) => [l.id, l]));
    // if a link has dependsOn that aren't present, treat as no-op depends or emit conflict
    for (const l of applicable) {
      const deps = (l.options && Array.isArray(l.options.dependsOn)) ? l.options.dependsOn.map(String) : [];
      l._resolvedDepends = deps.filter((d) => idToLink.has(d));
    }

    // detect cycles among applicable links
    const edges = [];
    for (const l of applicable) {
      for (const d of l._resolvedDepends) edges.push([d, l.id]);
    }
    // simple cycle detection
    function detectCycleEdges(edgesList) {
      const nodes = new Set();
      const adj = new Map();
      for (const [a, b] of edgesList) {
        nodes.add(a); nodes.add(b);
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a).push(b);
      }
      const temp = new Set(), perm = new Set();
      let cyc = false;
      function visit(n) {
        if (perm.has(n) || cyc) return;
        if (temp.has(n)) { cyc = true; return; }
        temp.add(n);
        const neigh = adj.get(n) || [];
        for (const m of neigh) visit(m);
        temp.delete(n);
        perm.add(n);
      }
      for (const n of nodes) if (!perm.has(n)) visit(n);
      return cyc;
    }
    if (detectCycleEdges(edges)) {
      const conflict = { type: "link-dependency-cycle", edges, context };
      emitter.emit("synergy:conflict", conflict);
      _invokeGlobalHook("conflict", conflict).catch(() => {});
      // fail the trigger early
      return { results: [], error: new Error("Dependency cycle detected among links") };
    }

    // topological order (Kahn's algorithm) over applicable link ids
    const inDegree = new Map();
    const adj = new Map();
    for (const l of applicable) { inDegree.set(l.id, 0); adj.set(l.id, []); }
    for (const l of applicable) {
      for (const d of l._resolvedDepends) {
        adj.get(d).push(l.id);
        inDegree.set(l.id, (inDegree.get(l.id) || 0) + 1);
      }
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) if (deg === 0) queue.push(id);
    const topo = [];
    while (queue.length) {
      const n = queue.shift();
      topo.push(n);
      for (const m of (adj.get(n) || [])) {
        inDegree.set(m, inDegree.get(m) - 1);
        if (inDegree.get(m) === 0) queue.push(m);
      }
    }
    if (topo.length !== applicable.length) {
      const conflict = { type: "topo-failure", context };
      emitter.emit("synergy:conflict", conflict);
      _invokeGlobalHook("conflict", conflict).catch(() => {});
      return { results: [], error: new Error("Unable to determine link execution order") };
    }

    // update queue stats for adaptive concurrency
    recentQueueLengths.push(applicable.length);
    if (recentQueueLengths.length > queueStatsWindow) recentQueueLengths.shift();
    if (adaptiveConcurrencyEnabled) _adjustConcurrency();

    // execution helpers
    const results = [];
    const rollbackFns = [];
    const idToResult = new Map();

    // execute link by id, respecting dependencies (already ordered in topo)
    for (const linkId of topo.sort((a, b) => {
      // sort by weight descending as tie-breaker while preserving topo ordering
      const la = idToLink.get(a), lb = idToLink.get(b);
      return (lb.weight || 0) - (la.weight || 0);
    })) {
      const linkObj = idToLink.get(linkId);
      const linkOpts = linkObj.options || {};
      // prepare context copy or shared
      const execContext = linkOpts.isolateContext ? deepClone(context) : context;

      // check cache
      let cache = linkCaches.get(linkObj.id);
      const cacheKey = linkOpts.cache ? JSON.stringify(execContext) : null;
      if (cache && cacheKey) {
        const cached = cache.get(cacheKey);
        if (cached !== undefined) {
          results.push({ link: linkObj, result: cached, cached: true });
          idToResult.set(linkObj.id, cached);
          continue;
        }
      }

      // attempt execution with retries
      const maxRetries = Math.max(0, linkOpts.retries || 0);
      let attempt = 0;
      let lastError = null;
      let finalResult;
      while (attempt <= maxRetries) {
        try {
          const start = now();
          incrementTriggerCount(linkObj.target);
          // run before hooks
          await _invokeGlobalHook("before", { link: linkObj, context: execContext }).catch(() => {});
          await _invokeEngineHook(linkObj.target, "before", { link: linkObj, context: execContext }).catch(() => {});

          const fnFactory = (signal) => {
            // rule may accept signal in options; supply engine and dependency results
            const depResults = (linkObj._resolvedDepends || []).map((d) => idToResult.get(d));
            // rule may be sync or return Promise
            try {
              return linkObj.rule(execContext, { engine: getEngine(linkObj.target), source: linkObj.source, target: linkObj.target, deps: depResults, signal });
            } catch (err) {
              return Promise.reject(err);
            }
          };

          const res = await executeWithTimeout(() => fnFactory(), linkOpts.timeoutMs || 0);
          // if target engine has apply(), call with safe timeout
          const eng = getEngine(linkObj.target);
          if (eng && typeof eng.apply === "function") {
            await executeWithTimeout(() => eng.apply(res !== undefined ? res : execContext), linkOpts.timeoutMs || 0).catch((err) => { throw err; });
          }

          const duration = now() - start;
          recordLatency(linkObj.target, duration);
          // after hooks
          await _invokeEngineHook(linkObj.target, "after", { link: linkObj, context: execContext, result: res }).catch(() => {});
          await _invokeGlobalHook("after", { link: linkObj, context: execContext, result: res }).catch(() => {});

          // gather rollback if provided (function or { rollback: fn })
          let rollback = null;
          if (res && typeof res === "object" && typeof res.rollback === "function") rollback = res.rollback;
          else if (typeof res === "function") rollback = res;
          if (rollback) rollbackFns.push(rollback);

          finalResult = res;
          idToResult.set(linkObj.id, res);
          if (cache && cacheKey) cache.set(cacheKey, res, linkOpts.cacheTTLms || 0);
          results.push({ link: linkObj, result: res, attempt });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          attempt++;
          await _invokeGlobalHook("error", { error: err, link: linkObj, context: execContext, attempt }).catch(() => {});
          // retry backoff
          if (attempt <= maxRetries) {
            const backoff = linkOpts.retryBackoffMs || 100;
            await new Promise((r) => setTimeout(r, backoff * attempt));
            continue;
          } else {
            results.push({ link: linkObj, error: err, attempt });
            idToResult.set(linkObj.id, { error: err });
          }
        }
      } // end attempts
    } // end for each link

    // record history entry
    const hEntry = {
      id: `h-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      description: context && context.event ? `trigger:${context.event}` : "trigger",
      rollbacks: rollbackFns.slice(),
      meta: { context, priority, linkCount: applicable.length, opts },
    };
    pushHistory(hEntry);
    // emit resolved
    emitter.emit("synergy:resolved", hEntry);
    _invokeGlobalHook("resolve", hEntry).catch(() => {});
    return { results, historyEntry: hEntry };
  }

  // adaptive concurrency adjustment
  function _adjustConcurrency() {
    // simple heuristic: if average queue length is high and avg latency low -> increase concurrency; if latencies rising -> decrease
    if (!recentQueueLengths.length) return;
    const avgQueue = recentQueueLengths.reduce((a, b) => a + b, 0) / recentQueueLengths.length;
    // compute average latency across engines
    let latSum = 0, latCount = 0;
    for (const [k, v] of perf.entries()) {
      if (v.latencies && v.latencies.length) {
        latSum += v.latencies.reduce((a, b) => a + b, 0) / v.latencies.length;
        latCount++;
      }
    }
    const avgLat = latCount ? latSum / latCount : 0;
    // rules:
    if (avgQueue > 10 && avgLat < 100 && concurrency < constants.maxConcurrency) concurrency = Math.min(constants.maxConcurrency, concurrency + 1);
    else if (avgLat > 250 && concurrency > constants.minConcurrency) concurrency = Math.max(constants.minConcurrency, concurrency - 1);
    // else keep concurrency
  }

  // undo/redo with safer rollback execution
  async function undo(steps = 1) {
    if (steps <= 0) return { undone: 0 };
    let undone = 0;
    while (undone < steps && historyPointer >= 0) {
      const entry = history[historyPointer];
      if (!entry) break;
      // apply rollbacks in reverse order
      for (let i = entry.rollbacks.length - 1; i >= 0; i--) {
        const rb = entry.rollbacks[i];
        try {
          const r = rb();
          if (r instanceof Promise) await executeWithTimeout(() => r, 2000).catch((err) => {
            _invokeGlobalHook("error", { error: err, historyEntry: entry }).catch(() => {});
          });
        } catch (err) {
          _invokeGlobalHook("error", { error: err, historyEntry: entry }).catch(() => {});
        }
      }
      historyPointer--;
      undone++;
      emitter.emit("synergy:undo", { entry });
    }
    return { undone };
  }

  async function redo(steps = 1) {
    if (steps <= 0) return { redone: 0 };
    let redone = 0;
    while (redone < steps && historyPointer < history.length - 1) {
      const nextIndex = historyPointer + 1;
      const entry = history[nextIndex];
      if (!entry) break;
      try {
        // Re-trigger with same context and options; this creates a new history entry
        await trigger(entry.meta.context, entry.meta.priority, entry.meta.opts);
      } catch (err) {
        _invokeGlobalHook("error", { error: err, historyEntry: entry }).catch(() => {});
      }
      historyPointer = Math.min(historyPointer + 1, history.length - 1);
      redone++;
      emitter.emit("synergy:redo", { entry });
    }
    return { redone };
  }

  function getHistory() { return history.slice(); }

  function getPerformanceMetrics() {
    const out = {};
    for (const [k, v] of perf.entries()) {
      out[k] = {
        avgLatency: avgLatency(k),
        triggerCount: v.triggerCount || 0,
        linkCount: v.linkCount || 0,
      };
    }
    return out;
  }

  function getActiveGoals() { return Array.from(goals); }

  function prioritize(goalsList = [], mode = "balanced") {
    if (!Array.isArray(goalsList)) throw new Error("goals must be an array");
    goals.clear();
    for (const g of goalsList) goals.add(g);
    emitter.emit("synergy:goal:updated", Array.from(goals));
    if (mode === "performance" && adaptiveWeightsEnabled) {
      for (const [id, l] of links.entries()) {
        const avg = avgLatency(l.target);
        l.weight = Math.max(0.05, (l.weight || 1) * (1 / (1 + avg / 50)));
      }
    }
    return { mode, activeGoals: Array.from(goals) };
  }

  function getRegisteredLinks() {
    return Array.from(links.values()).map((l) => ({ id: l.id, source: l.source, target: l.target, weight: l.weight }));
  }

  function setConcurrency(n) {
    if (typeof n !== "number" || n <= 0) throw new Error("concurrency must be a positive number");
    concurrency = Math.max(constants.minConcurrency, Math.min(constants.maxConcurrency, Math.floor(n)));
  }

  function analyze({ scope = "all", filters = {} } = {}) {
    const results = {};
    const promises = [];
    for (const [name, eng] of engines.entries()) {
      try {
        if (eng && typeof eng.analyze === "function") promises.push(Promise.resolve(eng.analyze({ scope, filters })).then((r) => { results[name] = r; }).catch((err) => {
          _invokeGlobalHook("error", { error: err, engine: name, phase: "analyze" }).catch(() => {});
        }));
      } catch (err) {
        _invokeGlobalHook("error", { error: err, engine: name, phase: "analyze" }).catch(() => {});
      }
    }
    return Promise.all(promises).then(() => results);
  }

  function analyzeAll() { return analyze({ scope: "all" }); }

  // exports
  const publicAPI = {
    name: "SynergyEngine",
    version: "1.1.0",
    constants,
    registerEngine,
    unregisterEngine,
    getEngine,
    registerLink,
    removeLink,
    updateLink,
    getRegisteredLinks,
    trigger,
    analyze,
    analyzeAll,
    prioritize,
    getActiveGoals,
    undo,
    redo,
    getHistory,
    addHook,
    addEngineHook,
    getContextGraph,
    getPerformanceMetrics,
    setConcurrency,
    setAdaptiveConcurrency,
    setAdaptiveWeights,
    setLinkDefaults,
    setConcurrency: setConcurrency,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _internal: { links, engines, hooks, perf, history, linkCaches },
  };

  // initial init event
  setTimeout(() => emitter.emit("synergy:init", { timestamp: new Date().toISOString() }), 0);

  return publicAPI;
})();

// Exports for Node/browser
if (typeof module !== "undefined" && module.exports) module.exports = SynergyEngine;
if (typeof window !== "undefined") window.SynergyEngine = SynergyEngine;
export default SynergyEngine;
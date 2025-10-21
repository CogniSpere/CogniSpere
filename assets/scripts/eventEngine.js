/**
 * Full-featured Event Engine with improved cloneDeep and archetype context validation
 *
 * - Deep-clone now supports Dates, RegExps, Maps, Sets, Buffers, TypedArrays,
 *   circular references, property descriptors and class instances.
 * - Archetypes may define:
 *    - contextValidator: (ctx) => boolean | throws
 *    - contextShape: { keyName: 'string'|'number'|'boolean'|Constructor|... }
 *   These are checked on activation. Failures emit an 'error' event and abort activation.
 *
 * Other features unchanged (listeners, pattern listeners, emit/emitAsync, state sync, etc).
 */

const DEFAULT_MAX_LISTENERS = 10;

function globToRegExp(glob) {
  const escaped = glob.replace(/([.+^=!:${}()|[\]/\\])/g, "\\$1");
  const regexStr = "^" + escaped.replace(/\\\*+/g, ".*").replace(/\\\?/g, ".") + "$";
  return new RegExp(regexStr);
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// Robust deep clone that preserves many types and handles circular refs
function cloneDeep(value, refs = new WeakMap()) {
  // primitives
  if (value === null || typeof value !== "object") {
    return value;
  }

  // handle circular refs
  if (refs.has(value)) {
    return refs.get(value);
  }

  // Dates
  if (value instanceof Date) {
    const d = new Date(value.getTime());
    refs.set(value, d);
    return d;
  }

  // RegExp
  if (value instanceof RegExp) {
    const r = new RegExp(value.source, value.flags);
    refs.set(value, r);
    return r;
  }

  // Buffer (Node)
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    const b = Buffer.from(value);
    refs.set(value, b);
    return b;
  }

  // Array
  if (Array.isArray(value)) {
    const arr = [];
    refs.set(value, arr);
    for (let i = 0; i < value.length; i++) {
      arr[i] = cloneDeep(value[i], refs);
    }
    return arr;
  }

  // Map
  if (value instanceof Map) {
    const m = new Map();
    refs.set(value, m);
    for (const [k, v] of value.entries()) {
      m.set(cloneDeep(k, refs), cloneDeep(v, refs));
    }
    return m;
  }

  // Set
  if (value instanceof Set) {
    const s = new Set();
    refs.set(value, s);
    for (const v of value.values()) {
      s.add(cloneDeep(v, refs));
    }
    return s;
  }

  // ArrayBuffer / TypedArray / DataView
  if (ArrayBuffer.isView(value)) {
    // TypedArray or DataView
    const ctor = value.constructor;
    const cloned = new ctor(value.buffer ? value.buffer.slice(0) : value);
    refs.set(value, cloned);
    return cloned;
  }
  if (value instanceof ArrayBuffer) {
    const buf = value.slice(0);
    refs.set(value, buf);
    return buf;
  }

  // Function: preserve the same function reference (cannot deep clone execution)
  if (typeof value === "function") {
    return value;
  }

  // Symbol: preserve same symbol reference
  if (typeof value === "symbol") {
    return value;
  }

  // For objects (including class instances), preserve prototype and descriptors
  const proto = Object.getPrototypeOf(value);
  const out = Object.create(proto);
  refs.set(value, out);

  // copy own property descriptors (including non-enumerable and symbol keys)
  const propNames = Object.getOwnPropertyNames(value);
  const symNames = Object.getOwnPropertySymbols(value);
  for (const key of [...propNames, ...symNames]) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) continue;
    if ("value" in desc) {
      desc.value = cloneDeep(desc.value, refs);
    }
    // getters/setters: keep as-is (they are functions and will be preserved by reference)
    Object.defineProperty(out, key, desc);
  }

  return out;
}

// Helper to convert dot-paths to an array: 'user.profile.name' -> ['user','profile','name']
function toPathArray(path) {
  if (Array.isArray(path)) return path;
  if (typeof path !== "string") return [String(path)];
  return path.split(".").filter(Boolean);
}

function getAtPath(root, pathArr) {
  let cur = root;
  for (const p of pathArr) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setAtPath(root, pathArr, value) {
  let cur = root;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const p = pathArr[i];
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[pathArr[pathArr.length - 1]] = value;
  return root;
}

class EventEngine {
  constructor(options = {}) {
    this._listeners = new Map(); // eventName -> Array<listener>
    this._patternListeners = []; // Array<{ pattern, regex, listener }>
    this._maxListeners = options.maxListeners ?? DEFAULT_MAX_LISTENERS;
    this._warned = new Set();

    // State store
    this._state = {}; // object-based state for nested keys
    // Archetypes
    this._archetypes = new Map(); // name -> archetype metadata
  }

  _makeListener(handler, options = {}) {
    return {
      id: Symbol("listener"),
      handler,
      once: !!options.once,
      priority: typeof options.priority === "number" ? options.priority : 0,
      prepend: !!options.prepend,
      async: !!options.async,
      timeout: typeof options.timeout === "number" ? options.timeout : 0,
      context: options.context ?? null,
      pattern: options.pattern ?? null,
      regex: options.pattern ? globToRegExp(options.pattern) : null,
    };
  }

  _getList(eventType) {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, []);
    }
    return this._listeners.get(eventType);
  }

  _checkMax(eventType) {
    const count = this.listenerCount(eventType);
    if (this._maxListeners > 0 && count > this._maxListeners && !this._warned.has(eventType)) {
      this._warned.add(eventType);
      setTimeout(() => {
        console.warn(`Possible EventEngine memory leak detected. ${count} listeners added for event "${eventType}". Use setMaxListeners() to increase limit.`);
      }, 0);
    }
  }

  on(eventTypeOrPattern, handler, options = {}) {
    if (typeof eventTypeOrPattern !== "string") {
      throw new TypeError("eventType must be a string");
    }
    const isPattern = !!options.pattern || eventTypeOrPattern.includes("*") || eventTypeOrPattern.includes("?");
    if (isPattern) {
      const pattern = options.pattern ?? eventTypeOrPattern;
      const listener = this._makeListener(handler, { ...options, pattern });
      this._patternListeners.push({ pattern, regex: globToRegExp(pattern), listener });
      this._checkMax(pattern);
      return listener.id;
    }
    const listener = this._makeListener(handler, options);
    const list = this._getList(eventTypeOrPattern);
    if (listener.prepend) {
      list.unshift(listener);
    } else {
      list.push(listener);
    }
    list.sort((a, b) => b.priority - a.priority);
    this._checkMax(eventTypeOrPattern);
    return listener.id;
  }

  once(eventTypeOrPattern, handler, options = {}) {
    return this.on(eventTypeOrPattern, handler, { ...options, once: true });
  }

  prependListener(eventType, handler, options = {}) {
    return this.on(eventType, handler, { ...options, prepend: true });
  }

  prependOnceListener(eventType, handler, options = {}) {
    return this.on(eventType, handler, { ...options, once: true, prepend: true });
  }

  off(eventTypeOrPattern, handlerOrId) {
    if (typeof eventTypeOrPattern !== "string") return;
    // Exact listeners
    if (this._listeners.has(eventTypeOrPattern)) {
      const remaining = this._listeners
        .get(eventTypeOrPattern)
        .filter(l => (typeof handlerOrId === "symbol" ? l.id !== handlerOrId : l.handler !== handlerOrId));
      this._listeners.set(eventTypeOrPattern, remaining);
    }
    // Pattern listeners removal logic
    this._patternListeners = this._patternListeners.filter(p => {
      if (p.pattern === eventTypeOrPattern) {
        if (typeof handlerOrId === "symbol") return p.listener.id !== handlerOrId;
        if (typeof handlerOrId === "function") return p.listener.handler !== handlerOrId;
        return false; // remove all listeners for that pattern
      }
      if (typeof handlerOrId === "symbol") return p.listener.id !== handlerOrId;
      if (typeof handlerOrId === "function") return p.listener.handler !== handlerOrId;
      return true;
    });
  }

  removeListener(eventType, handler) {
    return this.off(eventType, handler);
  }

  removeAllListeners(eventType) {
    if (eventType) {
      this._listeners.delete(eventType);
      this._patternListeners = this._patternListeners.filter(p => p.pattern !== eventType);
    } else {
      this._listeners.clear();
      this._patternListeners = [];
    }
  }

  clear(eventType) {
    return this.removeAllListeners(eventType);
  }

  listeners(eventType) {
    const exact = this._listeners.get(eventType) || [];
    const patterns = this._patternListeners
      .filter(p => p.regex.test(eventType))
      .map(p => p.listener);
    return [...exact, ...patterns].map(l => l.handler);
  }

  listenerObjects(eventType) {
    const exact = this._listeners.get(eventType) || [];
    const patterns = this._patternListeners
      .filter(p => p.regex.test(eventType))
      .map(p => ({ ...p.listener, pattern: p.pattern }));
    return [...exact, ...patterns];
  }

  eventNames() {
    const names = Array.from(this._listeners.keys());
    const patterns = this._patternListeners.map(p => p.pattern);
    return Array.from(new Set([...names, ...patterns]));
  }

  listenerCount(eventType) {
    return this.listeners(eventType).length;
  }

  setMaxListeners(n) {
    if (typeof n !== "number" || n < 0) throw new TypeError("n must be a non-negative number");
    this._maxListeners = n;
  }

  getMaxListeners() {
    return this._maxListeners;
  }

  emit(eventType, payload = {}) {
    const listeners = this.listenerObjects(eventType);
    if (listeners.length === 0) return false;

    for (const l of listeners.slice()) {
      try {
        if (l.timeout > 0) {
          const maybePromise = l.handler.call(l.context, payload);
          if (maybePromise && typeof maybePromise.then === "function") {
            const t = setTimeout(() => {
              console.warn(`Handler timed out for event "${eventType}" (timeout ${l.timeout}ms)`);
            }, l.timeout);
            maybePromise.finally(() => clearTimeout(t));
          }
        } else {
          l.handler.call(l.context, payload);
        }
      } catch (err) {
        if (eventType !== "error" && this.listenerCount("error") > 0) {
          this.emit("error", { error: err, eventType, payload });
        } else {
          console.error(`Error in handler for ${eventType}:`, err);
        }
      } finally {
        if (l.once) this.off(eventType, l.handler);
      }
    }
    return true;
  }

  async emitAsync(eventType, payload = {}, { parallel = true } = {}) {
    const listeners = this.listenerObjects(eventType);
    if (listeners.length === 0) return { results: [], errors: [] };

    const results = [];
    const errors = [];

    const runHandler = async (l) => {
      try {
        if (l.timeout > 0) {
          const p = Promise.resolve().then(() => l.handler.call(l.context, payload));
          const timeoutP = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Handler timed out after ${l.timeout}ms for event "${eventType}"`)), l.timeout)
          );
          const res = await Promise.race([p, timeoutP]);
          return res;
        } else {
          return await l.handler.call(l.context, payload);
        }
      } catch (err) {
        if (eventType !== "error" && this.listenerCount("error") > 0) {
          this.emit("error", { error: err, eventType, payload });
        } else {
          errors.push(err);
        }
        return undefined;
      } finally {
        if (l.once) this.off(eventType, l.handler);
      }
    };

    if (parallel) {
      const promises = listeners.map(l => runHandler(l));
      const settled = await Promise.allSettled(promises);
      for (const s of settled) {
        if (s.status === "fulfilled") results.push(s.value);
        else errors.push(s.reason);
      }
    } else {
      for (const l of listeners) {
        try {
          const r = await runHandler(l);
          results.push(r);
        } catch (err) {
          errors.push(err);
        }
      }
    }

    return { results, errors };
  }

  waitFor(eventType, predicate = null, { timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const handler = (payload) => {
        try {
          if (!predicate || predicate(payload)) {
            this.off(eventType, handler);
            if (timer) clearTimeout(timer);
            resolve(payload);
          }
        } catch (err) {
          this.off(eventType, handler);
          if (timer) clearTimeout(timer);
          reject(err);
        }
      };
      this.on(eventType, handler, { once: false });
      let timer = null;
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.off(eventType, handler);
          reject(new Error(`waitFor timeout after ${timeout}ms for event "${eventType}"`));
        }, timeout);
      }
    });
  }

  createScoped(namespace) {
    const prefix = namespace.endsWith(":") ? namespace : `${namespace}:`;
    const scoped = {
      on: (evt, handler, options) => this.on(prefix + evt, handler, options),
      once: (evt, handler, options) => this.once(prefix + evt, handler, options),
      off: (evt, handler) => this.off(prefix + evt, handler),
      emit: (evt, payload) => this.emit(prefix + evt, payload),
      emitAsync: (evt, payload, opts) => this.emitAsync(prefix + evt, payload, opts),
      waitFor: (evt, predicate, opts) => this.waitFor(prefix + evt, predicate, opts),
      listeners: (evt) => this.listeners(prefix + evt),
      listenerCount: (evt) => this.listenerCount(prefix + evt),
      removeAllListeners: (evt) => this.removeAllListeners(prefix + evt),
    };
    return scoped;
  }

  addListener(eventType, handler, options = {}) {
    return this.on(eventType, handler, options);
  }

  inspect() {
    return {
      events: this.eventNames(),
      maxListeners: this._maxListeners,
      totalListeners: Array.from(this._listeners.values()).reduce((s, arr) => s + arr.length, 0) + this._patternListeners.length,
    };
  }

  /* ======================
     State-related API
     ====================== */

  // Get state by key (supports dot-paths). Returns deep clone to avoid accidental mutation.
  getState(key) {
    if (!key) return cloneDeep(this._state);
    const path = toPathArray(key);
    const val = getAtPath(this._state, path);
    return val === undefined ? undefined : cloneDeep(val);
  }

  // Sync state: update internal store and emit state events.
  // options: { emit = true, update = true, patch = false }
  syncState(key, value, options = {}) {
    const { emit = true, update = true, patch = false } = options;
    const path = toPathArray(key);
    const keyStr = path.join(".");
    const oldValue = getAtPath(this._state, path);
    let newValue = value;

    if (update) {
      if (patch && isPlainObject(oldValue) && isPlainObject(value)) {
        // shallow merge
        const merged = { ...oldValue, ...value };
        setAtPath(this._state, path, merged);
        newValue = merged;
      } else {
        setAtPath(this._state, path, cloneDeep(value));
      }
    }

    if (emit) {
      // general change event
      this.emit(`state:changed`, { key: keyStr, oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) });
      // per-key update event (convention: state:<key>.updated)
      this.emit(`state:${keyStr}.updated`, { key: keyStr, oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) });

      if (patch) {
        this.emit(`state:patch`, { key: keyStr, patch: cloneDeep(value), oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) });
        this.emit(`state:${keyStr}.patched`, { key: keyStr, patch: cloneDeep(value), oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) });
      } else {
        this.emit(`state:${keyStr}.changed`, { key: keyStr, oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) });
      }
    }

    return { key: keyStr, oldValue: cloneDeep(oldValue), newValue: cloneDeep(newValue) };
  }

  // Patch state for object at key
  patchState(key, delta, options = {}) {
    return this.syncState(key, delta, { ...options, patch: true });
  }

  // Reset state at key, or whole state if no key
  resetState(key, options = {}) {
    if (!key) {
      const old = cloneDeep(this._state);
      this._state = {};
      if (options.emit !== false) {
        this.emit("state:reset", { oldState: old, newState: {} });
      }
      return { oldState: old, newState: {} };
    }
    const path = toPathArray(key);
    const keyStr = path.join(".");
    const oldValue = getAtPath(this._state, path);
    // remove property
    if (path.length === 1) {
      delete this._state[path[0]];
    } else {
      const parentPath = path.slice(0, -1);
      const parent = getAtPath(this._state, parentPath);
      if (isPlainObject(parent)) {
        delete parent[path[path.length - 1]];
      }
    }
    if (options.emit !== false) {
      this.emit("state:reset", { key: keyStr, oldValue });
      this.emit(`state:${keyStr}.reset`, { key: keyStr, oldValue });
    }
    return { key: keyStr, oldValue };
  }

  // Wait for a state key to satisfy predicate (uses state:<key>.updated or state:changed)
  waitForState(key, predicate = null, { timeout = 0 } = {}) {
    const path = toPathArray(key);
    const keyStr = path.join(".");
    // prefer per-key update event
    const eventName = `state:${keyStr}.updated`;
    return this.waitFor(eventName, predicate, { timeout });
  }

  /* ======================
     Archetype API (with context validation)
     ====================== */

  // Lightweight context validation helper
  _validateContext(def, ctx) {
    // If def provides a custom validator function, call it. It can:
    // - return true/false, or
    // - throw an Error on invalid
    if (def && typeof def.contextValidator === "function") {
      try {
        const res = def.contextValidator(ctx);
        if (res === false) return { valid: false, reason: "contextValidator returned false" };
        return { valid: true };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    // If def provides a contextShape, perform a simple type check
    if (def && def.contextShape && typeof def.contextShape === "object") {
      const shape = def.contextShape;
      for (const key of Object.keys(shape)) {
        const expected = shape[key];
        const has = Object.prototype.hasOwnProperty.call(ctx ?? {}, key);
        if (expected && expected.__required && !has) {
          return { valid: false, reason: `missing required context key "${key}"` };
        }
        if (!has) continue;
        const val = ctx[key];
        // expected can be a string name of typeof or a constructor
        if (typeof expected === "string") {
          if (typeof val !== expected) {
            return { valid: false, reason: `context.${key} expected type ${expected} but got ${typeof val}` };
          }
        } else if (typeof expected === "function") {
          if (!(val instanceof expected)) {
            // allow primitives by checking constructor names as fallback (e.g., String)
            const ctorName = expected.name;
            if (!(typeof val === "object" && val != null && val.constructor && val.constructor.name === ctorName)) {
              return { valid: false, reason: `context.${key} expected instanceof ${expected.name}` };
            }
          }
        }
      }
      return { valid: true };
    }

    // No validator provided -> consider valid
    return { valid: true };
  }

  // registerArchetype(name, definition)
  // definition: {
  //   listeners: [{ event: 'user:login', handler, options }],
  //   onActivate: (ctx) => {},
  //   onDeactivate: (ctx) => {},
  //   contextValidator: (ctx) => boolean | throws,
  //   contextShape: { key: 'string'|'number'|Constructor|{__required:true, ...} },
  //   metadata: {...}
  // }
  registerArchetype(name, definition = {}) {
    if (!name) throw new Error("archetype name required");
    if (this._archetypes.has(name)) throw new Error(`archetype "${name}" already registered`);
    const arche = {
      name,
      definition,
      active: false,
      boundListeners: [], // { event, id }
      metadata: definition.metadata ?? {},
    };
    this._archetypes.set(name, arche);
    return arche;
  }

  activateArchetype(name, ctx = {}) {
    const arche = this._archetypes.get(name);
    if (!arche) throw new Error(`archetype "${name}" not found`);
    if (arche.active) return arche;
    const def = arche.definition || {};

    // Validate context before binding listeners
    const validation = this._validateContext(def, ctx);
    if (!validation.valid) {
      const err = new Error(`Archetype "${name}" context validation failed: ${validation.reason}`);
      // emit error event and abort activation
      if (this.listenerCount("error") > 0) {
        this.emit("error", { error: err, archetype: name, hook: "contextValidation" });
      } else {
        console.error(err);
      }
      throw err;
    }

    // register listeners declared on archetype (declarative)
    if (Array.isArray(def.listeners)) {
      for (const li of def.listeners) {
        const eventName = li.event;
        const handler = typeof li.handler === "function" ? li.handler.bind(ctx) : li.handler;
        const options = li.options ?? {};
        const id = this.on(eventName, handler, options);
        arche.boundListeners.push({ event: eventName, id });
      }
    }

    // call onActivate hook if provided
    if (typeof def.onActivate === "function") {
      try {
        def.onActivate.call(ctx, { engine: this, archetype: arche, ctx });
      } catch (err) {
        this.emit("error", { error: err, archetype: name, hook: "onActivate" });
      }
    }

    arche.active = true;
    // emit lifecycle events
    this.emit(`archetype:${name}.activated`, { archetype: name, ctx });
    return arche;
  }

  deactivateArchetype(name, ctx = {}) {
    const arche = this._archetypes.get(name);
    if (!arche) throw new Error(`archetype "${name}" not found`);
    if (!arche.active) return arche;

    // remove bound listeners
    for (const bl of arche.boundListeners) {
      this.off(bl.event, bl.id);
    }
    arche.boundListeners = [];

    // call onDeactivate hook if provided
    const def = arche.definition || {};
    if (typeof def.onDeactivate === "function") {
      try {
        def.onDeactivate.call(ctx, { engine: this, archetype: arche, ctx });
      } catch (err) {
        this.emit("error", { error: err, archetype: name, hook: "onDeactivate" });
      }
    }

    arche.active = false;
    this.emit(`archetype:${name}.deactivated`, { archetype: name, ctx });
    return arche;
  }

  createArchetype(name, definition = {}) {
    this.registerArchetype(name, definition);
    // Return a small helper object tied to this engine for convenience
    const engine = this;
    return {
      name,
      activate: (ctx) => engine.activateArchetype(name, ctx),
      deactivate: (ctx) => engine.deactivateArchetype(name, ctx),
      emitLocal: (evt, payload) => engine.emit(`archetype:${name}:${evt}`, payload),
      emitLocalAsync: (evt, payload, opts) => engine.emitAsync(`archetype:${name}:${evt}`, payload, opts),
      onLocal: (evt, handler, options) => engine.on(`archetype:${name}:${evt}`, handler, options),
      offLocal: (evt, handler) => engine.off(`archetype:${name}:${evt}`, handler),
      metadata: definition.metadata ?? {},
    };
  }
}

// Default instance
const defaultEngine = new EventEngine();

module.exports = {
  EventEngine,
  eventEngine: defaultEngine,
};

// Utility for debouncing
const debounce = (func, wait) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

export default class DOM3DManager {
  /**
   * @param {Object} params
   * @param {THREE.Scene} params.scene
   * @param {THREE.Camera} params.camera
   * @param {THREE.WebGLRenderer} params.renderer
   * @param {HTMLElement} [params.domRoot=document.body]
   * @param {boolean} [params.autoUpdate=false]
   * @param {Object} [params.defaults]
   * @param {number} [params.debounceMs=16]
   */
  constructor({ scene, camera, renderer, domRoot = document.body, autoUpdate = false, defaults = {}, debounceMs = 16 } = {}) {
    if (!scene || !camera || !renderer) throw new Error('scene, camera and renderer are required');

    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.domRoot = domRoot;
    this.debounceMs = debounceMs;

    // Raycasting + pointer
    this.raycaster = new THREE.Raycaster();
    this.mouseNDC = new THREE.Vector2();

    // Anchors and visibility management
    this.anchors = new Map();
    this.visibleAnchors = new Set();

    // Performance monitoring
    this.performance = {
      updateTime: 0,
      lastUpdateCount: 0,
      frameTimes: [],
      getAverageFrameTime: () => {
        const sum = this.performance.frameTimes.reduce((a, b) => a + b, 0);
        return this.performance.frameTimes.length ? sum / this.performance.frameTimes.length : 0;
      }
    };

    // Hover / hit tracking
    this._lastHit = null;
    this._lastHoveredEl = null;
    this._pointerDownTargets = new Set();

    // Enhanced defaults
    this.defaults = Object.assign({
      offset: new THREE.Vector3(),
      hideWhenOffscreen: true,
      followRotation: false,
      lerp: 0.18,
      fadeDistance: { near: 0, far: 50 },
      scaleDistance: { near: 1, far: 80, min: 0.5, max: 1.2 },
      zIndexFar: 1,
      zIndexNear: 1000,
      useCssTransition: true,
      transitionDuration: '180ms',
      rotation: { enabled: false, axis: 'y', multiplier: 1 },
      transformCallback: null,
      batchSize: 50,
    }, defaults);

    // Reusable temps
    this._tmpV3 = new THREE.Vector3();
    this._tmpV3b = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();

    // Viewport handling
    this._viewport = { width: 0, height: 0, left: 0, top: 0 };
    this._onResize = debounce(() => this._updateViewport(), 100);
    window.addEventListener('resize', this._onResize);

    // RAF loop control
    this._running = false;
    this._boundUpdate = (t) => this._rafLoop(t);

    // Enhanced event handlers
    this._eventHandlers = {
      pointerdown: debounce((e) => this._onPointer(e, 'pointerdown'), debounceMs),
      pointermove: debounce((e) => this._onPointer(e, 'pointermove'), debounceMs),
      pointerup: debounce((e) => this._onPointer(e, 'pointerup'), debounceMs),
      pointerleave: (e) => this._onPointerLeave(e)
    };

    this.renderer.domElement.addEventListener('pointerdown', this._eventHandlers.pointerdown);
    this.renderer.domElement.addEventListener('pointermove', this._eventHandlers.pointermove);
    window.addEventListener('pointerup', this._eventHandlers.pointerup);
    this.renderer.domElement.addEventListener('pointerleave', this._eventHandlers.pointerleave);

    // Adapters (opt-in)
    this.symbolAPI = null;
    this.memoryAPI = null;
    this.gestureAPI = null;
    this.stateAPI = null;
    this.narrativeAPI = null;
    this.hookAPI = null;

    // Meta-context / synergy
    this._metaContext = new Map();
    this._metaSubs = new Map();

    // Transactions / undo-redo
    this._transactions = [];
    this._txHistory = [];
    this._txPointer = -1;

    this._updateViewport();
    if (autoUpdate) this.start();
  }

  // --- Meta-context (synergy) ---
  publishMeta(topic, payload) {
    const prev = this._metaContext.has(topic) ? this._metaContext.get(topic) : undefined;
    this._metaContext.set(topic, payload);
    const subs = this._metaSubs.get(topic) || [];
    for (const cb of subs.slice()) try { cb(payload, prev); } catch (e) { /* swallow */ }
    this._recordTx({ type: 'metaPublish', topic, prev, new: payload });
  }
  onMeta(topic, cb) {
    if (!this._metaSubs.has(topic)) this._metaSubs.set(topic, []);
    this._metaSubs.get(topic).push(cb);
    return () => { this._metaSubs.set(topic, this._metaSubs.get(topic).filter(x => x !== cb)); };
  }
  readMeta(topic) { return this._metaContext.get(topic); }

  // --- Adapter attach ---
  attachSymbolAPI(api) { this.symbolAPI = api; return () => { this.symbolAPI = null; }; }
  attachMemoryAPI(api) { this.memoryAPI = api; return () => { this.memoryAPI = null; }; }
  attachGestureAPI(api) {
    this.gestureAPI = api;
    // if gesture API exposes registerAnchor-like contract, register existing anchors
    if (this.gestureAPI && typeof this.gestureAPI.registerAnchor === 'function') {
      for (const [el, s] of this.anchors.entries()) {
        try { this.gestureAPI.registerAnchor(el, { object3D: s.object, options: s.options }); } catch (_) {}
      }
    }
    return () => { this.gestureAPI = null; };
  }
  attachStateAPI(api) { this.stateAPI = api; return () => { this.stateAPI = null; }; }
  attachNarrativeAPI(api) { this.narrativeAPI = api; return () => { this.narrativeAPI = null; }; }
  attachHookAPI(api) { this.hookAPI = api; return () => { this.hookAPI = null; }; }

  // --- Transactions ---
  _recordTx(op) { if (!this._transactions.length) return; this._transactions[this._transactions.length - 1].ops.push(op); }
  beginTransaction(label = '') {
    const tx = { id: `tx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, label, ops: [], createdAt: Date.now() };
    this._transactions.push(tx);
    return tx.id;
  }
  commitTransaction() {
    if (!this._transactions.length) throw new Error('no active transaction');
    const tx = this._transactions.pop();
    tx.committedAt = Date.now();
    // trim redo chain
    this._txHistory.splice(this._txPointer + 1);
    this._txHistory.push(tx);
    this._txPointer = this._txHistory.length - 1;
    return tx.id;
  }
  rollbackTransaction() {
    if (!this._transactions.length) throw new Error('no active transaction');
    const tx = this._transactions.pop();
    for (let i = tx.ops.length - 1; i >= 0; i--) {
      const op = tx.ops[i];
      try {
        if (op.type === 'attach') {
          this.detach(op.element);
        } else if (op.type === 'detach') {
          this.attach(op.element, op.object, op.options);
        } else if (op.type === 'setOptions') {
          this.setAnchorOptions(op.element, op.prevOptions);
        } else if (op.type === 'metaPublish') {
          if (typeof op.prev === 'undefined') this._metaContext.delete(op.topic); else this._metaContext.set(op.topic, op.prev);
        } else if (op.type === 'memoryPersist') {
          // restore previous stored raw if available (best-effort)
          if (this.memoryAPI && typeof this.memoryAPI.store === 'function') {
            try {
              if (typeof op.prevRaw !== 'undefined') this.memoryAPI.store(op.memKey, op.prevRaw, { persist: true });
            } catch (_) {}
          }
        }
      } catch (e) { /* best-effort */ }
    }
    return tx.id;
  }
  async undo(steps = 1) {
    let undone = 0;
    while (undone < steps && this._txPointer >= 0) {
      const tx = this._txHistory[this._txPointer];
      this._transactions.push({ ops: tx.ops.slice() });
      this.rollbackTransaction();
      this._txPointer--;
      undone++;
    }
    return { undone };
  }
  async redo(steps = 1) {
    let redone = 0;
    while (redone < steps && this._txPointer < this._txHistory.length - 1) {
      const next = this._txHistory[this._txPointer + 1];
      for (const op of next.ops) {
        try {
          if (op.type === 'attach') this.attach(op.element, op.object, op.options);
          else if (op.type === 'detach') this.detach(op.element);
          else if (op.type === 'setOptions') this.setAnchorOptions(op.element, op.newOptions);
          else if (op.type === 'metaPublish') this._metaContext.set(op.topic, op.new);
        } catch (_) {}
      }
      this._txPointer = Math.min(this._txPointer + 1, this._txHistory.length - 1);
      redone++;
    }
    return { redone };
  }
  getTransactionHistory() { return this._txHistory.slice(); }

  // Update viewport measurements
  _updateViewport() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._viewport = {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top
    };
  }

  /**
   * Enhanced attach with rotation support and optional persistence
   * @param {HTMLElement} domEl
   * @param {THREE.Object3D} object3D
   * @param {Object} [options]
   */
  attach(domEl, object3D, options = {}) {
    if (!domEl || !object3D) throw new Error('domEl and object3D are required');
    const opts = Object.assign({}, this.defaults, options);

    domEl.style.position = 'absolute';
    domEl.style.willChange = 'transform, opacity, rotate';
    if (opts.useCssTransition) {
      domEl.style.transition = `transform ${opts.transitionDuration} linear, opacity ${opts.transitionDuration} linear, rotate ${opts.transitionDuration} linear`;
    }

    const state = {
      object: object3D,
      options: opts,
      screen: { x: 0, y: 0, z: 0 },
      vel: new THREE.Vector2(0, 0),
      lastVisible: false,
      lastDistance: null,
      lastRotation: 0
    };

    this.anchors.set(domEl, state);
    object3D.userData = object3D.userData || {};
    object3D.userData.domElement = domEl;

    // record transaction op
    this._recordTx({ type: 'attach', element: domEl, object: object3D, options: opts });

    // integrate with gestureAPI if attached
    if (this.gestureAPI && typeof this.gestureAPI.registerAnchor === 'function') {
      try { this.gestureAPI.registerAnchor(domEl, { object3D, options: opts }); } catch (_) {}
    }

    // persist anchor meta to memoryAPI if requested
    if (opts.persistAnchor && this.memoryAPI && typeof this.memoryAPI.store === 'function') {
      try {
        const memKey = `dom3d:anchor:${domEl.id || Math.random().toString(36).slice(2,8)}`;
        const rawPrev = (this.memoryAPI.recall && this.memoryAPI.recall(memKey)) || undefined;
        this._recordTx({ type: 'memoryPersist', memKey, prevRaw: rawPrev });
        this.memoryAPI.store(memKey, { options: opts }, { persist: true }).catch(()=>{});
      } catch (_) {}
    }

    // Initial visibility check
    this._updateAnchorVisibility(domEl, state);
  }

  detach(domEl) {
    if (this.anchors.has(domEl)) {
      const prev = this.anchors.get(domEl);
      this.anchors.delete(domEl);
      this.visibleAnchors.delete(domEl);
      domEl.style.transform = '';
      domEl.style.opacity = '';
      domEl.style.display = '';
      domEl.style.transition = '';
      domEl.style.rotate = '';

      // record transaction
      this._recordTx({ type: 'detach', element: domEl, object: prev.object, options: prev.options });

      // unregister from gestureAPI if applicable
      if (this.gestureAPI && typeof this.gestureAPI.removeAnchor === 'function') {
        try { this.gestureAPI.removeAnchor(domEl); } catch (_) {}
      }
    }
  }

  setAnchorOptions(domEl, updates = {}) {
    const s = this.anchors.get(domEl);
    if (!s) return;
    const prevOptions = Object.assign({}, s.options);
    s.options = Object.assign({}, s.options, updates);
    this._updateAnchorVisibility(domEl, s);
    this._recordTx({ type: 'setOptions', element: domEl, prevOptions, newOptions: s.options });

    // persist updated options if memoryAPI attached and option requests persistence
    if (s.options.persistAnchor && this.memoryAPI && typeof this.memoryAPI.store === 'function') {
      try {
        const memKey = `dom3d:anchor:${domEl.id || Math.random().toString(36).slice(2,8)}`;
        this.memoryAPI.store(memKey, { options: s.options }, { persist: true }).catch(()=>{});
      } catch (_) {}
    }
  }

  worldToScreen(world) {
    const v = world.clone().project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this._viewport.width + this._viewport.left,
      y: (-v.y * 0.5 + 0.5) * this._viewport.height + this._viewport.top,
      visible: v.x >= -1 && v.x <= 1 && v.y >= -1 && v.y <= 1 && v.z <= 1,
      ndc: v
    };
  }

  _updateAnchorVisibility(domEl, state) {
    const pos = this._tmpV3.setFromMatrixPosition(state.object.matrixWorld).project(this.camera);
    const visible = pos.x >= -1 && pos.x <= 1 && pos.y >= -1 && pos.y <= 1 && pos.z <= 1;
    if (visible) {
      this.visibleAnchors.add(domEl);
    } else {
      this.visibleAnchors.delete(domEl);
    }
    return visible;
  }

  update(dt = 0.016) {
    const startTime = performance.now();
    const { width, height, left, top } = this._viewport;
    const camera = this.camera;
    const tmp = this._tmpV3;
    const tmpb = this._tmpV3b;
    const tmpQuat = this._tmpQuat;

    // Process anchors in batches
    const anchorArray = Array.from(this.anchors.entries());
    const batchSize = this.defaults.batchSize;

    for (let i = 0; i < anchorArray.length; i += batchSize) {
      const batch = anchorArray.slice(i, i + batchSize);

      for (const [el, s] of batch) {
        const { object, options } = s;
        object.updateWorldMatrix(true, false);
        tmp.setFromMatrixPosition(object.matrixWorld);

        if (options.offset && options.offset.isVector3) {
          tmp.add(options.offset);
        } else if (options.offset && options.offset.x !== undefined) {
          tmp.add(new THREE.Vector3(options.offset.x, options.offset.y, options.offset.z));
        }

        // Visibility culling
        if (!this._updateAnchorVisibility(el, s)) {
          if (options.hideWhenOffscreen && s.lastVisible !== false) {
            el.style.display = 'none';
            s.lastVisible = false;
          }
          continue;
        }

        if (s.lastVisible === false) {
          el.style.display = '';
          s.lastVisible = true;
        }

        // Project to NDC
        tmp.project(camera);
        const ndcX = tmp.x;
        const ndcY = tmp.y;
        const ndcZ = tmp.z;

        // Convert to pixel coords
        const px = (ndcX * 0.5 + 0.5) * width + left;
        const py = (-ndcY * 0.5 + 0.5) * height + top;

        // Distance calculations
        const worldDistance = camera.position.distanceTo(tmpb.setFromMatrixPosition(object.matrixWorld));
        s.lastDistance = worldDistance;

        // Smoothing
        const alpha = Math.max(0, Math.min(1, options.lerp !== undefined ? options.lerp : this.defaults.lerp));
        const curX = el._dom3d_x !== undefined ? el._dom3d_x : px;
        const curY = el._dom3d_y !== undefined ? el._dom3d_y : py;
        const nextX = curX + (px - curX) * alpha;
        const nextY = curY + (py - curY) * alpha;
        el._dom3d_x = nextX;
        el._dom3d_y = nextY;

        // Scale mapping
        const sd = options.scaleDistance || this.defaults.scaleDistance;
        let scale = 1;
        if (sd) {
          const { near, far, min = 0.5, max = 1.2 } = sd;
          if (worldDistance <= near) scale = max;
          else if (worldDistance >= far) scale = min;
          else {
            const t = (worldDistance - near) / (far - near);
            scale = max + (min - max) * t;
          }
        }

        // Opacity mapping
        const fd = options.fadeDistance || this.defaults.fadeDistance;
        let opacity = 1;
        if (fd) {
          const { near = 0, far = 50 } = fd;
          if (worldDistance <= near) opacity = 1;
          else if (worldDistance >= far) opacity = 0;
          else opacity = 1 - ((worldDistance - near) / (far - near));
        }

        // Z-index
        const zFar = options.zIndexFar ?? this.defaults.zIndexFar;
        const zNear = options.zIndexNear ?? this.defaults.zIndexNear;
        const z = Math.round(zFar + (zNear - zFar) * (1 - Math.min(1, (worldDistance - (fd?.near||0)) / ((fd?.far||50) - (fd?.near||0) || 1))));
        el.style.zIndex = String(z);

        // Rotation handling
        let rotation = 0;
        if (options.rotation?.enabled) {
          object.getWorldQuaternion(tmpQuat);
          const euler = new THREE.Euler().setFromQuaternion(tmpQuat);
          rotation = THREE.MathUtils.radToDeg(euler[options.rotation.axis || 'y']) * (options.rotation.multiplier || 1);
        }

        // Apply transform
        let transform = `translate3d(${Math.round(nextX)}px, ${Math.round(nextY)}px, 0) translate(-50%, -50%) scale(${scale})`;
        if (options.rotation?.enabled) {
          transform += ` rotate(${rotation}deg)`;
        }

        // Custom transform callback
        if (options.transformCallback) {
          transform = options.transformCallback({
            transform,
            position: { x: nextX, y: nextY },
            scale,
            rotation,
            opacity,
            element: el,
            object,
            distance: worldDistance
          }) || transform;
        }

        el.style.transform = transform;
        el.style.opacity = String(Number(opacity.toFixed(2)));
        if (options.rotation?.enabled) {
          el.style.rotate = `${rotation}deg`;
        }

        s.screen.x = nextX;
        s.screen.y = nextY;
        s.screen.z = ndcZ;
        s.lastRotation = rotation;
      }
    }

    // Update performance metrics
    this.performance.updateTime = performance.now() - startTime;
    this.performance.lastUpdateCount = anchorArray.length;
    this.performance.frameTimes.push(this.performance.updateTime);
    if (this.performance.frameTimes.length > 100) {
      this.performance.frameTimes.shift();
    }
  }

  start() {
    if (!this._running) {
      this._running = true;
      this._lastRAFTime = performance.now();
      requestAnimationFrame(this._boundUpdate);
    }
  }

  stop() {
    this._running = false;
  }

  _rafLoop(now) {
    if (!this._running) return;
    const dt = Math.max(0.0001, (now - (this._lastRAFTime || now)) / 1000);
    this._lastRAFTime = now;
    try {
      this.update(dt);
    } catch (err) {
      console.error('DOM3DManager update error:', err);
    }
    requestAnimationFrame(this._boundUpdate);
  }

  _pointerEventToNDC(e) {
    const { width, height, left, top } = this._viewport;
    this.mouseNDC.x = ((e.clientX - left) / width) * 2 - 1;
    this.mouseNDC.y = -((e.clientY - top) / height) * 2 + 1;
  }

  _onPointer(e, type = 'pointermove') {
    this._pointerEventToNDC(e);
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    const intersects = this.raycaster.intersectObjects(this.scene.children, true);

    const hit = intersects.length ? intersects[0] : null;
    const prevHit = this._lastHit;
    this._lastHit = hit;

    if (type === 'pointerdown') {
      if (hit) {
        const detail = { point: hit.point.clone(), object: hit.object, face: hit.face, originalEvent: e };
        this._dispatchEventToDomForHit(hit, '3d-pointerdown', detail, e);
        this._pointerDownTargets.add(hit.object);
        // call hook API if attached
        if (this.hookAPI && typeof this.hookAPI.trigger === 'function') {
          try { this.hookAPI.trigger('3d:pointerdown', { hit: detail }); } catch (_) {}
        }
      }
    } else if (type === 'pointermove') {
      if (hit && (!prevHit || prevHit.object !== hit.object)) {
        this._dispatchEventToDomForHit(hit, '3d-hover', { point: hit.point.clone(), object: hit.object, originalEvent: e }, e);
      }
      if (prevHit && (!hit || prevHit.object !== hit.object)) {
        this._dispatchEventToDomForHit(prevHit, '3d-blur', { object: prevHit.object, originalEvent: e }, e);
      }
      if (hit) {
        this._dispatchEventToDomForHit(hit, '3d-pointermove', { point: hit.point.clone(), object: hit.object, originalEvent: e }, e);
      }
    } else if (type === 'pointerup') {
      if (hit) {
        this._dispatchEventToDomForHit(hit, '3d-pointerup', { point: hit.point.clone(), object: hit.object, originalEvent: e }, e);
        if (this._pointerDownTargets.has(hit.object)) {
          this._dispatchEventToDomForHit(hit, '3d-click', { point: hit.point.clone(), object: hit.object, originalEvent: e }, e);
          // integrations on click/hit:
          this._onHitIntegration(hit, e);
        }
      }
      this._pointerDownTargets.clear();
    }
  }

  _onPointerLeave(e) {
    if (this._lastHit) {
      this._dispatchEventToDomForHit(this._lastHit, '3d-blur', { object: this._lastHit.object, originalEvent: e }, e);
      this._lastHit = null;
    }
  }

  _dispatchEventToDomForHit(hit, eventName, detail, originalEvent) {
    let current = hit.object;
    let targetEl = null;
    while (current) {
      if (current.userData && current.userData.domElement) {
        targetEl = current.userData.domElement;
        break;
      }
      current = current.parent;
    }

    const ce = new CustomEvent(eventName, { detail: Object.assign({}, detail, { originalEvent }), bubbles: true, cancelable: true });
    if (targetEl) targetEl.dispatchEvent(ce);
    try { this.renderer.domElement.dispatchEvent(ce); } catch (_) {}
    // also call hookAPI if attached
    if (this.hookAPI && typeof this.hookAPI.trigger === 'function') {
      try { this.hookAPI.trigger(eventName, { detail }).catch?.(()=>{}); } catch (_) {}
    }
  }

  // handle integrations when a 3D object is clicked/hit
  _onHitIntegration(hit, originalEvent) {
    const object = hit.object;
    const domEl = object.userData && object.userData.domElement;
    const anchorState = domEl ? this.anchors.get(domEl) : null;

    // 1) Symbolic logic: if anchor has symbol pattern, call symbolAPI.apply
    try {
      if (anchorState && anchorState.options?.symbolPattern && this.symbolAPI && typeof this.symbolAPI.apply === 'function') {
        this.symbolAPI.apply({ pattern: anchorState.options.symbolPattern, context: { object, hit } }).catch(()=>{});
      }
    } catch (_) {}

    // 2) Memory: record detection or store anchor metadata
    try {
      if (anchorState && anchorState.options?.persistDetection && this.memoryAPI && typeof this.memoryAPI.store === 'function') {
        const memKey = anchorState.options.memKey || `dom3d:detect:${domEl?.id || Math.random().toString(36).slice(2,8)}`;
        this.memoryAPI.store(memKey, { time: Date.now(), objectId: object.id, anchorOptions: anchorState.options }, { persist: !!anchorState.options.persistDetection }).catch(()=>{});
      }
    } catch (_) {}

    // 3) State: update state store if attached
    try {
      if (anchorState && anchorState.options?.stateKey && this.stateAPI && typeof this.stateAPI.set === 'function') {
        this.stateAPI.set(anchorState.options.stateKey, { lastHitAt: Date.now(), objectId: object.id }).catch?.(()=>{});
      }
    } catch (_) {}

    // 4) Narrative: track progression event if narrativeAPI attached
    try {
      if (this.narrativeAPI && typeof this.narrativeAPI.track === 'function') {
        this.narrativeAPI.track({ event: '3d-click', objectId: object.id, anchor: domEl?.id || null }).catch?.(()=>{});
      }
    } catch (_) {}

    // 5) Gesture integration: forward hit to gesture engine if present
    try {
      if (this.gestureAPI && typeof this.gestureAPI.trigger === 'function' && anchorState && anchorState.options?.gestureEvent) {
        this.gestureAPI.trigger(anchorState.options.gestureEvent, { element: domEl, object, hit }).catch?.(()=>{});
      }
    } catch (_) {}
  }

  // Get performance metrics
  getPerformanceMetrics() {
    return {
      averageFrameTime: this.performance.getAverageFrameTime(),
      lastUpdateCount: this.performance.lastUpdateCount,
      anchorCount: this.anchors.size,
      visibleAnchorCount: this.visibleAnchors.size
    };
  }

  dispose() {
    this.stop();
    this.renderer.domElement.removeEventListener('pointerdown', this._eventHandlers.pointerdown);
    this.renderer.domElement.removeEventListener('pointermove', this._eventHandlers.pointermove);
    window.removeEventListener('pointerup', this._eventHandlers.pointerup);
    this.renderer.domElement.removeEventListener('pointerleave', this._eventHandlers.pointerleave);
    window.removeEventListener('resize', this._onResize);

    for (const el of Array.from(this.anchors.keys())) {
      this.detach(el);
    }
    this.anchors.clear();
    this.visibleAnchors.clear();
    // clear adapters
    this.symbolAPI = null;
    this.memoryAPI = null;
    this.gestureAPI = null;
    this.stateAPI = null;
    this.narrativeAPI = null;
    this.hookAPI = null;
  }
}
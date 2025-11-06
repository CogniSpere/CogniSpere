// DOM3DToGPUBridge.js
// Enhanced with hooks/events, transactions, undo/redo, history, meta/synergy awareness, and conditional logic.
// Minimal, non-invasive additions; original rendering logic preserved.
import * as THREE from './three.module.js';


// Utility for performance monitoring
const performanceMetrics = {
  frameTimes: [],
  updateCount: 0,
  getAverageFrameTime() {
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return this.frameTimes.length ? sum / this.frameTimes.length : 0;
  }
};

// Small Emitter for events/hooks
class Emitter {
  constructor() { this._listeners = new Map(); }
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(cb);
    return () => this.off(event, cb);
  }
  off(event, cb) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
  }
  emit(event, ...args) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    // call copy to avoid mutation during iteration
    for (const cb of arr.slice()) {
      try { cb(...args); } catch (err) { console.error(`Emitter handler error for ${event}:`, err); }
    }
  }
}

export default class DOM3DToGPUBridge {
  constructor({ dom3d, canvas, maxAnchors = 128, clearColor = [0, 0, 0, 0], customShaders = {} } = {}) {
    if (!dom3d) throw new Error('dom3d is required');

    this.dom3d = dom3d;
    this.canvas = canvas || this._createOverlayCanvas();
    this.maxAnchors = maxAnchors;
    this.clearColor = clearColor;
    this.customShaders = {
      vertex: customShaders.vertex || null,
      fragment: customShaders.fragment || null
    };

    // State
    this.rafHandle = null;
    this.running = false;
    this.useWebGPU = false;
    this.useWebGL2 = false;
    this.anchorData = new Float32Array(maxAnchors * 5); // Extended to include scale
    this.instanceCount = 0;

    // WebGPU state
    this.gpu = null;
    this.adapter = null;
    this.device = null;
    this.context = null;
    this.format = null;
    this.pipeline = null;
    this.anchorsBuffer = null;

    // WebGL state
    this.gl = null;
    this.glProgram = null;
    this.glAnchorsBuffer = null;

    // Canvas2D state
    this.ctx2d = null;

    // Performance and timing
    this.lastFrameTime = 0;
    this.frameDelta = 0;

    // Hooks / events / history / transactions / undo
    this.emitter = new Emitter();
    this.history = []; // list of { id, type, ts, meta, snapshot }
    this.transaction = null; // { id, snapshot, ops: [] }
    this.undoStack = [];
    this.redoStack = [];

    // Synergy/meta integration
    this.synergyInstance = null;
    this.metaContext = {};

    // Conditions/adaptive hooks
    this.conditions = {
      render: null,      // fn(context) => boolean
      anchorFilter: null // fn(anchorObj) => boolean
    };

    // Performance metrics alias
    this._perf = performanceMetrics;

    // Bind resize handler
    this._resizeHandler = () => this._resizeCanvasToDisplaySize(this.canvas);
    window.addEventListener('resize', this._resizeHandler);
  }

  // ======= Small public API additions =======
  on(event, cb) { return this.emitter.on(event, cb); }
  off(event, cb) { return this.emitter.off(event, cb); }
  addHook(event, cb) { return this.on(event, cb); } // alias
  registerSynergy(s) { this.synergyInstance = s || null; return () => { this.synergyInstance = null; }; }
  setMetaContext(ctx = {}) { this.metaContext = ctx || {}; }
  setRenderCondition(fn) { this.conditions.render = isFunction(fn) ? fn : null; }
  setAnchorFilter(fn) { this.conditions.anchorFilter = isFunction(fn) ? fn : null; }

  // simple helpers
  getHistory(filter = {}) {
    let out = this.history.slice();
    if (filter.type) out = out.filter(h => h.type === filter.type);
    if (filter.since) out = out.filter(h => h.ts >= filter.since);
    return out;
  }
  getIntrospection() {
    return {
      maxAnchors: this.maxAnchors,
      instanceCount: this.instanceCount,
      running: this.running,
      performance: {
        averageFrameTime: this._perf.getAverageFrameTime(),
        updateCount: this._perf.updateCount
      },
      historyLength: this.history.length
    };
  }
  serialize({ includeHistory = false } = {}) {
    const anchors = this._getAnchorsSerialized();
    return JSON.stringify({
      maxAnchors: this.maxAnchors,
      clearColor: this.clearColor,
      anchors,
      metaContext: this.metaContext,
      history: includeHistory ? this.history.slice() : undefined
    });
  }
  async deserialize(serialized) {
    const obj = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    if (!obj) return { restored: 0 };
    this.maxAnchors = obj.maxAnchors || this.maxAnchors;
    if (Array.isArray(obj.clearColor)) this.clearColor = obj.clearColor;
    if (obj.metaContext) this.metaContext = obj.metaContext;
    // restore anchors if possible
    if (Array.isArray(obj.anchors) && typeof this.dom3d.setAnchors === 'function') {
      try {
        await this.dom3d.setAnchors(obj.anchors);
      } catch (e) { /* best-effort */ }
    }
    if (obj.history && Array.isArray(obj.history)) this.history = obj.history.slice();
    return { restored: 1 };
  }

  // ======= Internal utilities =======
  _createOverlayCanvas() {
    const c = document.createElement('canvas');
    c.style.position = 'absolute';
    c.style.left = '0';
    c.style.top = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.pointerEvents = 'none';
    document.body.appendChild(c);
    this._resizeCanvasToDisplaySize(c);
    return c;
  }

  _resizeCanvasToDisplaySize(c) {
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
  }

  async init() {
    try {
      this.emitter.emit('init', { bridge: this });
      this._perf.frameTimes = [];
      this._perf.updateCount = 0;

      this.gpu = navigator.gpu;
      if (this.gpu) {
        try {
          this.adapter = await this.gpu.requestAdapter();
          if (this.adapter) {
            this.device = await this.adapter.requestDevice();
            this.context = this.canvas.getContext('webgpu');
            if (this.context && this.device) {
              this.format = this.gpu.getPreferredCanvasFormat?.() || 'bgra8unorm';
              this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'premultiplied',
              });
              this.useWebGPU = true;
              await this._initWebGPUPipeline();
              this.emitter.emit('init:gpu', { ok: true });
              return;
            }
          }
        } catch (err) {
          console.warn('WebGPU initialization failed:', err);
          this.emitter.emit('error', { phase: 'init', error: err });
          this.useWebGPU = false;
        }
      }

      // Fallback to WebGL2
      this.gl = this.canvas.getContext('webgl2') || this.canvas.getContext('webgl');
      if (this.gl) {
        this.useWebGL2 = true;
        this._initWebGLPipeline();
        this.emitter.emit('init:webgl', { ok: true });
      } else {
        // Fallback to Canvas2D
        this.ctx2d = this.canvas.getContext('2d');
        if (!this.ctx2d) {
          const err = new Error('No rendering context available');
          this.emitter.emit('error', { phase: 'init', error: err });
          throw err;
        }
        this.emitter.emit('init:2d', { ok: true });
      }
    } catch (err) {
      console.error('Initialization failed:', err);
      this.emitter.emit('error', { phase: 'init', error: err });
      throw err;
    }
  }

  async _initWebGPUPipeline() {
    if (!this.device || !this.context) return;

const defaultVertWGSL = `
struct Anchor {
  pos: vec4<f32>,
  scale: f32,
};

struct VertexOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) scale: f32,
};

`;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32,
           @builtin(instance_index) instance_idx: u32) -> VertexOut {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0)
  );

  let anchor = anchors[instance_idx];
  let base = vec4<f32>(anchor.pos.x, anchor.pos.y, anchor.pos.z, 1.0);
  let scale = anchor.scale * 0.05;
  let off = quad[vertex_index] * scale;

  var out: VertexOut;
  out.pos = base + vec4<f32>(off.x, off.y, 0.0, 0.0);
  out.uv = (quad[vertex_index] + vec2<f32>(1.0,1.0)) * 0.5;
  out.scale = anchor.scale;
  return out;
}
`;

    const defaultFragWGSL = `
@fragment
fn fs_main(@location(0) uv: vec2<f32>, @location(1) scale: f32) -> @location(0) vec4<f32> {
  let d = distance(uv, vec2<f32>(0.5,0.5));
  let alpha = smoothstep(0.5, 0.0, d) * clamp(scale, 0.5, 2.0);
  return vec4<f32>(0.2, 0.9, 0.95, alpha * 0.9);
}
`;

    const vertWGSL = this.customShaders.vertex || defaultVertWGSL;
    const fragWGSL = this.customShaders.fragment || defaultFragWGSL;

    const moduleVert = this.device.createShaderModule({ code: vertWGSL });
    const moduleFrag = this.device.createShaderModule({ code: fragWGSL });

    // Dynamic buffer sizing
    const anchorsBufferSize = this.maxAnchors * 5 * 4; // 5 floats (pos + scale)
    this.anchorsBuffer = this.device.createBuffer({
      size: anchorsBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      }],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: moduleVert,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: moduleFrag,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none',
      },
    });

    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: this.anchorsBuffer },
      }],
    });

    this.pipeline.__bindGroup = bindGroup;
  }

  _initWebGLPipeline() {
    if (!this.gl) return;
    const gl = this.gl;

    const vs = `#version 300 es
    precision highp float;
    uniform vec4 anchors[${this.maxAnchors}];
    out vec2 v_uv;
    out float v_scale;
    void main() {
      vec2 quad[6];
      quad[0]=vec2(-1.0,-1.0);
      quad[1]=vec2(1.0,-1.0);
      quad[2]=vec2(-1.0,1.0);
      quad[3]=vec2(-1.0,1.0);
      quad[4]=vec2(1.0,-1.0);
      quad[5]=vec2(1.0,1.0);
      int vi = int(gl_VertexID) % 6;
      vec4 a = anchors[gl_InstanceID];
      float scale = a.w * 0.05;
      vec2 pos = a.xy + quad[vi] * scale;
      gl_Position = vec4(pos, a.z, 1.0);
      v_uv = (quad[vi] + 1.0) * 0.5;
      v_scale = a.w;
    }`;

    const fs = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    in float v_scale;
    out vec4 outColor;
    void main() {
      float d = distance(v_uv, vec2(0.5));
      float alpha = smoothstep(0.5, 0.0, d) * clamp(v_scale, 0.5, 2.0);
      outColor = vec4(0.2, 0.9, 0.95, alpha * 0.9);
    }`;

    try {
      const vert = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vert, vs);
      gl.compileShader(vert);
      if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
        throw new Error(`Vertex shader compile error: ${gl.getShaderInfoLog(vert)}`);
      }

      const frag = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(frag, fs);
      gl.compileShader(frag);
      if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
        throw new Error(`Fragment shader compile error: ${gl.getShaderInfoLog(frag)}`);
      }

      const prog = gl.createProgram();
      gl.attachShader(prog, vert);
      gl.attachShader(prog, frag);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`Program link error: ${gl.getProgramInfoLog(prog)}`);
      }

      this.glProgram = prog;

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.bindVertexArray(null);
    } catch (err) {
      console.error('WebGL pipeline initialization failed:', err);
      this.useWebGL2 = false;
      this.ctx2d = this.canvas.getContext('2d');
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.emitter.emit('start', { ts: Date.now() });
    const tick = (t) => {
      this.frameDelta = (t - this.lastFrameTime) / 1000;
      this.lastFrameTime = t;
      try {
        this.update();
      } catch (err) {
        this.emitter.emit('error', { phase: 'frame', error: err });
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.lastFrameTime = performance.now();
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafHandle != null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.emitter.emit('stop', { ts: Date.now() });
  }

  // Transactions: snapshot anchors via dom3d if available, else snapshot anchorData
  beginTransaction(id) {
    if (this.transaction) throw new Error('Transaction already in progress');
    const snapshot = {
      anchors: this._getAnchorsSerialized(),
      anchorData: Array.from(this.anchorData),
      maxAnchors: this.maxAnchors,
      instanceCount: this.instanceCount,
      meta: { ts: Date.now(), id: id || `tx-${Date.now()}` }
    };
    this.transaction = { id: snapshot.meta.id, snapshot, ops: [] };
    this.emitter.emit('transaction:start', { id: this.transaction.id });
    return this.transaction.id;
  }

  commitTransaction(meta = {}) {
    if (!this.transaction) throw new Error('No transaction in progress');
    const entry = {
      id: this.transaction.id,
      type: 'transaction:commit',
      ts: Date.now(),
      meta,
      snapshot: this.transaction.snapshot
    };
    this.history.push(entry);
    this.undoStack.push(entry);
    this.transaction = null;
    this.emitter.emit('transaction:commit', entry);
    if (this.synergyInstance && typeof this.synergyInstance.trigger === 'function') {
      try { this.synergyInstance.trigger(Object.assign({ event: 'bridge:transaction:commit', id: entry.id }, this.metaContext)); } catch (_) {}
    }
    return entry;
  }

  rollbackTransaction() {
    if (!this.transaction) throw new Error('No transaction in progress');
    const snap = this.transaction.snapshot;
    // Restore anchors best-effort
    if (snap.anchors && typeof this.dom3d.setAnchors === 'function') {
      try {
        this.dom3d.setAnchors(snap.anchors);
      } catch (e) { /* ignore */ }
    } else {
      // restore local anchorData
      try {
        const arr = snap.anchorData || [];
        for (let i = 0; i < Math.min(arr.length, this.anchorData.length); i++) this.anchorData[i] = arr[i];
        this.instanceCount = snap.instanceCount || 0;
      } catch (e) { /* ignore */ }
    }
    const entry = {
      id: this.transaction.id,
      type: 'transaction:rollback',
      ts: Date.now(),
      meta: {},
      snapshot: this.transaction.snapshot
    };
    this.history.push(entry);
    this.undoStack.push(entry);
    this.transaction = null;
    this.emitter.emit('transaction:rollback', entry);
    if (this.synergyInstance && typeof this.synergyInstance.trigger === 'function') {
      try { this.synergyInstance.trigger(Object.assign({ event: 'bridge:transaction:rollback', id: entry.id }, this.metaContext)); } catch (_) {}
    }
    return entry;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    // Only transaction entries have snapshots to restore
    if (entry.snapshot) {
      const snap = entry.snapshot;
      if (snap.anchors && typeof this.dom3d.setAnchors === 'function') {
        try { this.dom3d.setAnchors(snap.anchors); } catch (_) {}
      } else {
        const arr = snap.anchorData || [];
        for (let i = 0; i < Math.min(arr.length, this.anchorData.length); i++) this.anchorData[i] = arr[i];
        this.instanceCount = snap.instanceCount || 0;
      }
      this.redoStack.push(entry);
      this.history.push({ id: `h-undo-${Date.now()}`, type: 'undo', ts: Date.now(), meta: { ref: entry.id } });
      this.emitter.emit('undo', { entry });
      return entry;
    }
    return null;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    if (entry.snapshot) {
      const snap = entry.snapshot;
      if (snap.anchors && typeof this.dom3d.setAnchors === 'function') {
        try { this.dom3d.setAnchors(snap.anchors); } catch (_) {}
      } else {
        const arr = snap.anchorData || [];
        for (let i = 0; i < Math.min(arr.length, this.anchorData.length); i++) this.anchorData[i] = arr[i];
        this.instanceCount = snap.instanceCount || 0;
      }
      this.undoStack.push(entry);
      this.history.push({ id: `h-redo-${Date.now()}`, type: 'redo', ts: Date.now(), meta: { ref: entry.id } });
      this.emitter.emit('redo', { entry });
      return entry;
    }
    return null;
  }

  // Render loop core
  update() {
    const startTime = performance.now();

    // Respect render condition if provided
    try {
      if (this.conditions.render && !this.conditions.render({ bridge: this, meta: this.metaContext })) {
        this._perf.frameTimes.push(performance.now() - startTime);
        if (this._perf.frameTimes.length > 100) this._perf.frameTimes.shift();
        this._perf.updateCount++;
        this.emitter.emit('frame:skipped', { ts: Date.now() });
        return;
      }
    } catch (err) {
      this.emitter.emit('error', { phase: 'condition', error: err });
    }

    // Dynamic buffer resizing
    const anchors = this._getAnchors();
    if (anchors.length > this.maxAnchors) {
      this.maxAnchors = Math.ceil(anchors.length * 1.5);
      this.anchorData = new Float32Array(this.maxAnchors * 5);
      if (this.useWebGPU && this.device) {
        try {
          this.anchorsBuffer?.destroy();
        } catch (_) {}
        this.anchorsBuffer = this.device.createBuffer({
          size: this.maxAnchors * 5 * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
      }
    }

    const count = Math.min(this.maxAnchors, anchors.length);
    this.instanceCount = count;

    const rendererRect = this.dom3d?.renderer?.domElement?.getBoundingClientRect?.();
    const width = rendererRect ? rendererRect.width : this.canvas.width;
    const height = rendererRect ? rendererRect.height : this.canvas.height;

    for (let i = 0; i < count; i++) {
      const a = anchors[i];
      let wx = 0, wy = 0, wz = 0, scale = 1;
      try {
        if (a.object) {
          if (typeof a.object.getWorldPosition === 'function') {
            const v = a.object.getWorldPosition(new THREE.Vector3());
            wx = v.x;
            wy = v.y;
            wz = v.z;
            if (this.dom3d?.camera) {
              const vec = new THREE.Vector3(wx, wy, wz);
              vec.project(this.dom3d.camera);
              wx = vec.x;
              wy = vec.y;
              wz = vec.z;
            }
          } else if (a.object.position) {
            wx = a.object.position.x || 0;
            wy = a.object.position.y || 0;
            wz = a.object.position.z || 0;
          }
          // Get scale from options if available
          scale = a.options?.scaleDistance?.max || 1;
        }

        if (typeof this.dom3d.worldToScreen === 'function') {
          const world = new THREE.Vector3(wx, wy, wz);
          const s = this.dom3d.worldToScreen(world);
          if (s && typeof s.x === 'number') {
            const ndcX = ((s.x - (rendererRect?.left ?? 0)) / (rendererRect?.width ?? width)) * 2 - 1;
            const ndcY = -(((s.y - (rendererRect?.top ?? 0)) / (rendererRect?.height ?? height)) * 2 - 1);
            wx = ndcX;
            wy = ndcY;
            wz = s.visible ? wz : 1.0;
          }
        }
      } catch (err) {
        console.warn('Error processing anchor:', err);
        this.emitter.emit('error', { phase: 'anchor-processing', error: err });
      }

      const base = i * 5;
      this.anchorData[base + 0] = wx;
      this.anchorData[base + 1] = wy;
      this.anchorData[base + 2] = wz;
      this.anchorData[base + 3] = 1.0; // visibility
      this.anchorData[base + 4] = scale;
    }

    // Clear remaining buffer
    for (let i = count; i < this.maxAnchors; i++) {
      const b = i * 5;
      this.anchorData[b + 0] = 0;
      this.anchorData[b + 1] = 0;
      this.anchorData[b + 2] = 1.0;
      this.anchorData[b + 3] = 0;
      this.anchorData[b + 4] = 1;
    }

    // Render
    try {
      if (this.useWebGPU && this.device && this.context && this.pipeline && this.anchorsBuffer) {
        this.device.queue.writeBuffer(this.anchorsBuffer, 0, this.anchorData.buffer, 0, this.anchorData.byteLength);
        const commandEncoder = this.device.createCommandEncoder();
        const view = this.context.getCurrentTexture().createView();
        const rp = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view,
            clearValue: { r: this.clearColor[0], g: this.clearColor[1], b: this.clearColor[2], a: this.clearColor[3] },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });

        rp.setPipeline(this.pipeline);
        rp.setBindGroup(0, this.pipeline.__bindGroup);
        rp.draw(6, this.instanceCount);
        rp.end();
        this.device.queue.submit([commandEncoder.finish()]);
        this.emitter.emit('render', { mode: 'webgpu', instanceCount: this.instanceCount });
      } else if (this.useWebGL2 && this.gl && this.glProgram) {
        const gl = this.gl;
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(this.clearColor[0], this.clearColor[1], this.clearColor[2], this.clearColor[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.glProgram);
        const loc = gl.getUniformLocation(this.glProgram, 'anchors');
        if (loc) {
          gl.uniform4fv(loc, this.anchorData.subarray(0, this.maxAnchors * 4));
        }

        const verts = 6;
        if (gl.drawArraysInstanced) {
          gl.drawArraysInstanced(gl.TRIANGLES, 0, verts, this.instanceCount);
        } else {
          for (let i = 0; i < this.instanceCount; i++) {
            gl.drawArrays(gl.TRIANGLES, 0, verts);
          }
        }
        this.emitter.emit('render', { mode: 'webgl', instanceCount: this.instanceCount });
      } else if (this.ctx2d) {
        const ctx = this.ctx2d;
        this._resizeCanvasToDisplaySize(this.canvas);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < this.instanceCount; i++) {
          const b = i * 5;
          const ndcX = this.anchorData[b + 0];
          const ndcY = this.anchorData[b + 1];
          const scale = this.anchorData[b + 4];
          const px = ((ndcX + 1) * 0.5) * this.canvas.width;
          const py = ((-ndcY + 1) * 0.5) * this.canvas.height;
          const r = Math.max(4, Math.min(40, 20 * scale * (1.0 - Math.abs(this.anchorData[b + 2]))));
          const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
          grad.addColorStop(0, 'rgba(50,230,240,0.9)');
          grad.addColorStop(1, 'rgba(50,230,240,0.0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
        this.emitter.emit('render', { mode: '2d', instanceCount: this.instanceCount });
      }
    } catch (err) {
      this.emitter.emit('error', { phase: 'render', error: err });
    }

    // Update performance metrics & history
    this._perf.frameTimes.push(performance.now() - startTime);
    if (this._perf.frameTimes.length > 100) this._perf.frameTimes.shift();
    this._perf.updateCount++;

    const histEntry = { id: `f-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, type: 'frame', ts: Date.now(), meta: { instanceCount: this.instanceCount } };
    this.history.push(histEntry);
    this.emitter.emit('frame', histEntry);
    if (this.synergyInstance && typeof this.synergyInstance.trigger === 'function') {
      try { this.synergyInstance.trigger(Object.assign({ event: 'bridge:frame', id: histEntry.id }, this.metaContext)); } catch (_) {}
    }
  }

  // Obtain anchors and apply optional anchorFilter condition
  _getAnchors() {
    let anchors = [];
    try {
      const map = this.dom3d.anchors;
      if (map && typeof map.entries === 'function') {
        for (const [el, info] of map.entries()) {
          anchors.push({ domEl: el, object: info.object, options: info.options });
        }
      } else if (typeof this.dom3d.getAnchors === 'function') {
        anchors = this.dom3d.getAnchors();
      }
    } catch (err) {
      console.warn('Could not read anchors:', err);
      this.emitter.emit('error', { phase: '_getAnchors', error: err });
    }

    // Apply anchor filter if provided
    try {
      if (this.conditions.anchorFilter) anchors = anchors.filter(a => this.conditions.anchorFilter(a, { bridge: this, meta: this.metaContext }));
    } catch (err) {
      this.emitter.emit('error', { phase: 'anchorFilter', error: err });
    }

    return anchors;
  }

  // Helper to extract anchors in serializable form
  _getAnchorsSerialized() {
    const anchors = this._getAnchors();
    return anchors.map(a => ({
      // shallow serializable form: domEl id if present + options; objects are not serialized
      domId: (a.domEl && a.domEl.id) ? a.domEl.id : null,
      options: a.options || {}
    }));
  }

  getPerformanceMetrics() {
    return {
      averageFrameTime: this._perf.getAverageFrameTime(),
      updateCount: this._perf.updateCount,
      instanceCount: this.instanceCount,
      maxAnchors: this.maxAnchors,
      lastFrameDelta: this.frameDelta,
      historyLength: this.history.length
    };
  }

  dispose() {
    this.stop();
    if (this.anchorsBuffer) {
      try { this.anchorsBuffer.destroy(); } catch (_) {}
      this.anchorsBuffer = null;
    }
    if (this.glProgram && this.gl) {
      try { this.gl.deleteProgram(this.glProgram); } catch (_) {}
      this.glProgram = null;
    }
    window.removeEventListener('resize', this._resizeHandler);
    if (this.canvas.parentElement) {
      try { this.canvas.parentElement.removeChild(this.canvas); } catch (_) {}
    }
    this.emitter.emit('dispose', { ts: Date.now() });
  }
}

// tiny helper

function isFunction(v) { return typeof v === 'function'; }

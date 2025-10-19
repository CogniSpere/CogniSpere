import * as THREE from 'three';

// Utility for performance monitoring
const performanceMetrics = {
  frameTimes: [],
  updateCount: 0,
  getAverageFrameTime() {
    const sum = this.frameTimes.reduce((a, b) => a + b, 0);
    return this.frameTimes.length ? sum / this.frameTimes.length : 0;
  }
};

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
    
    // Bind resize handler
    this._resizeHandler = () => this._resizeCanvasToDisplaySize(this.canvas);
    window.addEventListener('resize', this._resizeHandler);
  }

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
              return;
            }
          }
        } catch (err) {
          console.warn('WebGPU initialization failed:', err);
          this.useWebGPU = false;
        }
      }

      // Fallback to WebGL2
      this.gl = this.canvas.getContext('webgl2') || this.canvas.getContext('webgl');
      if (this.gl) {
        this.useWebGL2 = true;
        this._initWebGLPipeline();
      } else {
        // Fallback to Canvas2D
        this.ctx2d = this.canvas.getContext('2d');
        if (!this.ctx2d) {
          throw new Error('No rendering context available');
        }
      }
    } catch (err) {
      console.error('Initialization failed:', err);
      throw err;
    }
  }

  async _initWebGPUPipeline() {
    if (!this.device || !this.context) return;

    const defaultVertWGSL = `
struct Anchor { pos: vec4<f32>, scale: f32; };
@group(0) @binding(0) var<storage, read> anchors: array<Anchor>;

struct VertexOut {
  @builtin(position) pos: vec4<f32>;
  @location(0) uv: vec2<f32>;
  @location(1) scale: f32;
};

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
    const tick = (t) => {
      this.frameDelta = (t - this.lastFrameTime) / 1000;
      this.lastFrameTime = t;
      this.update();
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
  }

  update() {
    const startTime = performance.now();
    
    // Dynamic buffer resizing
    const anchors = this._getAnchors();
    if (anchors.length > this.maxAnchors) {
      this.maxAnchors = Math.ceil(anchors.length * 1.5);
      this.anchorData = new Float32Array(this.maxAnchors * 5);
      if (this.useWebGPU && this.device) {
        this.anchorsBuffer?.destroy();
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
    }

    // Update performance metrics
    performanceMetrics.frameTimes.push(performance.now() - startTime);
    if (performanceMetrics.frameTimes.length > 100) {
      performanceMetrics.frameTimes.shift();
    }
    performanceMetrics.updateCount++;
  }

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
    }
    return anchors;
  }

  getPerformanceMetrics() {
    return {
      averageFrameTime: performanceMetrics.getAverageFrameTime(),
      updateCount: performanceMetrics.updateCount,
      instanceCount: this.instanceCount,
      maxAnchors: this.maxAnchors
    };
  }

  dispose() {
    this.stop();
    if (this.anchorsBuffer) {
      this.anchorsBuffer.destroy();
      this.anchorsBuffer = null;
    }
    if (this.glProgram && this.gl) {
      this.gl.deleteProgram(this.glProgram);
      this.glProgram = null;
    }
    window.removeEventListener('resize', this._resizeHandler);
    if (this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
  }
}
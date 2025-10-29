// LayoutEngine - enhanced with state sync, narrative, GPU bridge, synergy/meta-context, per-item metrics
const LayoutEngine = (() => {
  const layouts = new Map(); // type -> { renderer, options }
  const meta = new Map(); // type -> { registered, options }
  const globalHooks = { beforeBuild: [], afterBuild: [], error: [] };
  const typeHooks = new Map(); // type -> { beforeBuild:[], afterBuild:[], error:[] }
  const history = []; // build history entries
  const undoStacks = new WeakMap(); // container -> [states]
  const perf = new Map(); // type -> { latencies:[], builds, itemMetrics: Map(itemId -> { last, avg, count }) }
  const stateStore = (() => {
    const store = new Map();
    const subs = new Map();
    return {
      set(key, val) {
        const old = store.get(key);
        store.set(key, val);
        const list = subs.get(key) || [];
        for (const cb of list.slice()) try { cb(val, old); } catch (e) {}
        return { old, new: val };
      },
      get(key) { return store.get(key); },
      subscribe(key, cb) { if (!subs.has(key)) subs.set(key, []); subs.get(key).push(cb); return () => { subs.set(key, subs.get(key).filter(x => x!==cb)); }; },
      batchSet(entries) { for (const [k,v] of Object.entries(entries)) this.set(k,v); }
    };
  })();

  // Meta-context / synergy
  const metaContext = new Map(); // topic -> value
  const metaSubs = new Map(); // topic -> [cb]
  function publishMeta(topic, payload) {
    metaContext.set(topic, payload);
    const s = metaSubs.get(topic) || [];
    for (const cb of s.slice()) try { cb(payload); } catch (e) {}
  }
  function onMeta(topic, cb) { if (!metaSubs.has(topic)) metaSubs.set(topic, []); metaSubs.get(topic).push(cb); return () => { metaSubs.set(topic, metaSubs.get(topic).filter(x=>x!==cb)); }; }
  function readMeta(topic) { return metaContext.get(topic); }

  // Storyboard / simple narrative hooks (progression)
  const storyboards = new Map(); // name -> { steps: [{id, condition}], pointer }
  function registerStoryboard(name, steps = []) {
    if (!name) throw new Error('storyboard name required');
    storyboards.set(name, { steps: steps.map(s=>({ ...s, done:false })), pointer: 0 });
    return () => storyboards.delete(name);
  }
  async function advanceStoryboard(name, context) {
    const sb = storyboards.get(name);
    if (!sb) throw new Error('storyboard not found');
    for (let i = sb.pointer; i < sb.steps.length; i++) {
      const step = sb.steps[i];
      const ok = typeof step.condition === 'function' ? await Promise.resolve(step.condition(context)) : !!step.auto;
      if (ok) { step.done = true; sb.pointer = i+1; dispatchEventSafe('layout:story:step', { storyboard: name, step: step.id, context }); }
      else break;
    }
    return sb;
  }
  function resetStoryboard(name) { const sb = storyboards.get(name); if (sb) { sb.steps.forEach(s=>s.done=false); sb.pointer = 0; } }

  // GPU bridge (lightweight): attempts WebGL2, fallback WebGL1, else Canvas2D
  function createGPUBridge(canvas, opts = {}) {
    const ctx = (function(){
      if (!canvas) return null;
      try {
        return canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('2d');
      } catch(e) { return null; }
    })();
    return {
      ctx,
      render(items, drawFn) {
        if (!ctx) return null;
        try {
          if (ctx instanceof WebGLRenderingContext || (typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext)) {
            // basic clear + let drawFn perform GL ops
            ctx.viewport(0,0,canvas.width,canvas.height);
            ctx.clearColor(0,0,0,0);
            ctx.clear(ctx.COLOR_BUFFER_BIT);
            return drawFn(ctx, items) || null;
          } else if (ctx instanceof CanvasRenderingContext2D) {
            ctx.clearRect(0,0,canvas.width,canvas.height);
            return drawFn(ctx, items) || null;
          }
        } catch (e) { console.error('GPU bridge render error', e); }
        return null;
      }
    };
  }

  // helpers
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function log(...a){ if (LayoutEngine.debug) try{ console.log('[LayoutEngine]', ...a); }catch(_){} }
  function createError(msg, code, details){ const e = new Error(msg); e.code = code; e.details = details; return e; }

  function register(type, renderer, options = {}) {
    if (!type || typeof type !== 'string') throw createError('invalid type', 'INVALID_TYPE');
    if (typeof renderer !== 'function') throw createError('invalid renderer', 'INVALID_RENDERER');
    layouts.set(type, { renderer, options });
    meta.set(type, { registered: Date.now(), options: Object.assign({}, options) });
    if (!perf.has(type)) perf.set(type, { latencies: [], builds: 0, itemMetrics: new Map() });
    return () => unregister(type);
  }
  async function lazyRegister(type, loader) {
    if (layouts.has(type)) return;
    try {
      const m = await loader();
      register(type, m.renderer, m.options||{});
    } catch (e) { throw createError('lazy load failed','LAZY_LOAD_ERROR',{type,error:e}); }
  }
  function unregister(type){ layouts.delete(type); meta.delete(type); typeHooks.delete(type); perf.delete(type); }

  function addGlobalHook(phase, cb){ if (!globalHooks[phase]) throw createError('invalid phase','INVALID_PHASE'); globalHooks[phase].push(cb); return ()=>{ globalHooks[phase]=globalHooks[phase].filter(x=>x!==cb); }; }
  function addTypeHook(type, phase, cb){ if (!typeHooks.has(type)) typeHooks.set(type,{ beforeBuild:[], afterBuild:[], error:[] }); const bucket = typeHooks.get(type); if (!bucket[phase]) throw createError('invalid phase','INVALID_PHASE'); bucket[phase].push(cb); return ()=>{ bucket[phase] = bucket[phase].filter(x=>x!==cb); }; }

  async function _fireHooks(type, phase, payload){
    for (const cb of (globalHooks[phase]||[]).slice()) try{ await Promise.resolve(cb(payload)); }catch(e){ log('global hook err',e); }
    const t = typeHooks.get(type);
    if (!t || !t[phase]) return;
    for (const cb of t[phase].slice()) try{ await Promise.resolve(cb(payload)); }catch(e){ log('type hook err',e); }
  }

  function _saveUndo(container){
    if (!undoStacks.has(container)) undoStacks.set(container,[]);
    const stack = undoStacks.get(container);
    const state = { innerHTML: container.innerHTML, classes: Array.from(container.classList), attrs: {} };
    for (const a of Array.from(container.attributes)) state.attrs[a.name] = a.value;
    stack.push(state);
    if (stack.length>20) stack.shift();
  }
  function undo(container){
    const stack = undoStacks.get(container);
    if (!stack || !stack.length) return false;
    const st = stack.pop();
    container.innerHTML = st.innerHTML;
    container.className = '';
    container.classList.add(...st.classes);
    for (const k of Object.keys(st.attrs)) container.setAttribute(k, st.attrs[k]);
    return true;
  }

  function _ensureItemMetric(type, itemId){
    const p = perf.get(type) || { latencies: [], builds:0, itemMetrics: new Map() };
    if (!p.itemMetrics.has(itemId)) p.itemMetrics.set(itemId, { last:0, avg:0, count:0 });
    perf.set(type,p);
    return p.itemMetrics.get(itemId);
  }

  async function build(containerSelector, type, items = [], context = {}, mergeStrategy = (a,b)=>Object.assign(a,b)) {
    const t0 = now();
    const container = typeof containerSelector === 'string' ? document.querySelector(containerSelector) : containerSelector;
    if (!container) throw createError('invalid container','INVALID_CONTAINER');
    if (!type) type = container.getAttribute('data-layout') || 'default';
    const l = layouts.get(type) || layouts.get('default');
    if (!l) throw createError('no layout registered','NO_LAYOUT');
    const entry = { type, container, items, context: Object.assign({}, context), timestamp: Date.now() };
    let error = null, result;
    const pRecord = perf.get(type) || { latencies: [], builds: 0, itemMetrics: new Map() };

    try{
      await _fireHooks(type,'beforeBuild',{ container, type, items, context });
      _saveUndo(container);

      // state sync: let layout read initial state and subscribe if configured
      if (l.options.subscribesTo && Array.isArray(l.options.subscribesTo)) {
        for (const key of l.options.subscribesTo) {
          stateStore.subscribe(key, (val)=>{ try{ l.renderer(container, items, Object.assign({}, context, { stateKey:key, stateVal:val })); } catch(e){} });
        }
      }

      // accessibility/theming/i18n
      if (l.options.ariaLabel) container.setAttribute('aria-label', l.options.ariaLabel);
      if (l.options.role) container.setAttribute('role', l.options.role);
      if (l.options.cssClasses) container.classList.add(...(l.options.cssClasses||[]));
      if (l.options.theme) Object.entries(l.options.theme||{}).forEach(([k,v]) => container.style.setProperty(`--${k}`, v));
      if (l.options.lang) container.setAttribute('lang', l.options.lang);

      // responsive
      if (l.options.responsive && typeof window !== 'undefined') {
        const mq = window.matchMedia('(max-width:768px)');
        const apply = (m)=> container.classList.toggle('mobile-layout', m.matches || m);
        const handler = (e)=> apply(e);
        try { mq.addEventListener ? mq.addEventListener('change', handler) : mq.addListener(handler); apply(mq); } catch(_) {}
      }

      // items array normalization
      const data = Array.isArray(items) ? items : (typeof items === 'string' ? JSON.parse(items) : []);
      if (typeof l.options.validator === 'function') {
        const ok = await l.options.validator(data);
        if (!ok) throw createError('invalid items','INVALID_ITEMS');
      }

      // GPU rendering support
      if (l.options.useGPU && l.options.canvasSelector) {
        const canvas = typeof l.options.canvasSelector === 'string' ? container.querySelector(l.options.canvasSelector) : l.options.canvasSelector;
        if (canvas) {
          const bridge = createGPUBridge(canvas);
          result = bridge.render(data, (ctx, itemsToDraw) => {
            // default simple draw: if 2d, render text; if webgl, leave to custom renderer
            if (ctx && ctx instanceof CanvasRenderingContext2D) {
              ctx.font = '12px sans-serif';
              itemsToDraw.forEach((it, i) => { const id = it.id || i; const start = now(); ctx.fillText(String(it.content || id), 6, 14 + i * 16); const dur = now() - start; const m = _ensureItemMetric(type, id); m.last = dur; m.count++; m.avg = (m.avg*(m.count-1)+dur)/m.count; });
            } else {
              try { if (typeof l.renderer === 'function') return l.renderer(canvas, itemsToDraw, context, { gpu:true, gl: ctx }); } catch(e){ console.error(e); }
            }
          });
        } else {
          result = await l.renderer(container, data, context);
        }
      } else {
        // Measure per-item render if renderer returns per-item callbacks or sync loop
        const startBuild = now();
        // If renderer is async and handles whole list, wrap to measure item timing when possible
        if (l.options.measurePerItem) {
          for (let i=0;i<data.length;i++){
            const it = data[i];
            const id = it.id ?? `${i}`;
            const tItem0 = now();
            // allow renderer to accept single item
            try {
              const r = await l.renderer(container, [it], Object.assign({}, context, { itemIndex:i, itemId:id }));
              const tItem = now() - tItem0;
              const m = _ensureItemMetric(type, id); m.last = tItem; m.count++; m.avg = (m.avg*(m.count-1)+tItem)/m.count;
              if (r && r.rollback) { /* collect rollbacks if needed */ }
            } catch (e) {
              throw e;
            }
          }
        } else {
          result = await l.renderer(container, data, context);
        }
        pRecord.latencies.push(now() - startBuild);
        pRecord.builds = (pRecord.builds||0)+1;
        perf.set(type, pRecord);
      }

      await _fireHooks(type,'afterBuild',{ container, type, items: data, context, result, performance:{ duration: now()-t0 } });
    } catch(e){
      errorSafe(type, e, { container, items, context });
      errorSafe('dispatch', e, {});
      history.push(Object.assign(entry,{ error:e, performance:{ duration: now()-t0 } }));
      if (history.length>LayoutEngine.historyCap) history.shift();
      throw e;
    } finally {
      if (!entry.error) {
        entry.performance = { duration: now() - t0 };
        history.push(entry);
        if (history.length > LayoutEngine.historyCap) history.shift();
      }
    }
    return result;
  }

  function errorSafe(type, e, ctx){
    try {
      _fireHooks(type,'error',Object.assign({ error:e }, ctx)).catch(()=>{});
      try { const ev = new CustomEvent('layout:error',{ bubbles:true, detail:{ type, error:e } }); (document||{}).dispatchEvent && document.dispatchEvent(ev); } catch(_) {}
      log('build error', e);
    } catch(_) {}
  }

  async function batchBuild(specs = [], { concurrency = 3 } = {}) {
    if (!Array.isArray(specs)) throw createError('specs must be array','INVALID_ARG');
    const results = {};
    let i = 0;
    const runners = new Array(Math.min(concurrency, specs.length)).fill(0).map(async () => {
      while (i < specs.length) {
        const idx = i++;
        const s = specs[idx];
        try { results[idx] = await build(s.containerSelector, s.type, s.items, s.context, s.mergeStrategy); } catch (e) { results[idx] = { error: e }; }
      }
    });
    await Promise.all(runners);
    return results;
  }

  function getHistory(filter = {}) {
    let r = history.slice();
    if (filter.type) r = r.filter(h => h.type === filter.type);
    if (filter.maxAge) r = r.filter(h => h.timestamp >= Date.now() - filter.maxAge);
    if (filter.errorOnly) r = r.filter(h => !!h.error);
    if (filter.predicate) r = r.filter(filter.predicate);
    return r;
  }
  function clearHistory(){ history.length = 0; }
  function setHistoryCap(cap){ if (typeof cap !== 'number' || cap<0) throw createError('invalid cap','INVALID_HISTORY_CAP'); LayoutEngine.historyCap = cap; while(history.length>LayoutEngine.historyCap) history.shift(); }

  function getMeta(type){ return Object.assign({}, meta.get(type)||{}); }
  function getAllMeta(){ return Object.fromEntries(Array.from(meta.entries()).map(([k,v])=>[k,Object.assign({},v)])); }
  function getPerformanceMetrics(){
    const out = {};
    for (const [k,v] of perf.entries()){
      const items = {};
      for (const [id,m] of v.itemMetrics.entries()) items[id] = { last: m.last, avg: m.avg, count: m.count };
      out[k] = { avgLatency: v.latencies.length ? v.latencies.reduce((a,b)=>a+b,0)/v.latencies.length : 0, builds: v.builds||0, items };
    }
    return out;
  }

  function setDebug(v=true){ LayoutEngine.debug = !!v; }
  function attachStateAPI(api){ if (api && typeof api.subscribe==='function' && typeof api.get==='function') { stateStore.subscribe = api.subscribe; stateStore.get = api.get; stateStore.set = api.set; } }
  // Storyboard exports
  function registerStoryboardExport(name, steps){ return registerStoryboard(name, steps); }
  function advanceStoryboardExport(name, ctx){ return advanceStoryboard(name, ctx); }
  function resetStoryboardExport(name){ return resetStoryboard(name); }

  // Auto-init existing containers and default layouts
  function init(root=document){
    try {
      register('default', (container, items)=>{ container.innerHTML = items.map(i => `<div>${i.content ?? i}</div>`).join(''); }, { template: '<div>{{content}}</div>', responsive:true });
      register('grid', (container, items)=>{ container.innerHTML = items.map(i=>`<div class="grid-item">${i.content??i}</div>`).join(''); }, { cssClasses:['layout-grid'], responsive:true, measurePerItem:true });
      register('list', (container, items)=>{ container.innerHTML = `<ul>${items.map(i=>`<li>${i.content??i}</li>`).join('')}</ul>`; }, { role:'list', responsive:true });
      const nodes = (root && root.querySelectorAll) ? root.querySelectorAll('[data-layout]') : [];
      for (const n of Array.from(nodes)){
        const t = n.getAttribute('data-layout') || 'default';
        const items = Array.from(n.querySelectorAll('[data-item]')).map(el=>({ content: el.innerHTML, id: el.getAttribute('data-id')||undefined }));
        build(n, t, items).catch(e=>log('init build err',e));
      }
    } catch(e){ log('init error', e); }
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', ()=>init(document));

  // Web component
  class LayoutElement extends HTMLElement {
    connectedCallback(){
      const type = this.getAttribute('data-layout') || 'default';
      const items = Array.from(this.querySelectorAll('[data-item]')).map(el=>({ content: el.innerHTML, id: el.getAttribute('data-id')||undefined }));
      // best-effort build
      build(this, type, items).catch(e=>log('wc build err',e));
    }
  }
  try { if (typeof customElements !== 'undefined' && !customElements.get('layout-element')) customElements.define('layout-element', LayoutElement); } catch(e){}

  const LayoutEngine = {
    register, lazyRegister, unregister, build, batchBuild,
    addGlobalHook, addTypeHook, undo, serialize: (c)=>{ return JSON.stringify({ type: c.getAttribute && c.getAttribute('data-layout'), items: Array.from(c.querySelectorAll('[data-item]')).map(el=>({ html: el.innerHTML })) }); },
    deserialize: async (c,s)=>deserialize(c,s),
    getHistory, clearHistory, setHistoryCap, getMeta, getAllMeta, getPerformanceMetrics,
    // state & meta-context
    stateSet: (k,v)=>stateStore.set(k,v), stateGet: (k)=>stateStore.get(k), stateSubscribe: (k,cb)=>stateStore.subscribe(k,cb),
    publishMeta, onMeta, readMeta,
    // storyboards
    registerStoryboard: registerStoryboardExport, advanceStoryboard: advanceStoryboardExport, resetStoryboard: resetStoryboardExport,
    // gpu bridge helpers
    createGPUBridge,
    // flags
    debug: false,
    historyCap: historyCap
  };
  return LayoutEngine;
})();

export default LayoutEngine;
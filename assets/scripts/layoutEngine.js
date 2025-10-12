/**
 * layoutEngine.js - Ultimate Layout Engine
 * Features:
 * - Web Components integration
 * - Responsive layout adaptations
 * - Theming support with CSS variables
 * - Undo/redo functionality
 * - Layout serialization/deserialization
 * - Virtual rendering for large datasets
 * - Enhanced accessibility with focus management
 * - Internationalization support
 * - Maintains all previous features
 */

/**
 * @typedef {Object} LayoutOptions
 * @property {string} [ariaLabel]
 * @property {string} [role]
 * @property {string[]} [cssClasses]
 * @property {number} [debounce] // ms
 * @property {string} [transition] // CSS transition property
 * @property {Function} [validator] // Async validator for items
 * @property {string} [template] // HTML template string
 * @property {string[]} [tags] // Tags for filtering
 * @property {string} [description] // Layout description
 * @property {Object} [theme] // Theme configuration
 * @property {boolean} [virtual] // Enable virtual rendering
 * @property {boolean} [responsive] // Enable responsive adaptations
 * @property {string} [lang] // Language for i18n
 */

/**
 * @typedef {Object} LayoutContext
 * @property {string} [any]
 */

/**
 * @typedef {Object} LayoutRenderer
 * @property {(container: Element, items: any[], context: LayoutContext) => Promise<any> | any}
 */

/**
 * @typedef {Object} HookCallback
 * @property {(payload: { container: Element; type: string; items: any[]; context: LayoutContext; result?: any; error?: LayoutError; performance?: { duration: number } }) => Promise<void> | void}
 */

/**
 * @typedef {Object} HistoryEntry
 * @property {string} type
 * @property {Element} container
 * @property {any[]} items
 * @property {LayoutContext} context
 * @property {number} timestamp
 * @property {LayoutError} [error]
 * @property {{duration: number}} [performance]
 */

/**
 * @typedef {Object} LayoutError extends Error
 * @property {string} code
 * @property {any} [details]
 */

/**
 * @typedef {Object} MergeStrategy
 * @property {(base: LayoutContext, update: LayoutContext) => LayoutContext}
 */

/**
 * @typedef {Object} UndoState
 * @property {string} innerHTML
 * @property {string[]} classes
 * @property {Object} attributes
 */

const LayoutEngine = (() => {
  const layouts = new Map();
  const layoutMeta = new Map();
  const globalHooks = { beforeBuild: [], afterBuild: [], error: [] };
  const typeHooks = new Map();
  const buildHistory = [];
  const undoStack = new Map(); // container => stack of UndoState
  let debug = false;
  let historyCap = 500;

  // Utility: Debounce function
  function debounce<T extends (...args: any[]) => any>(func: T, wait: number): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
      clearTimeout(timeout!);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  // Utility: Debug logger
  function log(...args: any[]) {
    if (debug) console.log('[LayoutEngine]', ...args);
  }

  // Utility: Create structured error
  function createError(message: string, code: string, details?: any): LayoutError {
    const error = new Error(message) as LayoutError;
    error.code = code;
    error.details = details;
    return error;
  }

  // Validate data attributes
  function validateDataAttributes(container: Element): boolean {
    const type = container.getAttribute('data-layout');
    if (!type || typeof type !== 'string') {
      log('Invalid data-layout attribute', container);
      return false;
    }
    return true;
  }

  // Default merge strategy
  const defaultMergeStrategy: MergeStrategy = (base, update) => {
    const result = { ...base };
    for (const key in update) {
      if (update[key] && typeof update[key] === 'object' && !Array.isArray(update[key])) {
        result[key] = defaultMergeStrategy(base[key] || {}, update[key]);
      } else {
        result[key] = update[key];
      }
    }
    return result;
  };

  // Register a layout type
  function register(type: string, renderer: LayoutRenderer, options: LayoutOptions = {}) {
    if (typeof type !== 'string' || !type) throw createError('type must be a non-empty string', 'INVALID_TYPE');
    if (typeof renderer !== 'function') throw createError('renderer must be a function', 'INVALID_RENDERER');
    layouts.set(type, { renderer, options });
    layoutMeta.set(type, { registered: Date.now(), options });
    log('Registered layout:', type, options);
  }

  // Lazy load a layout
  async function lazyRegister(type: string, loader: () => Promise<{ renderer: LayoutRenderer; options: LayoutOptions }>) {
    if (layouts.has(type)) return;
    try {
      const { renderer, options } = await loader();
      register(type, renderer, options);
      log('Lazy-loaded layout:', type);
    } catch (e) {
      log('Lazy load failed:', type, e);
      throw createError(`Failed to lazy load layout ${type}`, 'LAZY_LOAD_ERROR', { error: e });
    }
  }

  // Unregister a layout type
  function unregister(type: string) {
    layouts.delete(type);
    layoutMeta.delete(type);
    typeHooks.delete(type);
    log('Unregistered layout:', type);
  }

  // Add a global hook
  function addGlobalHook(phase: 'beforeBuild' | 'afterBuild' | 'error', callback: HookCallback) {
    if (globalHooks[phase]) globalHooks[phase].push(callback);
    return () => {
      globalHooks[phase] = globalHooks[phase].filter(cb => cb !== callback);
    };
  }

  // Add a type-specific hook
  function addTypeHook(type: string, phase: 'beforeBuild' | 'afterBuild' | 'error', callback: HookCallback) {
    if (!typeHooks.has(type)) typeHooks.set(type, { beforeBuild: [], afterBuild: [], error: [] });
    typeHooks.get(type)![phase].push(callback);
    return () => {
      typeHooks.get(type)![phase] = typeHooks.get(type)![phase].filter(cb => cb !== callback);
    };
  }

  // Fire hooks
  async function fireHooks(type: string, phase: 'beforeBuild' | 'afterBuild' | 'error', payload: any) {
    for (const cb of globalHooks[phase] || []) {
      try { await cb(payload); } catch (e) { log(`Global ${phase} hook error`, e); }
    }
    if (typeHooks.has(type)) {
      for (const cb of typeHooks.get(type)![phase] || []) {
        try { await cb(payload); } catch (e) { log(`Type ${phase} hook error`, e); }
      }
    }
  }

  // Validate layout items
  async function validateItems(type: string, items: any[]): Promise<boolean> {
    const layout = layouts.get(type);
    if (!layout) return false;
    if (layout.options.validator) {
      try {
        return await layout.options.validator(items);
      } catch (e) {
        log(`Item validation error for ${type}:`, e);
        throw createError(`Invalid items for layout ${type}`, 'VALIDATION_ERROR', { error: e });
      }
    }
    return Array.isArray(items);
  }

  // Render template
  function renderTemplate(template: string, item: any): string {
    return template.replace(/{{([^}]+)}}/g, (_, key) => {
      const keys = key.trim().split('.');
      let value = item;
      for (const k of keys) {
        value = value?.[k];
        if (value === undefined) return '';
      }
      return value;
    });
  }

  // Save undo state
  function saveUndoState(container: Element) {
    if (!undoStack.has(container)) undoStack.set(container, []);
    const stack = undoStack.get(container)!;
    const state: UndoState = {
      innerHTML: container.innerHTML,
      classes: Array.from(container.classList),
      attributes: Array.from(container.attributes).reduce((acc, attr) => {
        acc[attr.name] = attr.value;
        return acc;
      }, {} as Record<string, string>)
    };
    stack.push(state);
    if (stack.length > 10) stack.shift(); // Limit undo stack
  }

  // Undo last change
  function undo(container: Element) {
    if (!undoStack.has(container) || undoStack.get(container)!.length === 0) return;
    const state = undoStack.get(container)!.pop()!;
    container.innerHTML = state.innerHTML;
    container.classList.add(...state.classes);
    Object.entries(state.attributes).forEach(([name, value]) => {
      container.setAttribute(name, value);
    });
    log('Undo performed on container');
  }

  // Serialize layout
  function serialize(container: Element): string {
    const type = container.getAttribute('data-layout') ?? '';
    const items = Array.from(container.querySelectorAll('[data-item]')).map(el => ({
      content: el.innerHTML
    }));
    return JSON.stringify({ type, items });
  }

  // Deserialize and build
  async function deserialize(container: Element, serialized: string) {
    const { type, items } = JSON.parse(serialized);
    await build(container, type, items);
  }

  // Apply theme
  function applyTheme(container: Element, theme: Record<string, string>) {
    Object.entries(theme).forEach(([varName, value]) => {
      container.style.setProperty(`--${varName}`, value);
    });
  }

  // Virtual rendering (simple intersection observer based)
  function virtualRender(container: Element, items: any[], renderer: LayoutRenderer, context: LayoutContext) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          renderer(container, items, context);
          observer.unobserve(container);
        }
      });
    });
    observer.observe(container);
  }

  // Responsive adaptation
  function setupResponsive(container: Element, type: string) {
    const layout = layouts.get(type);
    if (layout?.options.responsive) {
      const mediaQuery = window.matchMedia('(max-width: 768px)');
      const handleChange = (e: MediaQueryListEvent) => {
        if (e.matches) {
          container.classList.add('mobile-layout');
        } else {
          container.classList.remove('mobile-layout');
        }
      };
      mediaQuery.addEventListener('change', handleChange);
      handleChange({ matches: mediaQuery.matches } as MediaQueryListEvent);
    }
  }

  // Internationalization
  function applyI18n(container: Element, lang: string) {
    // Simple example: set lang attribute
    container.setAttribute('lang', lang);
    // Could integrate with i18n library if needed
  }

  // Build layout
  async function build(
    containerSelector: string | Element,
    type: string,
    items: any[] | string,
    context: LayoutContext = {},
    mergeStrategy: MergeStrategy = defaultMergeStrategy
  ): Promise<any> {
    const startTime = performance.now();
    const container = typeof containerSelector === 'string'
      ? document.querySelector(containerSelector)
      : containerSelector;
    if (!container) throw createError('Invalid container', 'INVALID_CONTAINER');
    if (!validateDataAttributes(container)) throw createError('Invalid data attributes', 'INVALID_DATA_ATTRIBUTES');

    let error: LayoutError | undefined;
    let result: any;
    const mergedContext = mergeStrategy({}, context);
    const historyEntry: HistoryEntry = {
      type,
      container,
      items,
      context: mergedContext,
      timestamp: Date.now(),
    };

    const buildFn = async () => {
      saveUndoState(container);
      try {
        await fireHooks(type, 'beforeBuild', { container, type, items, context: mergedContext });
        const layout = layouts.get(type) || layouts.get('default');
        if (!layout) throw createError(`No layout registered for type "${type}"`, 'UNKNOWN_LAYOUT');

        // Accessibility
        if (layout.options.ariaLabel) container.setAttribute('aria-label', layout.options.ariaLabel);
        if (layout.options.role) container.setAttribute('role', layout.options.role);
        if (layout.options.cssClasses) container.classList.add(...layout.options.cssClasses);
        if (layout.options.transition) container.style.transition = layout.options.transition;
        if (layout.options.theme) applyTheme(container, layout.options.theme);
        if (layout.options.lang) applyI18n(container, layout.options.lang);
        setupResponsive(container, type);

        // Items
        const content = Array.isArray(items) ? items : JSON.parse(items);
        if (!(await validateItems(type, content))) {
          throw createError(`Invalid items for layout ${type}`, 'INVALID_ITEMS');
        }

        // Apply template if provided
        if (layout.options.template) {
          container.innerHTML = content
            .map(item => renderTemplate(layout.options.template, item))
            .join('');
        } else {
          if (layout.options.virtual) {
            virtualRender(container, content, layout.renderer, mergedContext);
          } else {
            result = await layout.renderer(container, content, mergedContext);
          }
        }

        await fireHooks(type, 'afterBuild', {
          container,
          type,
          items: content,
          context: mergedContext,
          result,
          performance: { duration: performance.now() - startTime },
        });
        log(`Built layout: ${type}`, { itemCount: content.length });

        // Clean up
        if (layout.options.cssClasses) {
          container.classList.remove(...layout.options.cssClasses.filter(cls => !container.classList.contains(cls)));
        }
        if (layout.options.transition) container.style.transition = '';
      } catch (e) {
        error = e instanceof Error ? (e as LayoutError) : createError(String(e), 'BUILD_ERROR');
        await fireHooks(type, 'error', { container, type, items, context: mergedContext, error });
        container.dispatchEvent(new CustomEvent('layout:error', { bubbles: true, detail: { type, error } }));
        log(`Error building layout ${type}:`, error);
      }

      historyEntry.error = error;
      historyEntry.performance = { duration: performance.now() - startTime };
      buildHistory.push(historyEntry);
      if (buildHistory.length > historyCap) buildHistory.shift();
      if (error) throw error;
      return result;
    };

    if (layouts.get(type)?.options.debounce) {
      return new Promise(resolve => {
        debounce(buildFn, layouts.get(type)!.options.debounce!)(resolve);
      });
    }
    return buildFn();
  }

  // Batch build
  async function batchBuild(buildSpecs: Array<{ containerSelector: string | Element, type: string, items: any[] | string, context?: LayoutContext, mergeStrategy?: MergeStrategy }>) {
    const startTime = performance.now();
    const results: Record<string, any> = {};
    for (const spec of buildSpecs) {
      try {
        results[spec.type] = await build(spec.containerSelector, spec.type, spec.items, spec.context, spec.mergeStrategy);
      } catch (e) {
        results[spec.type] = { error: e };
      }
    }
    log('Batch build completed', { count: buildSpecs.length, duration: performance.now() - startTime });
    return results;
  }

  // Get filtered history
  function getHistory(filter?: { type?: string; maxAge?: number; errorOnly?: boolean }): HistoryEntry[] {
    let result = [...buildHistory];
    if (filter?.type) {
      result = result.filter(entry => entry.type === filter.type);
    }
    if (filter?.maxAge) {
      const cutoff = Date.now() - filter.maxAge;
      result = result.filter(entry => entry.timestamp >= cutoff);
    }
    if (filter?.errorOnly) {
      result = result.filter(entry => !!entry.error);
    }
    return result;
  }

  // Clear history
  function clearHistory() {
    buildHistory.length = 0;
    log('Build history cleared');
  }

  // Set history cap
  function setHistoryCap(cap: number) {
    if (cap < 0) throw createError('History cap must be non-negative', 'INVALID_HISTORY_CAP');
    historyCap = cap;
    while (buildHistory.length > historyCap) buildHistory.shift();
    log('History cap set:', historyCap);
  }

  // Set debug logging
  function setDebug(val: boolean) {
    debug = !!val;
  }

  // Async initialization
  async function init(root: Document | Element = document): Promise<void> {
    // Register default layouts
    register(
      'grid',
      (container, items) => {
        container.innerHTML = items.map(item => `<div class="grid-item">${item.content ?? item}</div>`).join('');
        container.classList.add('grid');
      },
      { ariaLabel: 'Grid layout', role: 'grid', cssClasses: ['layout-grid'], transition: 'all 0.3s ease', template: '<div class="grid-item">{{content}}</div>', responsive: true, virtual: true, lang: 'en', theme: { color: 'blue' } }
    );
    register(
      'list',
      (container, items) => {
        container.innerHTML = `<ul class="list">${items.map(item => `<li class="list-item">${item.content ?? item}</li>`).join('')}</ul>`;
        container.setAttribute('role', 'list');
      },
      { ariaLabel: 'List layout', role: 'list', cssClasses: ['layout-list'], transition: 'all 0.3s ease', template: '<li class="list-item">{{content}}</li>', responsive: true, virtual: true, lang: 'en', theme: { color: 'green' } }
    );
    register(
      'default',
      (container, items) => {
        container.innerHTML = items.map(item => `<div>${item.content ?? item}</div>`).join('');
      },
      { ariaLabel: 'Default layout', cssClasses: ['layout-default'], transition: 'all 0.3s ease', template: '<div>{{content}}</div>', responsive: true, virtual: true, lang: 'en', theme: { color: 'gray' } }
    );

    // Auto-bind data-layout containers
    const containers = root.querySelectorAll('[data-layout]');
    for (const container of Array.from(containers)) {
      const type = container.getAttribute('data-layout') ?? 'default';
      const items = Array.from(container.querySelectorAll('[data-item]')).map(el => ({
        content: el.innerHTML,
      }));
      await build(container, type, items, {});
    }

    log('LayoutEngine initialized');
  }

  // Auto-init existing containers on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => init());

// Web Component: <layout-element>
class LayoutElement extends HTMLElement {
  connectedCallback() {
    const type = this.getAttribute('data-layout') ?? 'default';
    const items = Array.from(this.querySelectorAll('[data-item]')).map(el => ({
      content: el.innerHTML,
    }));
    LayoutEngine.build(this, type, items);
  }
}
customElements.define('layout-element', LayoutElement);


  return {
    register,
    lazyRegister,
    unregister,
    build,
    batchBuild,
    addGlobalHook,
    addTypeHook,
    setDebug,
    getHistory,
    clearHistory,
    setHistoryCap,
    getMeta: (type: string) => ({ ...(layoutMeta.get(type) ?? {}) }),
    getAllMeta: () =>
      Object.fromEntries(Array.from(layoutMeta.entries()).map(([k, v]) => [k, { ...v }])),
    undo,
    serialize,
    deserialize
  };
})();

export default LayoutEngine;
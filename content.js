// Content script: element picker, selector generation, condition evaluation and marker rendering.
(() => {
  if (window.__nxLoaded) return;
  window.__nxLoaded = true;
  const NX = globalThis.NX;

  let notes = [];
  let settings = { editMode: false, selectedId: null };
  let items = []; // [{n, el, met}] for notes matching this URL
  const markerEls = new Map(); // note id -> div

  // ---------- Shadow DOM overlay (isolated from page CSS) ----------
  const host = document.createElement('nx-notes-root');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  .m { position: fixed; left: 0; top: 0; pointer-events: auto; cursor: pointer; display: flex;
       align-items: center; justify-content: center; white-space: nowrap; user-select: none;
       font: 600 11px/1 system-ui, -apple-system, Segoe UI, sans-serif; transition: opacity .15s; }
  .m.dot { border-radius: 999px; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.45); }
  .m.tip { border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 500; max-width: 280px;
           box-shadow: 0 2px 6px rgba(0,0,0,.35); }
  .m.tip span { overflow: hidden; text-overflow: ellipsis; }
  .m.tip::after { content: ''; position: absolute; border: 6px solid transparent; }
  .m.tip.ad::after { top: 100%; left: 50%; margin-left: -6px; border-top-color: var(--c); }
  .m.tip.au::after { bottom: 100%; left: 50%; margin-left: -6px; border-bottom-color: var(--c); }
  .m.tip.ar::after { left: 100%; top: 50%; margin-top: -6px; border-left-color: var(--c); }
  .m.tip.al::after { right: 100%; top: 50%; margin-top: -6px; border-right-color: var(--c); }
  .m.unmet { opacity: .4; outline: 2px dashed #444; outline-offset: 1px; }
  .m.sel { outline: 2px solid #1e88e5; outline-offset: 3px; opacity: 1; }
  .box { position: fixed; left: 0; top: 0; pointer-events: none; display: none;
         border: 2px solid #1e88e5; background: rgba(30,136,229,.15); border-radius: 2px; }
  #hl { border-color: #fb8c00; background: rgba(251,140,0,.18); }
  #pick-label { position: absolute; left: -2px; background: #1e88e5; color: #fff; padding: 3px 6px;
                font: 11px/1.2 Consolas, monospace; white-space: nowrap; border-radius: 3px; }
  #hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none;
          background: #222; color: #fff; padding: 8px 14px; border-radius: 8px; pointer-events: none;
          font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.4); }
  #hint b { color: #90caf9; }
  #bubble { position: fixed; left: 0; top: 0; display: none; pointer-events: auto; width: 300px; max-height: 360px;
            overflow: auto; background: #fff; color: #222; border-radius: 8px; padding: 10px 12px 12px;
            box-shadow: 0 6px 24px rgba(0,0,0,.35); font: 13px/1.45 system-ui, sans-serif; text-align: left; }
  #bubble .t { font-weight: 700; font-size: 14px; margin: 0 24px 6px 0; word-break: break-word; }
  #bubble .x { white-space: pre-wrap; word-break: break-word; }
  #bubble .x:empty::before { content: '(no note text)'; color: #999; }
  #bubble .bar { display: flex; gap: 6px; margin-top: 10px; }
  #bubble button { font: 12px system-ui, sans-serif; padding: 4px 10px; border: 1px solid #bbb;
                   background: #f5f5f5; border-radius: 5px; cursor: pointer; color: #222; }
  #bubble button:hover { background: #e8e8e8; }
  #bubble .close { position: absolute; top: 6px; right: 6px; border: 0; background: none; font-size: 16px; padding: 2px 6px; }
</style>
<div id="layer"></div>
<div id="pick" class="box"><div id="pick-label"></div></div>
<div id="hl" class="box"></div>
<div id="hint"></div>
<div id="bubble"><button class="close" title="Close">✕</button><div class="t"></div><div class="x"></div>
  <div class="bar"><button class="edit">Edit in sidebar</button></div></div>`;
  const $ = (s) => root.querySelector(s);
  const layer = $('#layer'), pickBox = $('#pick'), pickLabel = $('#pick-label'), hlBox = $('#hl');
  const hint = $('#hint'), bubble = $('#bubble');
  const attach = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  attach();

  // ---------- Querying ----------
  // Returns array of elements, or null if the selector is invalid.
  function queryAll(sel) {
    if (!sel || !sel.value || !sel.value.trim()) return [];
    try {
      let out;
      if (sel.type === 'xpath') {
        const r = document.evaluate(sel.value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        out = [];
        for (let i = 0; i < r.snapshotLength; i++) {
          const n = r.snapshotItem(i);
          if (n.nodeType === 1) out.push(n);
        }
      } else {
        out = Array.from(document.querySelectorAll(sel.value));
      }
      return out.filter((e) => e !== host);
    } catch {
      return null;
    }
  }

  // Try the active selector first, then fall back to the other alternatives.
  function resolveTarget(n) {
    const sels = n.target.selectors || [];
    const order = [n.target.active || 0, ...sels.map((_, i) => i).filter((i) => i !== (n.target.active || 0))];
    for (const i of order) {
      const els = queryAll(sels[i]);
      if (els && els.length) return { el: els[0], used: i };
    }
    return { el: null, used: -1 };
  }

  const isVisible = (el) =>
    !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length > 0);
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el.innerText !== undefined ? el.innerText : el.textContent);
  const valuesOf = (el) => {
    const v = [];
    if ('value' in el && el.value !== undefined) v.push(String(el.value));
    if (el.tagName === 'SELECT') for (const o of el.selectedOptions) v.push(norm(o.textContent));
    if (!v.length) v.push(textOf(el));
    return v;
  };
  const isChecked = (el) =>
    el.checked === true || ['aria-checked', 'aria-selected', 'aria-pressed', 'aria-expanded']
      .some((a) => el.getAttribute(a) === 'true');
  const safeRe = (v) => { try { return new RegExp(v, 'i'); } catch { return null; } };

  // ---------- Visited links (asked from the background, cached) ----------
  const visited = new Map(); // url -> {v, t}
  const pendingVisited = new Set();
  let visitedTimer = null;
  function isVisited(url) {
    if (!url) return false;
    try { url = new URL(url, location.href).href; } catch { return false; }
    const c = visited.get(url);
    if (!c || Date.now() - c.t > 15000) {
      pendingVisited.add(url);
      if (!visitedTimer) visitedTimer = setTimeout(flushVisited, 30);
    }
    return c ? c.v : false;
  }
  function flushVisited() {
    visitedTimer = null;
    const urls = [...pendingVisited];
    pendingVisited.clear();
    // Mark as fetched now so we do not re-ask while waiting.
    for (const u of urls) visited.set(u, { v: visited.get(u)?.v || false, t: Date.now() });
    chrome.runtime.sendMessage({ type: 'visited', urls }).then((res) => {
      let changed = false;
      for (const u of urls) {
        const v = !!(res && res[u]);
        if (visited.get(u).v !== v) changed = true;
        visited.set(u, { v, t: Date.now() });
      }
      if (changed) scheduleEval();
    }).catch(() => {});
  }

  // ---------- Conditions ----------
  function evalCondition(c) {
    const chk = NX.checkById(c.check);
    const els = c.sel && c.sel.value ? queryAll(c.sel) : [];
    if (els === null) return false; // invalid selector
    const el = els[0];
    const v = c.value == null ? '' : String(c.value);
    switch (c.check) {
      case 'exists': return !!el;
      case 'notExists': return !el;
      case 'visible': return isVisible(el);
      case 'hidden': return !isVisible(el);
      case 'textEquals': return !!el && textOf(el) === norm(v);
      case 'textContains': return !!el && textOf(el).toLowerCase().includes(norm(v).toLowerCase());
      case 'textMatches': { const re = safeRe(v); return !!el && !!re && re.test(textOf(el)); }
      case 'valueEquals': return !!el && valuesOf(el).some((x) => norm(x) === norm(v));
      case 'valueContains': return !!el && valuesOf(el).some((x) => x.toLowerCase().includes(v.toLowerCase()));
      case 'checked': return !!el && isChecked(el);
      case 'unchecked': return !!el && !isChecked(el);
      case 'hasClass': return !!el && v.trim().split(/\s+/).every((k) => el.classList.contains(k));
      case 'notHasClass': return !!el && !v.trim().split(/\s+/).some((k) => k && el.classList.contains(k));
      case 'attrEquals': {
        if (!el) return false;
        const i = v.indexOf('=');
        if (i < 0) return el.hasAttribute(v.trim());
        return el.getAttribute(v.slice(0, i).trim()) === v.slice(i + 1).trim();
      }
      case 'linkVisited':
      case 'linkNotVisited': {
        const url = el ? el.href || el.getAttribute('href') : v;
        const r = isVisited(url);
        return c.check === 'linkVisited' ? r : !r;
      }
      case 'urlContains': return location.href.includes(v);
      case 'urlMatches': { const re = safeRe(v); return !!re && re.test(location.href); }
      default: return chk ? false : false;
    }
  }
  function conditionsMet(n) {
    const cs = n.conditions || [];
    if (!cs.length) return true;
    return n.conditionMode === 'any' ? cs.some(evalCondition) : cs.every(evalCondition);
  }

  // ---------- Rendering ----------
  const POINTS = {
    'top-left': [-1, -1], top: [0, -1], 'top-right': [1, -1],
    left: [-1, 0], center: [0, 0], right: [1, 0],
    'bottom-left': [-1, 1], bottom: [0, 1], 'bottom-right': [1, 1],
  };

  function evaluate() {
    attach();
    const url = location.href;
    items = notes
      .filter((n) => n.enabled !== false && NX.urlMatches(n.urlPattern, url))
      .map((n) => ({ n, el: resolveTarget(n).el, met: conditionsMet(n) }));
    // Remove markers of notes no longer relevant.
    const keep = new Set(items.map((i) => i.n.id));
    for (const [id, div] of markerEls) if (!keep.has(id)) { div.remove(); markerEls.delete(id); }
    for (const it of items) updateMarker(it);
    if (bubble.dataset.id && !keep.has(bubble.dataset.id)) hideBubble();
  }

  function updateMarker({ n, met }) {
    let div = markerEls.get(n.id);
    if (!div) {
      div = document.createElement('div');
      div.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toggleBubble(n.id); });
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick'])
        div.addEventListener(t, (e) => e.stopPropagation());
      layer.appendChild(div);
      markerEls.set(n.id, div);
    }
    const m = n.marker;
    const [ax, ay] = POINTS[n.anchor.point] || POINTS['top-right'];
    let arrow = '';
    if (m.kind === 'tooltip' && n.anchor.mode === 'outside') {
      arrow = ay === -1 ? 'ad' : ay === 1 ? 'au' : ax === -1 ? 'ar' : ax === 1 ? 'al' : '';
    }
    const sig = JSON.stringify([m, arrow, met, settings.editMode, settings.selectedId === n.id, n.title]);
    if (div.dataset.sig !== sig) {
      div.dataset.sig = sig;
      div.className = ['m', m.kind === 'tooltip' ? 'tip' : 'dot', arrow,
        !met ? 'unmet' : '', settings.editMode && settings.selectedId === n.id ? 'sel' : ''].join(' ');
      div.style.setProperty('--c', m.color);
      div.style.background = m.color;
      div.style.color = m.textColor || '#fff';
      div.title = n.title || '';
      if (m.kind === 'tooltip') {
        div.innerHTML = '<span></span>';
        div.firstChild.textContent = m.label || n.title || '📝';
        div.style.minWidth = div.style.height = div.style.padding = div.style.fontSize = '';
      } else {
        const s = Math.max(6, Number(m.size) || 14);
        div.textContent = m.label || '';
        div.style.minWidth = div.style.height = s + 'px';
        div.style.fontSize = Math.max(8, Math.round(s * 0.62)) + 'px';
        div.style.padding = m.label ? `0 ${Math.round(s * 0.28)}px` : '0';
      }
    }
  }

  function layout() {
    for (const { n, el, met } of items) {
      const div = markerEls.get(n.id);
      if (!div) continue;
      const show = el && (met || settings.editMode) && !picking;
      const r = show ? el.getBoundingClientRect() : null;
      if (!show || (r.width === 0 && r.height === 0)) { div.style.display = 'none'; continue; }
      div.style.display = '';
      const [ax, ay] = POINTS[n.anchor.point] || POINTS['top-right'];
      const k = n.anchor.mode === 'outside' ? 1 : n.anchor.mode === 'inside' ? -1 : 0;
      let x = r.left + ((ax + 1) / 2) * r.width + (Number(n.anchor.dx) || 0);
      let y = r.top + ((ay + 1) / 2) * r.height + (Number(n.anchor.dy) || 0);
      // Leave room for a tooltip's arrow.
      if (div.classList.contains('ad')) y -= 7;
      else if (div.classList.contains('au')) y += 7;
      else if (div.classList.contains('ar')) x -= 7;
      else if (div.classList.contains('al')) x += 7;
      const tx = -50 + 50 * ax * k, ty = -50 + 50 * ay * k;
      div.style.transform = `translate(${x}px, ${y}px) translate(${tx}%, ${ty}%)`;
    }
    if (bubble.style.display === 'block') placeBubble();
    if (hlEl) drawBox(hlBox, hlEl);
  }

  // ---------- Bubble (click on a marker) ----------
  function toggleBubble(id) {
    if (bubble.style.display === 'block' && bubble.dataset.id === id) return hideBubble();
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    bubble.dataset.id = id;
    bubble.querySelector('.t').textContent = n.title || '';
    bubble.querySelector('.x').textContent = n.text || '';
    bubble.style.display = 'block';
    placeBubble();
  }
  function hideBubble() { bubble.style.display = 'none'; delete bubble.dataset.id; }
  function placeBubble() {
    const div = markerEls.get(bubble.dataset.id);
    if (!div || div.style.display === 'none') return hideBubble();
    const r = div.getBoundingClientRect(), b = bubble.getBoundingClientRect();
    let x = r.left + r.width / 2 - b.width / 2, y = r.bottom + 8;
    if (y + b.height > innerHeight - 8) y = r.top - b.height - 8;
    x = Math.max(8, Math.min(x, innerWidth - b.width - 8));
    y = Math.max(8, y);
    bubble.style.transform = `translate(${x}px, ${y}px)`;
  }
  bubble.querySelector('.close').addEventListener('click', hideBubble);
  bubble.querySelector('.edit').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'editNote', id: bubble.dataset.id }).catch(() => {});
  });
  for (const t of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'])
    bubble.addEventListener(t, (e) => e.stopPropagation());
  document.addEventListener('mousedown', (e) => {
    if (bubble.style.display === 'block' && !e.composedPath().includes(host)) hideBubble();
  }, true);

  // ---------- Highlight box ----------
  let hlEl = null, hlTimer = null;
  function drawBox(box, el) {
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
    return r;
  }
  function highlight(el, ms = 1800, scroll = true) {
    clearTimeout(hlTimer);
    hlEl = el;
    if (!el) { hlBox.style.display = 'none'; return; }
    if (scroll) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    drawBox(hlBox, el);
    hlTimer = setTimeout(() => { hlEl = null; hlBox.style.display = 'none'; }, ms);
  }

  // ---------- Selector generation ----------
  const looksDynamic = (s) =>
    s.length > 40 || /\d{3,}/.test(s) || /[0-9a-f]{8,}/i.test(s) ||
    (/^(css|sc|jsx|emotion|svelte|ng-|_)/i.test(s) && /\d/.test(s));
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'data-id', 'name',
    'aria-label', 'title', 'placeholder', 'alt', 'for', 'role', 'type', 'href'];
  const cssCount = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
  const xpCount = (s) => {
    try { return document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength; }
    catch { return 0; }
  };
  const xq = (s) => !s.includes('"') ? `"${s}"` : !s.includes("'") ? `'${s}'`
    : 'concat(' + s.split('"').map((p) => `"${p}"`).join(`, '"', `) + ')';
  const tagOf = (el) => CSS.escape(el.localName);
  const stableClasses = (el) =>
    Array.from(el.classList).filter((c) => !looksDynamic(c) && !/^(is-|has-)?(active|hover|focus|open|selected)$/.test(c));

  function cssSegment(el) {
    if (el.id && !looksDynamic(el.id) && cssCount('#' + CSS.escape(el.id)) === 1)
      return { s: '#' + CSS.escape(el.id), stop: true };
    let s = tagOf(el);
    const cls = stableClasses(el).slice(0, 2);
    if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
    const p = el.parentElement;
    if (p) {
      const same = Array.from(p.children).filter((c) => c.localName === el.localName);
      if (same.length > 1) {
        const peers = Array.from(p.children).filter((c) => { try { return c.matches(s); } catch { return false; } });
        if (peers.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
    }
    return { s, stop: false };
  }
  function shortestCssPath(el) {
    const parts = [];
    for (let cur = el, depth = 0; cur && cur.nodeType === 1 && depth < 15; cur = cur.parentElement, depth++) {
      const seg = cssSegment(cur);
      parts.unshift(seg.s);
      const sel = parts.join(' > ');
      if (cssCount(sel) === 1 && document.querySelector(sel) === el) return sel;
      if (seg.stop || cur === document.documentElement) break;
    }
    return null;
  }
  function fullCssPath(el) {
    const parts = [];
    for (let cur = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const i = Array.from(cur.parentElement.children).indexOf(cur) + 1;
      parts.unshift(`${tagOf(cur)}:nth-child(${i})`);
    }
    return 'html > ' + parts.join(' > ');
  }
  function absXPath(el) {
    const parts = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const html = cur.namespaceURI === 'http://www.w3.org/1999/xhtml';
      const name = html ? cur.localName : `*[local-name()="${cur.localName}"]`;
      const p = cur.parentElement;
      const same = p ? Array.from(p.children).filter((c) => c.localName === cur.localName) : [cur];
      parts.unshift(same.length > 1 ? `${name}[${same.indexOf(cur) + 1}]` : name);
    }
    return '/' + parts.join('/');
  }

  function genSelectors(el) {
    const out = [];
    const seen = new Set();
    const add = (type, value, label) => {
      if (!value || seen.has(type + value)) return;
      const els = queryAll({ type, value });
      if (!els || !els.includes(el)) return; // must actually find this element
      seen.add(type + value);
      const idx = els.indexOf(el);
      if (idx > 0) return; // first match must be our element
      out.push({ type, value, label, count: els.length });
    };
    const tag = tagOf(el);
    if (el.id && !looksDynamic(el.id)) add('css', '#' + CSS.escape(el.id), 'id');
    for (const a of STABLE_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 80 && !/[\n\r]/.test(v)) add('css', `${tag}[${a}="${v.replace(/["\\]/g, '\\$&')}"]`, 'attribute ' + a);
    }
    const cls = stableClasses(el).slice(0, 3);
    if (cls.length) add('css', tag + '.' + cls.map(CSS.escape).join('.'), 'classes');
    add('css', shortestCssPath(el), 'short path');
    const text = norm(el.textContent);
    if (text && text.length <= 60 && el.children.length <= 3) {
      const xp = `//${el.localName}[normalize-space(.)=${xq(text)}]`;
      add('xpath', xp, 'text');
      const n = xpCount(xp);
      if (n > 1) add('xpath', `(${xp})[1]`, 'text (first)');
    }
    for (const a of ['id', ...STABLE_ATTRS]) {
      const v = el.getAttribute(a);
      if (v && v.length <= 80 && !(a === 'id' && looksDynamic(v))) {
        add('xpath', `//${el.localName}[@${a}=${xq(v)}]`, 'xpath @' + a);
        break;
      }
    }
    add('css', fullCssPath(el), 'full path');
    add('xpath', absXPath(el), 'absolute xpath');
    // Unique selectors first, keep generation order otherwise.
    return out.sort((a, b) => (a.count === 1 ? 0 : 1) - (b.count === 1 ? 0 : 1));
  }

  function describe(el) {
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    const cls = Array.from(el.classList).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return { summary: s, text: norm(el.textContent).slice(0, 80), selectors: genSelectors(el) };
  }

  // ---------- Picker ----------
  let picking = null; // {purpose, cur, stack}
  let lastPicked = null, refineStack = [];
  const BLOCK = ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'auxclick'];

  function startPick(purpose) {
    stopPick(false);
    picking = { purpose, cur: null, stack: [] };
    hideBubble();
    window.addEventListener('mousemove', onPickMove, true);
    window.addEventListener('keydown', onPickKey, true);
    window.addEventListener('wheel', onPickWheel, { capture: true, passive: false });
    for (const t of BLOCK) window.addEventListener(t, onPickClick, true);
    hint.innerHTML = '<b>Click</b> an element to select it · <b>Alt+wheel</b> or <b>↑/↓</b> parent/child · <b>Enter</b> select · <b>Esc</b> cancel';
    hint.style.display = 'block';
    layout();
  }
  function stopPick(notifyCancel) {
    if (!picking) return;
    const purpose = picking.purpose;
    window.removeEventListener('mousemove', onPickMove, true);
    window.removeEventListener('keydown', onPickKey, true);
    window.removeEventListener('wheel', onPickWheel, true);
    for (const t of BLOCK) window.removeEventListener(t, onPickClick, true);
    picking = null;
    pickBox.style.display = 'none';
    hint.style.display = 'none';
    if (notifyCancel) chrome.runtime.sendMessage({ type: 'picked', purpose, cancelled: true }).catch(() => {});
    layout();
  }
  function setPickCur(el) {
    picking.cur = el;
    const r = drawBox(pickBox, el);
    const d = el.localName + (el.id ? '#' + el.id : '') +
      (el.classList.length ? '.' + Array.from(el.classList).slice(0, 2).join('.') : '');
    pickLabel.textContent = `${d}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    pickLabel.style.top = r.top < 24 ? '100%' : '-21px';
    pickLabel.style.marginTop = r.top < 24 ? '2px' : '0';
  }
  function onPickMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || (picking.stack.length && picking.stack[0] === el)) return;
    picking.stack = [el];
    setPickCur(el);
  }
  function goParent() {
    const p = picking.cur && picking.cur.parentElement;
    if (p && p !== document.documentElement) { picking.stack.push(p); setPickCur(p); }
  }
  function goChild() {
    if (picking.stack.length > 1) { picking.stack.pop(); setPickCur(picking.stack[picking.stack.length - 1]); }
  }
  function onPickWheel(e) {
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    if (e.deltaY < 0) goParent(); else goChild();
  }
  function onPickKey(e) {
    const k = e.key;
    if (!['Escape', 'ArrowUp', 'ArrowDown', 'Enter'].includes(k)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (k === 'Escape') stopPick(true);
    else if (k === 'ArrowUp') goParent();
    else if (k === 'ArrowDown') goChild();
    else if (k === 'Enter' && picking.cur) finishPick(picking.cur);
  }
  function onPickClick(e) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const el = picking.cur || (e.target !== host ? e.target : null);
    if (el) finishPick(el);
  }
  function finishPick(el) {
    const purpose = picking.purpose;
    stopPick(false);
    lastPicked = el;
    refineStack = [];
    highlight(el, 1200, false);
    chrome.runtime.sendMessage({ type: 'picked', purpose, info: describe(el) }).catch(() => {});
  }

  // ---------- Status for the side panel ----------
  function evalNote(n) {
    n = NX.normalize(n);
    const counts = (n.target.selectors || []).map((s) => { const r = queryAll(s); return r === null ? null : r.length; });
    const t = resolveTarget(n);
    const conds = (n.conditions || []).map((c) => {
      const els = c.sel && c.sel.value ? queryAll(c.sel) : [];
      return { ok: evalCondition(c), count: els === null ? null : els.length };
    });
    return {
      url: location.href,
      urlMatch: NX.urlMatches(n.urlPattern, location.href),
      counts, used: t.used, found: !!t.el, visible: isVisible(t.el),
      conds, met: conditionsMet(n),
    };
  }

  // ---------- Messages ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping': sendResponse({ ok: true, url: location.href }); break;
      case 'startPick': startPick(msg.purpose); sendResponse({ ok: true }); break;
      case 'cancelPick': stopPick(false); sendResponse({ ok: true }); break;
      case 'refine': {
        if (!lastPicked || !lastPicked.isConnected) { sendResponse({ error: 'Pick an element first' }); break; }
        if (msg.dir === 'up') {
          const p = lastPicked.parentElement;
          if (p && p !== document.documentElement) { refineStack.push(lastPicked); lastPicked = p; }
        } else {
          lastPicked = refineStack.pop() || lastPicked.firstElementChild || lastPicked;
        }
        highlight(lastPicked, 1500);
        sendResponse({ info: describe(lastPicked) });
        break;
      }
      case 'highlight': {
        const els = queryAll(msg.sel);
        const el = msg.sel ? els && els[0] : resolveTarget(NX.normalize(msg.note)).el;
        highlight(el || null);
        if (el && msg.adopt) { lastPicked = el; refineStack = []; }
        sendResponse({ found: !!el });
        break;
      }
      case 'evalNote': sendResponse(evalNote(msg.note)); break;
    }
    return false;
  });

  // ---------- Data ----------
  async function reload() {
    notes = await NX.loadNotes();
    settings = await NX.loadSettings();
    scheduleEval();
  }
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && (ch[NX.STORAGE_KEY] || ch[NX.SETTINGS_KEY])) reload();
  });

  // ---------- Scheduling ----------
  let evalTimer = null, rafId = 0;
  function scheduleEval() {
    if (evalTimer) return;
    evalTimer = setTimeout(() => { evalTimer = null; evaluate(); layout(); }, 120);
  }
  function scheduleLayout() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; layout(); });
  }
  window.addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
  window.addEventListener('resize', scheduleLayout, { passive: true });
  for (const t of ['input', 'change', 'click', 'keyup', 'transitionend', 'animationend', 'hashchange', 'popstate'])
    window.addEventListener(t, scheduleEval, { capture: true, passive: true });
  new MutationObserver(scheduleEval).observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  setInterval(scheduleEval, 1000); // safety net (SPA navigation, CSS-only changes, ...)

  reload();
})();

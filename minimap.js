// Minimap: a thin see-through strip at the right edge of each scrolling area (the page itself and any
// inner scrolling panel that holds markers). It shows the visible part as a box and every marker
// as a tick, so markers far down the page are never out of mind.
// It never takes mouse events, so the scrollbar and the page work exactly as before.
// content.js calls NX.minimap.update(...) after every layout (scroll, resize, DOM change).
(() => {
  if (window.__nxMinimapLoaded) return;
  window.__nxMinimapLoaded = true;
  const NX = globalThis.NX;

  const W = 24; // strip width in px (room for 3 side-by-side lanes of overlapping ticks)
  const LANES = 3;
  const host = document.createElement('nx-notes-minimap');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  .strip { position: fixed; left: 0; top: 0; width: ${W}px; pointer-events: none; border-radius: 4px;
           background: rgba(127,127,127,.13); box-shadow: inset 0 0 0 1px rgba(127,127,127,.22); }
  .view { position: absolute; left: -1px; right: -1px; border-radius: 3px;
          border: 1.5px solid rgba(229,57,53,.85); background: rgba(255,235,59,.22); }
  .tick { position: absolute; border-radius: 2px; opacity: .92;
          box-shadow: 0 0 0 1px rgba(255,255,255,.75), 0 0 2px rgba(0,0,0,.5); }
  .tick.unmet { opacity: .35; }
</style>`;

  const strips = new Map(); // 'doc' | scrolling element -> { box, view, ticks: [] }

  // Nearest scrolling ancestor (an inner panel), or null when the page itself scrolls it.
  const scrollerCache = new WeakMap(); // el -> { s, t }
  function scrollerOf(el) {
    const c = scrollerCache.get(el);
    if (c && Date.now() - c.t < 1500) return c.s;
    let s = null;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 4) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') { s = p; break; }
      }
    }
    scrollerCache.set(el, { s, t: Date.now() });
    return s;
  }

  // Visible geometry of a scrolling area: where to draw, total height, scroll position.
  function geometry(key) {
    if (key === 'doc') {
      const se = document.scrollingElement || document.documentElement;
      // Viewport size without scrollbars. In quirks mode (pages with no <!DOCTYPE>, e.g. Hacker News)
      // <html>.clientHeight is the whole page height, and <body> reports the viewport instead.
      const vp = document.compatMode === 'BackCompat' && document.body ? document.body : document.documentElement;
      const viewH = vp.clientHeight || innerHeight;
      const viewW = vp.clientWidth || innerWidth;
      return { right: viewW, top: 0, height: viewH, total: se.scrollHeight, scrollTop: se.scrollTop, contentTop: -se.scrollTop };
    }
    const r = key.getBoundingClientRect();
    const top = r.top + key.clientTop;
    return {
      right: r.left + key.clientLeft + key.clientWidth, // just left of its scrollbar
      top, height: key.clientHeight, total: key.scrollHeight, scrollTop: key.scrollTop,
      contentTop: top - key.scrollTop,
      offscreen: r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth,
    };
  }

  function stripFor(key) {
    let s = strips.get(key);
    if (!s) {
      const box = document.createElement('div');
      box.className = 'strip';
      const view = document.createElement('div');
      view.className = 'view';
      box.appendChild(view);
      root.appendChild(box);
      s = { box, view, ticks: [] };
      strips.set(key, s);
    }
    return s;
  }
  function dropStrip(key) {
    const s = strips.get(key);
    if (s) { s.box.remove(); strips.delete(key); }
  }

  function draw(key, list) {
    const g = geometry(key);
    if (g.total <= g.height + 4 || g.height < 60 || g.offscreen) return dropStrip(key);
    const s = stripFor(key);
    const x = g.right - W - 2, y = g.top + 2, h = g.height - 4;
    const scale = h / g.total;
    s.box.style.transform = `translate(${x}px, ${y}px)`;
    s.box.style.height = h + 'px';
    s.view.style.top = g.scrollTop * scale + 'px';
    s.view.style.height = Math.max(6, g.height * scale) + 'px';
    // Ticks: reuse divs, one per marker.
    while (s.ticks.length < list.length) {
      const t = document.createElement('div');
      t.className = 'tick';
      s.box.appendChild(t);
      s.ticks.push(t);
    }
    while (s.ticks.length > list.length) s.ticks.pop().remove();
    // Measure every tick first.
    const ts = list.map(({ n, el, met }, i) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { i, hidden: true };
      const th = Math.max(3, Math.min(h, r.height * scale));
      const ty = Math.min(h - th, Math.max(0, (r.top - g.contentTop) * scale));
      return { i, n, met, ty, th };
    });
    assignLanes(ts.filter((t) => !t.hidden));
    for (const t of ts) {
      const d = s.ticks[t.i];
      if (t.hidden) { d.style.display = 'none'; continue; }
      // Inside the strip's 1px inset: lane `lane` of `lanes` equal columns.
      const inner = W - 2, colW = inner / t.lanes;
      d.style.display = '';
      d.style.top = t.ty + 'px';
      d.style.height = t.th + 'px';
      d.style.left = 1 + t.lane * colW + 'px';
      d.style.width = Math.max(2, colW - (t.lanes > 1 ? 1 : 0)) + 'px';
      d.style.background = t.n.marker.color || '#e53935';
      d.className = 'tick' + (t.met ? '' : ' unmet');
      d.title = t.n.title || '';
    }
  }

  // Ticks that overlap vertically (directly or through a chain) form a group; inside a group each
  // tick gets the first free lane, and the group splits the strip into as many columns as it needs
  // (max 3). A tick that overlaps nothing keeps the full width.
  function assignLanes(ticks) {
    ticks.sort((a, b) => a.ty - b.ty);
    let group = [], groupEnd = -Infinity;
    const close = () => {
      const used = Math.min(LANES, Math.max(1, ...group.map((t) => t.lane + 1)));
      for (const t of group) t.lanes = used;
      group = [];
    };
    for (const t of ticks) {
      if (t.ty >= groupEnd && group.length) close();
      // Lowest lane whose last tick has ended above this one; past 3, share lanes round-robin.
      const busy = new Set(group.filter((o) => o.ty + o.th > t.ty).map((o) => o.lane));
      let lane = 0;
      while (busy.has(lane)) lane++;
      t.lane = lane < LANES ? lane : group.length % LANES;
      group.push(t);
      groupEnd = Math.max(groupEnd, t.ty + t.th);
    }
    if (group.length) close();
  }

  function update({ items, settings, picking }) {
    const on = settings.allEnabled !== false && settings.minimap !== false && !picking;
    const shown = on ? items.filter((i) => i.el && i.el.isConnected && (i.met || settings.editMode)) : [];
    const groups = new Map();
    const add = (k, it) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); };
    for (const it of shown) {
      add('doc', it); // every marker shows on the page strip
      const sc = scrollerOf(it.el);
      if (sc) add(sc, it); // ...and on its inner scrolling panel's strip
    }
    for (const k of [...strips.keys()]) if (!groups.has(k) || (k !== 'doc' && !k.isConnected)) dropStrip(k);
    for (const [k, list] of groups) draw(k, list);
    if (strips.size && !host.isConnected) document.documentElement.appendChild(host);
  }

  NX.minimap = { update };
})();

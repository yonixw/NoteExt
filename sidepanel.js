// Side panel: list / edit notes. Every change is auto-saved to chrome.storage.local.
// NX comes from shared.js.
const $ =(s) => document.querySelector(s);

let notes = [];
let settings = {};
let selectedId = null;
let tab = { id: null, url: '' };
let pendingPick = null; // purpose string while the page picker is active
let importData = null;
let refs = {}; // live status elements of the current editor
let lastSavedJson = '';
const ownWrites = new Set(); // JSON snapshots we wrote whose change event hasn't come back yet

// JSON with sorted object keys: chrome.storage hands values back with keys reordered,
// so plain JSON.stringify can't tell whether a change event is our own write.
const stableJson = (v) => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x);

// ---------- tiny DOM helper ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

// ---------- storage ----------
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    lastSavedJson = stableJson(notes);
    ownWrites.add(lastSavedJson);
    chrome.storage.local.set({ [NX.STORAGE_KEY]: notes });
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 250);
}
function saveSettings() { chrome.storage.local.set({ [NX.SETTINGS_KEY]: settings }); }
const current = () => notes.find((n) => n.id === selectedId) || null;
function touch(n) { n.updatedAt = Date.now(); save(); renderSelect(); }

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch[NX.STORAGE_KEY]) return;
  const json = stableJson(ch[NX.STORAGE_KEY].newValue || []);
  // Echo of one of our own writes (it can arrive after we've already saved newer edits) -> ignore,
  // otherwise we would re-render from stale data, lose focus and revert what was just typed.
  if (ownWrites.delete(json) || json === lastSavedJson) return;
  notes = (ch[NX.STORAGE_KEY].newValue || []).map(NX.normalize);
  lastSavedJson = json;
  if (!current()) selectedId = null;
  renderAll();
});

// ---------- talking to the page ----------
async function refreshTab() {
  const forced = new URLSearchParams(location.search).get('tabId'); // for testing outside the side panel
  let t;
  if (forced) t = await chrome.tabs.get(Number(forced)).catch(() => null);
  else [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  const changed = !t || t.id !== tab.id || t.url !== tab.url;
  tab = t ? { id: t.id, url: t.url || '' } : { id: null, url: '' };
  return changed;
}
// Frame of a note: '' = top page (frameId 0), otherwise the iframe whose URL matches the pattern.
async function frameIdFor(pattern) {
  if (!pattern) return 0;
  const frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
  const f = frames.find((x) => x.frameId !== 0 && NX.urlMatches(pattern, x.url));
  if (!f) throw new Error('this note’s iframe is not on the page');
  return f.frameId;
}
// where: 'note' (frame of the current note, default) | 'all' (every frame) | a frameId
async function sendToTab(msg, where = 'note') {
  if (tab.id == null) throw new Error('No active tab');
  const frameId = where === 'all' ? undefined : typeof where === 'number' ? where : await frameIdFor(current()?.frame || '');
  const send = () => frameId === undefined
    ? chrome.tabs.sendMessage(tab.id, msg)
    : chrome.tabs.sendMessage(tab.id, msg, { frameId });
  try {
    return await send();
  } catch {
    // Content script not there yet (tab opened before the extension was loaded) -> inject it.
    try {
      const files = ['shared.js', 'content.js', 'minimap.js'];
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files })
        .catch(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, files }));
    } catch (e) {
      throw new Error('Cannot run on this page (' + (e.message || e) + ')');
    }
    return await send();
  }
}
function showMsg(text) {
  const m = $('#msg');
  m.textContent = text;
  m.hidden = !text;
  if (text) setTimeout(() => { if (m.textContent === text) m.hidden = true; }, 5000);
}

async function startPick(purpose, label) {
  try {
    await sendToTab({ type: 'startPick', purpose }, 'all'); // the user may click inside any iframe
    pendingPick = purpose;
    $('#bannerText').textContent = label || 'Click an element on the page…';
    $('#banner').hidden = false;
  } catch (e) { showMsg(e.message); }
}
function endPickUi() { pendingPick = null; $('#banner').hidden = true; }
$('#bannerCancel').onclick = () => { sendToTab({ type: 'cancelPick' }, 'all').catch(() => {}); endPickUi(); };

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'editNote') { select(msg.id); return; }
  if (msg.type !== 'picked' || msg.purpose !== pendingPick) return;
  if (sender.tab && sender.tab.id !== tab.id) return;
  endPickUi();
  sendToTab({ type: 'cancelPick' }, 'all').catch(() => {}); // stop picking in the other frames
  if (msg.cancelled) return;
  const frame = !sender.frameId ? '' : NX.defaultUrlPattern(sender.url || '');
  onPicked(msg.purpose, msg.info, frame);
});

function selectorsFromInfo(info) {
  return info.selectors.map(({ type, value, label }) => ({ type, value, label }));
}
function onPicked(purpose, info, frame) {
  if (!info.selectors.length) return showMsg('Could not build a selector for that element.');
  if (purpose === 'new') {
    const n = NX.newNote(tab.url);
    n.title = (info.text || info.summary).slice(0, 40) || 'New note';
    n.frame = frame;
    n.target.selectors = selectorsFromInfo(info);
    notes.push(n);
    save(true);
    select(n.id);
    return;
  }
  const n = current();
  if (!n) return;
  if (purpose === 'target') {
    n.frame = frame;
    n.target.selectors = selectorsFromInfo(info);
    n.target.active = 0;
  } else if (purpose.startsWith('cond:')) {
    if (frame !== (n.frame || '')) return showMsg('A condition’s element must be in the same frame (page or iframe) as the note’s element.');
    const c = n.conditions.find((x) => x.id === purpose.slice(5));
    if (c) c.sel = { type: info.selectors[0].type, value: info.selectors[0].value };
  }
  touch(n);
  renderEditor();
}

// ---------- header ----------
function noteLabel(n) {
  let where = n.urlPattern || '';
  try { const u = new URL(where.replace(/\*/g, 'x')); where = u.host + u.pathname.replace(/x$/, '*'); } catch {}
  return `${n.enabled === false ? '⏸ ' : ''}${n.title || '(untitled)'}  —  ${where}`;
}
function renderSelect() {
  const sel = $('#noteSelect');
  const list = notes
    .filter((n) => !settings.onlyThisPage || NX.urlMatches(n.urlPattern, tab.url) || n.id === selectedId)
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  sel.replaceChildren(
    h('option', { value: '' }, list.length ? `— ${list.length} note${list.length > 1 ? 's' : ''}${settings.onlyThisPage ? ' on this page' : ''} —` : '— no notes —'),
    ...list.map((n) => h('option', { value: n.id, selected: n.id === selectedId }, noteLabel(n)))
  );
  sel.value = selectedId || '';
}
$('#noteSelect').onchange = (e) => select(e.target.value || null);
$('#newBtn').onclick = () => startPick('new', 'Click the element to attach the new note to…');
$('#onlyPage').onchange = (e) => { settings.onlyThisPage = e.target.checked; saveSettings(); renderSelect(); };
$('#editMode').onchange = (e) => { settings.editMode = e.target.checked; saveSettings(); };
$('#minimap').onchange = (e) => { settings.minimap = e.target.checked; saveSettings(); };
$('#masterSwitch').onchange = (e) => { settings.allEnabled = e.target.checked; saveSettings(); renderMaster(); };
function renderMaster() {
  $('#masterSwitch').checked = settings.allEnabled !== false;
  $('#masterText').textContent = settings.allEnabled !== false ? 'Notes on' : 'All notes off';
  document.body.classList.toggle('all-off', settings.allEnabled === false);
}

function select(id) {
  selectedId = id && notes.some((n) => n.id === id) ? id : null;
  settings.selectedId = selectedId;
  saveSettings();
  renderSelect();
  renderEditor();
  window.scrollTo(0, 0);
  const n = current();
  if (n) sendToTab({ type: 'highlight', note: n, adopt: true }).catch(() => {});
}

// ---------- export / import ----------
$('#exportBtn').onclick = () => {
  const data = { app: 'NoteExt', version: 1, exportedAt: new Date().toISOString(), notes };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `noteext-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const arr = Array.isArray(d) ? d : d.notes;
    if (!Array.isArray(arr)) throw new Error('no "notes" array found');
    importData = arr.map(NX.normalize);
    $('#importName').textContent = `${f.name} (${importData.length} notes)`;
    $('#importBar').hidden = false;
  } catch (err) { showMsg('Import failed: ' + err.message); }
};
function finishImport(replace) {
  if (!importData) return;
  if (replace) notes = importData;
  else {
    const byId = new Map(notes.map((n) => [n.id, n]));
    for (const n of importData) byId.set(n.id, n);
    notes = [...byId.values()];
  }
  importData = null;
  $('#importBar').hidden = true;
  save(true);
  if (!current()) selectedId = null;
  renderAll();
}
$('#importMerge').onclick = () => finishImport(false);
$('#importReplace').onclick = () => finishImport(true);
$('#importCancel').onclick = () => { importData = null; $('#importBar').hidden = true; };

// ---------- editor ----------
const POINTS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const ARROWS = ['↖', '↑', '↗', '←', '•', '→', '↙', '↓', '↘'];

function input(n, getSet, props = {}) {
  // getSet: [object, key]
  const [obj, key] = getSet;
  return h('input', Object.assign({
    type: 'text', value: obj[key] ?? '',
    oninput: (e) => { obj[key] = props.type === 'number' ? Number(e.target.value) : e.target.value; touch(n); },
  }, props));
}
function seg(options, value, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, label]) =>
    h('button', { class: v === value ? 'on' : '', onclick: () => onPick(v) }, label)));
}

function renderEditor() {
  const ed = $('#editor');
  const n = current();
  refs = {};
  $('#empty').hidden = !!n;
  if (!n) { ed.replaceChildren(); return; }
  const rerender = () => { touch(n); renderEditor(); };

  // --- title / enabled / delete
  const head = h('section', {},
    h('div', { class: 'field' }, input(n, [n, 'title'], { class: 'title-input', placeholder: 'Title' })),
    h('div', { class: 'field' },
      h('label', {}, h('input', { type: 'checkbox', checked: n.enabled !== false, onchange: (e) => { n.enabled = e.target.checked; touch(n); } }), 'Enabled'),
      h('span', { class: 'spacer' }),
      h('button', { title: 'Copy this note (title and label get “(2)”)', onclick: () => duplicate(n) }, '⧉ Duplicate'),
      h('button', { class: 'danger', onclick: (e) => {
        const btn = e.currentTarget;
        if (!btn.dataset.armed) {
          btn.dataset.armed = '1';
          btn.textContent = 'Click again to delete';
          setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Delete note'; }, 3000);
          return;
        }
        notes = notes.filter((x) => x !== n);
        save(true);
        select(null);
      } }, 'Delete note')));

  // --- page / URL
  refs.url = h('span', { class: 'status' });
  const page = h('section', {},
    h('h3', {}, 'Page', refs.url),
    h('div', { class: 'field' }, refs.urlInput = input(n, [n, 'urlPattern'], { placeholder: 'https://site.com/path*  (* = anything)' })),
    h('div', { class: 'field small' },
      h('span', { class: 'hint' }, 'Set to:'),
      ...[['This page', () => NX.defaultUrlPattern(tab.url)],
          ['Exact URL', () => tab.url],
          ['Whole site', () => { try { return new URL(tab.url).origin + '/*'; } catch { return '*'; } }],
          ['Everywhere', () => '*']]
        .map(([label, f]) => h('button', { class: 'link', onclick: () => { n.urlPattern = f(); refs.urlInput.value = n.urlPattern; touch(n); refreshStatus(); } }, label))),
    n.frame ? h('div', { class: 'field small', title: 'The element lives inside an iframe whose URL matches this pattern' },
      h('span', { class: 'hint' }, 'In iframe:'),
      input(n, [n, 'frame'], { class: 'mono' })) : null);

  // --- element
  refs.target = h('span', { class: 'status' });
  refs.counts = [];
  const selRows = n.target.selectors.map((s, i) => {
    const cnt = h('span', { class: 'count' }, '…');
    refs.counts.push(cnt);
    const row = h('div', { class: 'sel-row', title: s.label || '' },
      h('input', { type: 'radio', name: 'activeSel', checked: (n.target.active || 0) === i, title: 'Use this selector first',
        onchange: () => { n.target.active = i; touch(n); } }),
      h('select', { onchange: (e) => { s.type = e.target.value; touch(n); } },
        h('option', { value: 'css', selected: s.type !== 'xpath' }, 'CSS'),
        h('option', { value: 'xpath', selected: s.type === 'xpath' }, 'XPath')),
      h('input', { type: 'text', value: s.value, placeholder: s.label || 'selector', title: s.label || '',
        oninput: (e) => { s.value = e.target.value; touch(n); },
        onfocus: () => sendToTab({ type: 'highlight', sel: s }).catch(() => {}) }),
      h('span', { style: 'display:flex;align-items:center;gap:2px' }, cnt,
        h('button', { class: 'link icon', title: 'Widen with * (starts with / contains / ends with)',
          onclick: () => toggleWiden(row, s, {
            onReplace: (v) => { s.value = v; rerender(); },
            onAdd: (v) => { n.target.selectors.push({ type: s.type, value: v, label: 'widened' }); n.target.active = n.target.selectors.length - 1; rerender(); },
          }) }, '✱'),
        h('button', { class: 'link icon', title: 'Remove', onclick: () => {
          n.target.selectors.splice(i, 1);
          const a = n.target.active || 0;
          // Keep the same selector chosen: shift up if a row above it was removed.
          if (i < a) n.target.active = a - 1;
          else if (a >= n.target.selectors.length) n.target.active = Math.max(0, n.target.selectors.length - 1);
          rerender();
        } }, '✕')));
    return row;
  });
  const refine = async (dir) => {
    try {
      const r = await sendToTab({ type: 'refine', dir });
      if (!r || r.error) return showMsg((r && r.error) || 'Pick an element first');
      n.target.selectors = selectorsFromInfo(r.info);
      n.target.active = 0;
      rerender();
    } catch (e) { showMsg(e.message); }
  };
  const element = h('section', {},
    h('h3', {}, 'Element', refs.target),
    selRows.length ? selRows : h('p', { class: 'hint' }, 'No element yet — click “Pick”.'),
    h('div', { class: 'field small' },
      h('button', { onclick: () => startPick('target', 'Click the element for this note…') }, '⌖ Pick'),
      h('button', { title: 'Select the parent element', onclick: () => refine('up') }, '↑ Parent'),
      h('button', { title: 'Go back to the child element', onclick: () => refine('down') }, '↓ Child'),
      h('button', { onclick: () => sendToTab({ type: 'highlight', note: n, adopt: true }).catch((e) => showMsg(e.message)) }, 'Show'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => { n.target.selectors.push({ type: 'css', value: '', label: 'custom' }); rerender(); } }, '+ selector')),
    h('div', { class: 'hint' }, 'The selected radio is tried first; the others are fallbacks. Numbers = matches on the current page. ✱ = widen a value with * wildcards.'),
    cheatSheet());

  // --- marker
  const m = n.marker;
  const isHl = m.kind === 'highlight';
  const setKind = (v) => {
    // Switching to the highlighter with the default red dot colors -> start with classic yellow/black.
    if (v === 'highlight' && m.color === '#e53935' && m.textColor === '#ffffff') { m.color = '#ffeb3b'; m.textColor = '#000000'; }
    m.kind = v;
    if (v === 'tooltip' && n.anchor.mode === 'edge') n.anchor.mode = 'outside';
    rerender();
  };
  const marker = h('section', {},
    h('h3', {}, 'Marker'),
    h('div', { class: 'field' },
      seg([['dot', '● Dot'], ['tooltip', '💬 Tooltip'], ['highlight', '🖍 Highlight']], m.kind, setKind)),
    h('div', { class: 'field' },
      h('input', { type: 'color', value: m.color, title: 'Background', oninput: (e) => { m.color = e.target.value; touch(n); } }),
      h('input', { type: 'color', value: m.textColor, title: 'Text color', oninput: (e) => { m.textColor = e.target.value; touch(n); } }),
      h('div', { class: 'presets' }, NX.COLOR_PRESETS.map(([bg, fg, name]) =>
        h('button', { class: 'preset' + (m.color === bg && m.textColor === fg ? ' on' : ''), title: name, style: `background:${bg};color:${fg}`,
          onclick: () => { m.color = bg; m.textColor = fg; rerender(); } }, 'Aa'))),
      m.kind === 'dot' ? h('label', { class: 'small', title: 'Size in px' }, 'Size',
        input(n, [m, 'size'], { type: 'number', min: 6, max: 60, style: 'width:52px' })) : null),
    isHl ? h('div', { class: 'field' },
      input(n, [m, 'text'], { class: 'mono', placeholder: 'Text pattern (empty = whole element), e.g.  Total: *' }),
      refs.textCount = h('span', { class: 'count' })) : null,
    isHl ? h('div', { class: 'field small' },
      h('label', { title: 'Unchecked: only the first match' },
        h('input', { type: 'checkbox', checked: !!m.allMatches, onchange: (e) => { m.allMatches = e.target.checked; touch(n); } }),
        'All matches'),
      h('label', { title: 'Whole-element mode: also recolor everything inside the element (otherwise children with their own colors keep them)' },
        h('input', { type: 'checkbox', checked: m.deep !== false, onchange: (e) => { m.deep = e.target.checked; touch(n); } }),
        'Include children')) : null,
    isHl ? h('div', { class: 'hint' },
      '* at the start/end = rest of that word (Total: * → “Total: $42.00”, Order #* → “Order #1234”); ',
      '* in the middle = anything. Case-insensitive. The note opens from the sidebar.') : null,
    isHl ? null : h('div', { class: 'field' },
      input(n, [m, 'label'], { placeholder: m.kind === 'dot' ? 'Label (optional): 3, !, 🔥' : 'Text, number or emoji (empty = title)' })),
    isHl ? null : h('div', { class: 'pos' },
      h('div', { class: 'grid9' }, POINTS.map((p, i) =>
        h('button', { class: n.anchor.point === p ? 'on' : '', title: p, onclick: () => { n.anchor.point = p; rerender(); } }, ARROWS[i]))),
      h('div', { class: 'col' },
        seg([['outside', 'Outside'], ['edge', 'On edge'], ['inside', 'Inside']], n.anchor.mode, (v) => { n.anchor.mode = v; rerender(); }),
        h('div', { class: 'field small' },
          h('label', {}, 'X', input(n, [n.anchor, 'dx'], { type: 'number', step: 1 })),
          h('label', {}, 'Y', input(n, [n.anchor, 'dy'], { type: 'number', step: 1 })),
          h('span', { class: 'hint' }, 'px offset')))));

  // --- note text
  const text = h('section', {},
    h('h3', {}, 'Note'),
    h('textarea', { value: n.text || '', placeholder: 'Write anything…', oninput: (e) => { n.text = e.target.value; touch(n); } }));

  // --- conditions
  refs.cond = h('span', { class: 'status' });
  refs.condRes = [];
  const condRows = n.conditions.map((c, i) => {
    const chk = NX.checkById(c.check);
    const res = h('span', { class: 'res' }, '…');
    refs.condRes.push(res);
    const usesSel = chk.needsSel || chk.optionalSel;
    return h('div', { class: 'cond' },
      h('div', { class: 'field' },
        res,
        h('select', { class: 'grow', onchange: (e) => { c.check = e.target.value; rerender(); } },
          NX.CHECKS.map((k) => h('option', { value: k.id, selected: k.id === c.check }, k.label))),
        h('button', { class: 'link icon', title: 'Remove condition', onclick: () => { n.conditions.splice(i, 1); rerender(); } }, '✕')),
      usesSel ? h('div', { class: 'field' },
        h('select', { onchange: (e) => { c.sel.type = e.target.value; touch(n); } },
          h('option', { value: 'css', selected: c.sel.type !== 'xpath' }, 'CSS'),
          h('option', { value: 'xpath', selected: c.sel.type === 'xpath' }, 'XPath')),
        input(n, [c.sel, 'value'], { class: 'mono', placeholder: chk.optionalSel ? 'link element (or leave empty and put URL below)' : 'element selector',
          onfocus: () => sendToTab({ type: 'highlight', sel: c.sel }).catch(() => {}) }),
        h('button', { title: 'Pick element', onclick: () => startPick('cond:' + c.id, 'Click the element this condition checks…') }, '⌖'),
        h('button', { title: 'Widen with * (starts with / contains / ends with)',
          onclick: (e) => toggleWiden(e.currentTarget.parentElement, c.sel, { onReplace: (v) => { c.sel.value = v; touch(n); renderEditor(); } }) }, '✱')) : null,
      chk.needsValue || chk.optionalSel ? h('div', { class: 'field' },
        input(n, [c, 'value'], { placeholder: chk.optionalSel ? 'URL (used when no element is given)'
          : c.check === 'attrEquals' ? 'aria-selected=true   (* = wildcard)'
          : c.check === 'textMatches' || c.check === 'urlMatches' ? 'regular expression'
          : /Equals|Class|urlContains/.test(c.check) ? 'value   (* = wildcard: abc*  *abc  *abc*)' : 'value' })) : null);
  });
  const conds = h('section', {},
    h('h3', {}, 'Conditions', refs.cond),
    n.conditions.length > 1 ? h('div', { class: 'field small' }, 'Show when',
      seg([['all', 'all'], ['any', 'any']], n.conditionMode, (v) => { n.conditionMode = v; rerender(); }), 'are true') : null,
    condRows.length ? condRows : h('p', { class: 'hint' }, 'No conditions — the marker is always shown when the element exists.'),
    h('button', { onclick: () => { n.conditions.push(NX.newCondition()); rerender(); } }, '+ Add condition'));

  ed.replaceChildren(head, text, page, element, marker, conds);
  refreshStatus();
}

// "Name" -> "Name (2)", "Name (2)" -> "Name (3)".
const bumpCopy = (s) => {
  const m = /^(.*) \((\d+)\)$/.exec(s || '');
  return m ? `${m[1]} (${Number(m[2]) + 1})` : `${s || ''} (2)`.trim();
};
function duplicate(n) {
  const copy = structuredClone(n);
  copy.id = NX.uid();
  copy.title = bumpCopy(n.title);
  if (copy.marker.label) copy.marker.label = bumpCopy(copy.marker.label); // empty label stays empty (plain dot)
  copy.conditions.forEach((c) => { c.id = NX.uid(); }); // internal ids must be unique
  copy.createdAt = copy.updatedAt = Date.now();
  notes.splice(notes.indexOf(n) + 1, 0, copy);
  save(true);
  select(copy.id);
}

// ---------- selector widening (* wildcards -> starts-with / contains / ends-with) ----------
const unescCss = (s) => s
  .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hx) => String.fromCodePoint(parseInt(hx, 16)))
  .replace(/\\(.)/g, '$1');
const cssStr = (s) => '"' + s.replace(/["\\]/g, '\\$&') + '"';
const xpStr = (s) => !s.includes('"') ? `"${s}"` : !s.includes("'") ? `'${s}'`
  : 'concat(' + s.split('"').map((p) => `"${p}"`).join(`, '"', `) + ')';

// Finds the editable values in a selector: ids, classes, attribute values, text.
function selectorTokens(sel) {
  const v = sel.value || '', out = [];
  if (sel.type === 'xpath') {
    const re = /(@[\w:-]+|normalize-space\(\s*\.?\s*\)|text\(\)|\.)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const m of v.matchAll(re))
      out.push({ kind: m[1].startsWith('@') ? m[1].slice(1) : 'text', expr: m[1], value: m[2] ?? m[3], start: m.index, end: m.index + m[0].length });
  } else {
    const id = '((?:\\\\[0-9a-fA-F]{1,6}\\s?|\\\\.|[\\w-])+)';
    const re = new RegExp(`\\[\\s*([\\w:-]+)\\s*[~|^$*]?=\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|([^\\]\\s]+))\\s*(?:[is]\\s*)?\\]|#${id}|\\.${id}`, 'g');
    for (const m of v.matchAll(re)) {
      const t = { start: m.index, end: m.index + m[0].length };
      if (m[1]) Object.assign(t, { kind: m[1], value: unescCss(m[2] ?? m[3] ?? m[4]) });
      else if (m[5]) Object.assign(t, { kind: 'id', short: true, value: unescCss(m[5]) });
      else Object.assign(t, { kind: 'class', short: true, value: unescCss(m[6]) });
      out.push(t);
    }
  }
  return out;
}
function widenCss(t, p) {
  if (!p.includes('*')) {
    if (t.short) return (t.kind === 'id' ? '#' : '.') + CSS.escape(p);
    return `[${t.kind}=${cssStr(p)}]`;
  }
  const parts = p.split('*'), last = parts.length - 1;
  return parts.map((s, i) => !s ? ''
    : t.kind === 'class' ? `[class*=${cssStr(s)}]` // class attr holds several names -> contains
    : i === 0 ? `[${t.kind}^=${cssStr(s)}]`
    : i === last ? `[${t.kind}$=${cssStr(s)}]`
    : `[${t.kind}*=${cssStr(s)}]`).join('') || `[${t.kind}]`;
}
function widenXPath(t, p) {
  const X = t.expr;
  if (!p.includes('*')) return `${X}=${xpStr(p)}`;
  const parts = p.split('*'), last = parts.length - 1;
  const conds = parts.map((s, i) => !s ? ''
    : i === 0 ? `starts-with(${X}, ${xpStr(s)})`
    : i === last ? `substring(${X}, string-length(${X}) - ${s.length - 1}) = ${xpStr(s)}` // XPath 1.0 has no ends-with
    : `contains(${X}, ${xpStr(s)})`).filter(Boolean);
  if (!conds.length) return X.startsWith('@') ? X : 'true()';
  return conds.length > 1 ? `(${conds.join(' and ')})` : conds[0];
}
function applyWiden(sel, toks, vals) {
  let out = sel.value;
  // Replace from the end so earlier positions stay valid.
  toks.map((t, i) => [t, vals[i]]).sort((a, b) => b[0].start - a[0].start).forEach(([t, p]) => {
    if (p === t.value) return;
    out = out.slice(0, t.start) + (sel.type === 'xpath' ? widenXPath(t, p) : widenCss(t, p)) + out.slice(t.end);
  });
  return out;
}
function paintCount(el, c) {
  el.textContent = c == null ? 'error' : c === 1 ? '1 ✓' : String(c);
  el.className = 'count ' + (c == null ? 'err' : c === 0 ? 'zero' : c === 1 ? 'one' : 'many');
  el.title = c == null ? 'Invalid selector' : c > 1 ? 'Matches several elements; the first one is used' : '';
}
function widenBox(sel, { onReplace, onAdd }) {
  const toks = selectorTokens(sel);
  const vals = toks.map((t) => t.value);
  const preview = h('code', { class: 'preview' });
  const cnt = h('span', { class: 'count' });
  let result = sel.value, seq = 0;
  const update = async () => {
    result = applyWiden(sel, toks, vals);
    preview.textContent = result;
    const my = ++seq;
    try {
      const r = await sendToTab({ type: 'count', sel: { type: sel.type, value: result } });
      if (my === seq) paintCount(cnt, r.count);
    } catch { cnt.textContent = '?'; }
  };
  const box = h('div', { class: 'widen' },
    h('div', { class: 'hint' }, 'Put * where the value changes:  abc* starts with · *abc ends with · *abc* contains · a*b both ends.'),
    toks.length
      ? toks.map((t, i) => h('div', { class: 'field' },
          h('span', { class: 'kind', title: t.kind }, t.kind),
          h('input', { type: 'text', class: 'mono', value: t.value, oninput: (e) => { vals[i] = e.target.value; update(); } })))
      : h('p', { class: 'hint' }, 'No id / class / attribute / text value found in this selector — edit it by hand (see the cheat sheet).'),
    h('div', { class: 'preview-row' }, preview, cnt),
    h('div', { class: 'field small' },
      h('button', { class: 'primary', onclick: () => onReplace(result) }, 'Replace'),
      onAdd ? h('button', { onclick: () => onAdd(result) }, 'Add as new selector') : null,
      h('button', { class: 'link', onclick: () => box.remove() }, 'Close')));
  update();
  return box;
}
function toggleWiden(afterEl, sel, opts) {
  const next = afterEl.nextElementSibling;
  if (next && next.classList.contains('widen')) return next.remove();
  afterEl.after(widenBox(sel, opts));
  afterEl.nextElementSibling.querySelector('input')?.focus();
}
function cheatSheet() {
  const rows = (list) => list.map(([code, what]) => h('tr', {}, h('td', {}, h('code', {}, code)), h('td', {}, what)));
  return h('details', { class: 'cheat' },
    h('summary', {}, 'Selector cheat sheet'),
    h('b', {}, 'CSS'),
    h('table', {}, rows([
      ['[id^="user-"]', 'id starts with'],
      ['[id$="-btn"]', 'id ends with'],
      ['[class*="card"]', 'class attribute contains'],
      ['a[href*="/inbox"]', 'link whose href contains'],
      ['div:has(> h2.title)', 'div that directly contains an h2.title'],
      ['li:nth-of-type(2)', '2nd li among its siblings'],
      ['ul > li / ul li', 'direct child / any descendant'],
      ['h2 + p / h2 ~ p', 'next sibling / any later sibling'],
    ])),
    h('b', {}, 'XPath'),
    h('table', {}, rows([
      ['//div[starts-with(@id, "user-")]', 'id starts with'],
      ['//a[contains(@href, "/inbox")]', 'href contains'],
      ['//button[contains(normalize-space(.), "Save")]', 'text contains'],
      ['//td[.="Total"]/following-sibling::td[1]', 'cell right after "Total"'],
      ['//span[.="Price"]/..', 'parent of the "Price" span'],
      ['//li[.//b[.="New"]]', 'li containing a bold "New"'],
      ['(//div[@role="row"])[3]', '3rd match in the whole page'],
    ])),
    h('p', { class: 'hint' }, 'Condition values (text / value / class / attribute equals, URL contains) accept * too. For anything fancier use “text matches regex”.'));
}

// ---------- live status from the page ----------
let statusBusy = false;
async function refreshStatus() {
  const n = current();
  if (!n || statusBusy) return;
  statusBusy = true;
  try {
    const st = await sendToTab({ type: 'evalNote', note: n });
    if (!st || n !== current()) return;
    const set = (el, txt, cls) => { if (el) { el.textContent = txt; el.className = 'status ' + cls; } };
    set(refs.url, st.urlMatch ? '✓ matches this page' : '✗ not this page', st.urlMatch ? 'ok' : 'bad');
    (refs.counts || []).forEach((el, i) => paintCount(el, st.counts[i]));
    if (refs.textCount) {
      const c = st.textCount;
      refs.textCount.textContent = c == null ? '' : `${c} match${c === 1 ? '' : 'es'}`;
      refs.textCount.className = 'count ' + (c == null ? '' : c === 0 ? 'zero' : 'one');
    }
    set(refs.target, !st.found ? '✗ not found' : st.used === (n.target.active || 0) ? (st.visible ? '✓ found' : '⚠ found but hidden')
      : `⚠ using fallback #${st.used + 1}`, !st.found ? 'bad' : st.used === (n.target.active || 0) && st.visible ? 'ok' : 'warn');
    (refs.condRes || []).forEach((el, i) => {
      const c = st.conds[i];
      el.textContent = c.ok ? '✓' : '✗';
      el.className = 'res ' + (c.ok ? 'ok' : 'bad');
      el.title = c.count == null ? 'Invalid selector' : `${c.count} element(s) matched`;
    });
    set(refs.cond, n.conditions.length ? (st.met ? '✓ met — marker shown' : '✗ not met — marker hidden') : '', st.met ? 'ok' : 'bad');
  } catch (e) {
    const msg = '— ' + (/iframe/.test(e.message) ? e.message : 'page not reachable');
    for (const k of ['url', 'target', 'cond']) if (refs[k]) { refs[k].textContent = msg; refs[k].className = 'status hint'; }
  } finally {
    statusBusy = false;
  }
}

// ---------- boot ----------
function renderAll() {
  $('#onlyPage').checked = !!settings.onlyThisPage;
  $('#editMode').checked = !!settings.editMode;
  $('#minimap').checked = settings.minimap !== false;
  renderMaster();
  renderSelect();
  renderEditor();
}
async function onTabChange() {
  if (await refreshTab()) {
    if (pendingPick) endPickUi();
    renderSelect();
    refreshStatus();
  }
}
chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tab.id && (info.url || info.status === 'complete')) onTabChange(); });
chrome.windows.onFocusChanged.addListener(onTabChange);
chrome.storage.session.onChanged.addListener((ch) => { if (ch.pendingSelect?.newValue) select(ch.pendingSelect.newValue); });

(async () => {
  notes = await NX.loadNotes();
  lastSavedJson = stableJson(notes);
  settings = await NX.loadSettings();
  await refreshTab();
  const { pendingSelect } = await chrome.storage.session.get('pendingSelect');
  selectedId = pendingSelect && notes.some((n) => n.id === pendingSelect) ? pendingSelect : settings.selectedId || null;
  if (!current()) selectedId = null;
  chrome.storage.session.remove('pendingSelect');
  renderAll();
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 1200);
})();

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
    lastSavedJson = JSON.stringify(notes);
    chrome.storage.local.set({ [NX.STORAGE_KEY]: notes });
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 250);
}
function saveSettings() { chrome.storage.local.set({ [NX.SETTINGS_KEY]: settings }); }
const current = () => notes.find((n) => n.id === selectedId) || null;
function touch(n) { n.updatedAt = Date.now(); save(); renderSelect(); }

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch[NX.STORAGE_KEY]) return;
  const json = JSON.stringify(ch[NX.STORAGE_KEY].newValue || []);
  if (json === lastSavedJson) return; // our own write
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
async function sendToTab(msg) {
  if (tab.id == null) throw new Error('No active tab');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Content script not there yet (tab opened before the extension was loaded) -> inject it.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] });
    } catch (e) {
      throw new Error('Cannot run on this page (' + (e.message || e) + ')');
    }
    return await chrome.tabs.sendMessage(tab.id, msg);
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
    await sendToTab({ type: 'startPick', purpose });
    pendingPick = purpose;
    $('#bannerText').textContent = label || 'Click an element on the page…';
    $('#banner').hidden = false;
  } catch (e) { showMsg(e.message); }
}
function endPickUi() { pendingPick = null; $('#banner').hidden = true; }
$('#bannerCancel').onclick = () => { sendToTab({ type: 'cancelPick' }).catch(() => {}); endPickUi(); };

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'editNote') { select(msg.id); return; }
  if (msg.type !== 'picked' || msg.purpose !== pendingPick) return;
  if (sender.tab && sender.tab.id !== tab.id) return;
  endPickUi();
  if (msg.cancelled) return;
  onPicked(msg.purpose, msg.info);
});

function selectorsFromInfo(info) {
  return info.selectors.map(({ type, value, label }) => ({ type, value, label }));
}
function onPicked(purpose, info) {
  if (!info.selectors.length) return showMsg('Could not build a selector for that element.');
  if (purpose === 'new') {
    const n = NX.newNote(tab.url);
    n.title = (info.text || info.summary).slice(0, 40) || 'New note';
    n.target.selectors = selectorsFromInfo(info);
    notes.push(n);
    save(true);
    select(n.id);
    return;
  }
  const n = current();
  if (!n) return;
  if (purpose === 'target') {
    n.target.selectors = selectorsFromInfo(info);
    n.target.active = 0;
  } else if (purpose.startsWith('cond:')) {
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

function select(id) {
  selectedId = id && notes.some((n) => n.id === id) ? id : null;
  settings.selectedId = selectedId;
  saveSettings();
  renderSelect();
  renderEditor();
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
        .map(([label, f]) => h('button', { class: 'link', onclick: () => { n.urlPattern = f(); refs.urlInput.value = n.urlPattern; touch(n); refreshStatus(); } }, label))));

  // --- element
  refs.target = h('span', { class: 'status' });
  refs.counts = [];
  const selRows = n.target.selectors.map((s, i) => {
    const cnt = h('span', { class: 'count' }, '…');
    refs.counts.push(cnt);
    return h('div', { class: 'sel-row', title: s.label || '' },
      h('input', { type: 'radio', name: 'activeSel', checked: (n.target.active || 0) === i, title: 'Use this selector first',
        onchange: () => { n.target.active = i; touch(n); } }),
      h('select', { onchange: (e) => { s.type = e.target.value; touch(n); } },
        h('option', { value: 'css', selected: s.type !== 'xpath' }, 'CSS'),
        h('option', { value: 'xpath', selected: s.type === 'xpath' }, 'XPath')),
      h('input', { type: 'text', value: s.value, placeholder: s.label || 'selector', title: s.label || '',
        oninput: (e) => { s.value = e.target.value; touch(n); },
        onfocus: () => sendToTab({ type: 'highlight', sel: s }).catch(() => {}) }),
      h('span', { style: 'display:flex;align-items:center;gap:2px' }, cnt,
        h('button', { class: 'link icon', title: 'Remove', onclick: () => {
          n.target.selectors.splice(i, 1);
          if (n.target.active >= n.target.selectors.length) n.target.active = 0;
          rerender();
        } }, '✕')));
  });
  const refine = async (dir) => {
    try {
      const r = await sendToTab({ type: 'refine', dir });
      if (r.error) return showMsg(r.error);
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
    h('div', { class: 'hint' }, 'The selected radio is tried first; the others are fallbacks. Numbers = matches on the current page.'));

  // --- marker
  const m = n.marker;
  const marker = h('section', {},
    h('h3', {}, 'Marker'),
    h('div', { class: 'field' },
      seg([['dot', '● Dot'], ['tooltip', '💬 Tooltip']], m.kind, (v) => { m.kind = v; if (v === 'tooltip' && n.anchor.mode === 'edge') n.anchor.mode = 'outside'; rerender(); }),
      h('input', { type: 'color', value: m.color, title: 'Background', oninput: (e) => { m.color = e.target.value; touch(n); } }),
      h('input', { type: 'color', value: m.textColor, title: 'Text color', oninput: (e) => { m.textColor = e.target.value; touch(n); } }),
      m.kind === 'dot' ? h('label', { class: 'small', title: 'Size in px' }, 'Size',
        input(n, [m, 'size'], { type: 'number', min: 6, max: 60, style: 'width:52px' })) : null),
    h('div', { class: 'field' },
      input(n, [m, 'label'], { placeholder: m.kind === 'dot' ? 'Label (optional): 3, !, 🔥' : 'Text, number or emoji (empty = title)' })),
    h('div', { class: 'pos' },
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
        h('button', { title: 'Pick element', onclick: () => startPick('cond:' + c.id, 'Click the element this condition checks…') }, '⌖')) : null,
      chk.needsValue || chk.optionalSel ? h('div', { class: 'field' },
        input(n, [c, 'value'], { placeholder: chk.optionalSel ? 'URL (used when no element is given)' : c.check === 'attrEquals' ? 'aria-selected=true' : 'value' })) : null);
  });
  const conds = h('section', {},
    h('h3', {}, 'Conditions', refs.cond),
    n.conditions.length > 1 ? h('div', { class: 'field small' }, 'Show when',
      seg([['all', 'all'], ['any', 'any']], n.conditionMode, (v) => { n.conditionMode = v; rerender(); }), 'are true') : null,
    condRows.length ? condRows : h('p', { class: 'hint' }, 'No conditions — the marker is always shown when the element exists.'),
    h('button', { onclick: () => { n.conditions.push(NX.newCondition()); rerender(); } }, '+ Add condition'));

  ed.replaceChildren(head, page, element, marker, text, conds);
  refreshStatus();
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
    (refs.counts || []).forEach((el, i) => {
      const c = st.counts[i];
      el.textContent = c == null ? 'error' : c === 1 ? '1 ✓' : String(c);
      el.className = 'count ' + (c == null ? 'err' : c === 0 ? 'zero' : c === 1 ? 'one' : 'many');
      el.title = c == null ? 'Invalid selector' : c > 1 ? 'Matches several elements; the first one is used' : '';
    });
    set(refs.target, !st.found ? '✗ not found' : st.used === (n.target.active || 0) ? (st.visible ? '✓ found' : '⚠ found but hidden')
      : `⚠ using fallback #${st.used + 1}`, !st.found ? 'bad' : st.used === (n.target.active || 0) && st.visible ? 'ok' : 'warn');
    (refs.condRes || []).forEach((el, i) => {
      const c = st.conds[i];
      el.textContent = c.ok ? '✓' : '✗';
      el.className = 'res ' + (c.ok ? 'ok' : 'bad');
      el.title = c.count == null ? 'Invalid selector' : `${c.count} element(s) matched`;
    });
    set(refs.cond, n.conditions.length ? (st.met ? '✓ met — marker shown' : '✗ not met — marker hidden') : '', st.met ? 'ok' : 'bad');
  } catch {
    const msg = '— page not reachable';
    for (const k of ['url', 'target', 'cond']) if (refs[k]) { refs[k].textContent = msg; refs[k].className = 'status hint'; }
  } finally {
    statusBusy = false;
  }
}

// ---------- boot ----------
function renderAll() {
  $('#onlyPage').checked = !!settings.onlyThisPage;
  $('#editMode').checked = !!settings.editMode;
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
  lastSavedJson = JSON.stringify(notes);
  settings = await NX.loadSettings();
  await refreshTab();
  const { pendingSelect } = await chrome.storage.session.get('pendingSelect');
  selectedId = pendingSelect && notes.some((n) => n.id === pendingSelect) ? pendingSelect : settings.selectedId || null;
  if (!current()) selectedId = null;
  chrome.storage.session.remove('pendingSelect');
  renderAll();
  setInterval(() => { if (!document.hidden) refreshStatus(); }, 1200);
})();

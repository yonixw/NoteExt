// Shared helpers, loaded by both the content script and the side panel.
// Everything hangs off one global so the page's own scripts are never touched
// (content scripts run in an isolated world anyway).
var NX = (globalThis.NX = globalThis.NX || {});

NX.STORAGE_KEY = 'notes';
NX.SETTINGS_KEY = 'settings';

NX.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// "https://site.com/path*" -> RegExp. Only '*' is special.
NX.globToRegex = (glob, flags = 's') =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', flags);

// Equality where '*' in the pattern means "anything": abc* starts with, *abc ends with, *abc* contains.
NX.wildEq = (pattern, s) =>
  pattern.includes('*') ? NX.globToRegex(pattern).test(s) : pattern === s;

NX.urlMatches = (pattern, url) => {
  if (!pattern) return false;
  try { return NX.globToRegex(pattern.trim()).test(url); } catch { return false; }
};

NX.defaultUrlPattern = (url) => {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? url : u.origin + u.pathname + '*'; // about:blank, about:srcdoc, data: ...
  } catch { return url || '*'; }
};

// Condition checks. needsSel: requires an element selector. needsValue: uses the value field.
NX.CHECKS = [
  { id: 'exists', label: 'element exists', needsSel: true },
  { id: 'notExists', label: 'element does not exist', needsSel: true },
  { id: 'visible', label: 'element is visible', needsSel: true },
  { id: 'hidden', label: 'element is hidden / missing', needsSel: true },
  { id: 'textEquals', label: 'text equals (* wildcard)', needsSel: true, needsValue: true },
  { id: 'textContains', label: 'text contains', needsSel: true, needsValue: true },
  { id: 'textMatches', label: 'text matches regex', needsSel: true, needsValue: true },
  { id: 'valueEquals', label: 'value / selected option equals (* wildcard)', needsSel: true, needsValue: true },
  { id: 'valueContains', label: 'value / selected option contains', needsSel: true, needsValue: true },
  { id: 'checked', label: 'is checked', needsSel: true },
  { id: 'unchecked', label: 'is not checked', needsSel: true },
  { id: 'hasClass', label: 'has class (* wildcard)', needsSel: true, needsValue: true },
  { id: 'notHasClass', label: 'does not have class (* wildcard)', needsSel: true, needsValue: true },
  { id: 'attrEquals', label: 'attribute equals (name=value, * wildcard)', needsSel: true, needsValue: true },
  { id: 'linkVisited', label: 'link was visited (href or URL in value)', needsSel: false, needsValue: false, optionalSel: true },
  { id: 'linkNotVisited', label: 'link was NOT visited', needsSel: false, needsValue: false, optionalSel: true },
  { id: 'urlContains', label: 'page URL contains (* wildcard)', needsSel: false, needsValue: true },
  { id: 'urlMatches', label: 'page URL matches regex', needsSel: false, needsValue: true },
];
NX.checkById = (id) => NX.CHECKS.find((c) => c.id === id) || NX.CHECKS[0];

NX.newNote = (url) => ({
  id: NX.uid(),
  title: 'New note',
  urlPattern: NX.defaultUrlPattern(url),
  frame: '', // '' = top page, otherwise URL pattern of the iframe the element lives in
  enabled: true,
  target: { selectors: [], active: 0 },
  anchor: { point: 'top-right', mode: 'edge', dx: 0, dy: 0 },
  // kind: 'dot' | 'tooltip' | 'highlight' (recolors the element; deep = children too;
  // text = only text matching this pattern inside the element, allMatches = every match vs first)
  marker: { kind: 'dot', label: '', color: '#e53935', textColor: '#ffffff', size: 14, deep: true, text: '', allMatches: false },
  text: '',
  conditionMode: 'all',
  conditions: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// [background, text, name]
NX.COLOR_PRESETS = [
  ['#ffeb3b', '#000000', 'Classic yellow'],
  ['#b9f6ca', '#000000', 'Green'],
  ['#ff80ab', '#000000', 'Pink'],
  ['#ffcc80', '#000000', 'Orange'],
  ['#80d8ff', '#000000', 'Blue'],
  ['#e53935', '#ffffff', 'Red'],
  ['#212121', '#ffeb3b', 'Dark'],
];

NX.newCondition = () => ({ id: NX.uid(), check: 'exists', sel: { type: 'css', value: '' }, value: '' });

// Fill missing fields (for imported / older data).
NX.normalize = (n) => {
  const d = NX.newNote('');
  const out = Object.assign({}, d, n);
  out.target = Object.assign({}, d.target, n.target);
  out.anchor = Object.assign({}, d.anchor, n.anchor);
  out.marker = Object.assign({}, d.marker, n.marker);
  out.conditions = (n.conditions || []).map((c) => Object.assign(NX.newCondition(), c));
  if (!out.id) out.id = NX.uid();
  return out;
};

NX.loadNotes = async () => {
  const r = await chrome.storage.local.get(NX.STORAGE_KEY);
  return (r[NX.STORAGE_KEY] || []).map(NX.normalize);
};
NX.loadSettings = async () => {
  const r = await chrome.storage.local.get(NX.SETTINGS_KEY);
  return Object.assign({ allEnabled: true, editMode: false, onlyThisPage: true, minimap: true }, r[NX.SETTINGS_KEY]);
};

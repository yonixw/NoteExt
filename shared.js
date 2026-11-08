// Shared helpers, loaded by both the content script and the side panel.
// Everything hangs off one global so the page's own scripts are never touched
// (content scripts run in an isolated world anyway).
var NX = (globalThis.NX = globalThis.NX || {});

NX.STORAGE_KEY = 'notes';
NX.SETTINGS_KEY = 'settings';

NX.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// "https://site.com/path*" -> RegExp. Only '*' is special.
NX.globToRegex = (glob) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

NX.urlMatches = (pattern, url) => {
  if (!pattern) return false;
  try { return NX.globToRegex(pattern.trim()).test(url); } catch { return false; }
};

NX.defaultUrlPattern = (url) => {
  try { const u = new URL(url); return u.origin + u.pathname + '*'; } catch { return url || '*'; }
};

// Condition checks. needsSel: requires an element selector. needsValue: uses the value field.
NX.CHECKS = [
  { id: 'exists', label: 'element exists', needsSel: true },
  { id: 'notExists', label: 'element does not exist', needsSel: true },
  { id: 'visible', label: 'element is visible', needsSel: true },
  { id: 'hidden', label: 'element is hidden / missing', needsSel: true },
  { id: 'textEquals', label: 'text equals', needsSel: true, needsValue: true },
  { id: 'textContains', label: 'text contains', needsSel: true, needsValue: true },
  { id: 'textMatches', label: 'text matches regex', needsSel: true, needsValue: true },
  { id: 'valueEquals', label: 'value / selected option equals', needsSel: true, needsValue: true },
  { id: 'valueContains', label: 'value / selected option contains', needsSel: true, needsValue: true },
  { id: 'checked', label: 'is checked', needsSel: true },
  { id: 'unchecked', label: 'is not checked', needsSel: true },
  { id: 'hasClass', label: 'has class', needsSel: true, needsValue: true },
  { id: 'notHasClass', label: 'does not have class', needsSel: true, needsValue: true },
  { id: 'attrEquals', label: 'attribute equals (name=value)', needsSel: true, needsValue: true },
  { id: 'linkVisited', label: 'link was visited (href or URL in value)', needsSel: false, needsValue: false, optionalSel: true },
  { id: 'linkNotVisited', label: 'link was NOT visited', needsSel: false, needsValue: false, optionalSel: true },
  { id: 'urlContains', label: 'page URL contains', needsSel: false, needsValue: true },
  { id: 'urlMatches', label: 'page URL matches regex', needsSel: false, needsValue: true },
];
NX.checkById = (id) => NX.CHECKS.find((c) => c.id === id) || NX.CHECKS[0];

NX.newNote = (url) => ({
  id: NX.uid(),
  title: 'New note',
  urlPattern: NX.defaultUrlPattern(url),
  enabled: true,
  target: { selectors: [], active: 0 },
  anchor: { point: 'top-right', mode: 'edge', dx: 0, dy: 0 },
  marker: { kind: 'dot', label: '', color: '#e53935', textColor: '#ffffff', size: 14 },
  text: '',
  conditionMode: 'all',
  conditions: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

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
  return Object.assign({ editMode: false, onlyThisPage: true }, r[NX.SETTINGS_KEY]);
};

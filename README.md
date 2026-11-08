# NoteExt

Pin notes onto elements of any website: a dot (inbox-badge style) or a tooltip, with free text,
conditions, and a sidebar editor. No build step and no libraries: copy the folder and load it.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder.
4. Click the extension's toolbar icon to open the sidebar. Pin it to the toolbar if you want it handy.

Pages that were open before you loaded the extension get the script injected the first time you use
the sidebar on them. You can also just reload those pages.

## Using it

- **+ New**: click an element on the page. While picking:
  - **Click** or **Enter** selects the element.
  - **↑ / ↓** or **Alt+mouse wheel** moves to the parent or child element. The keys only work once the page has focus.
  - **Esc** cancels.
- **Element**: you get several selectors for the picked element (id, attribute, classes, short CSS
  path, text XPath, attribute XPath, full CSS path, absolute XPath). The number next to each one is how
  many elements it matches on the current page. The selected radio is tried first. If it matches
  nothing, the others are tried in order as fallbacks. You can edit any selector, add your own, or
  use **↑ Parent** / **↓ Child** to adjust the selection afterwards.
- **✱ Widen**: when a selector is "almost right" (ids or links with changing numbers), click ✱
  next to it. It lists the selector's values (id, classes, attributes, text). Put `*` where the
  value changes: `abc*` = starts with, `*abc` = ends with, `*abc*` = contains, `a*b` = both ends.
  It converts to CSS (`[id^="user-"]`) or XPath (`starts-with(@id, "user-")`), shows the match
  count live, and lets you **Replace** the selector or **Add** the result as a new one. The same
  button sits next to condition selectors. There's also a **Selector cheat sheet** under the list.
- **Marker**: Dot or Tooltip, with label (number, emoji or text), colors and dot size. The position is
  a 3×3 anchor grid plus Outside / On edge / Inside, and an X/Y offset in px.
- **Note**: free text. Click a marker on the page to read it. **Edit in sidebar** jumps to that note.
- **Conditions** (all or any): element exists/visible, text equals/contains/regex, input or select
  value, checked or `aria-selected`, has class, attribute equals (`aria-selected=true` is useful for
  CSS tabs), link visited (uses browser history), page URL contains/regex. Each one shows ✓/✗ live.
  The "equals" checks, class checks and URL contains accept `*` wildcards (`Total*`, `*error*`,
  `aria-label=Close*`). Use the regex check for anything more complex.
- **Page**: the URL pattern where the note applies, with `*` as a wildcard. Shortcuts: this page,
  exact URL, whole site, everywhere.
- **Edit mode** shows every marker on the page, even when its conditions aren't met. Those markers
  are dimmed and dashed.
- **This page only** filters the dropdown to notes that match the current tab.
- **Export / Import**: JSON. Import asks whether to **Merge** (same id replaces the existing note) or
  **Replace all**.

Every change saves automatically to `chrome.storage.local`.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Opens the side panel; answers "was this URL visited" (history API) |
| `shared.js` | Data model, defaults, URL matching, condition list (used by page + panel) |
| `content.js` | Picker, selector generation, condition evaluation, marker rendering (Shadow DOM) |
| `sidepanel.html/.css/.js` | Sidebar UI |

## Known limits (for now)

- Top frame only. Elements inside iframes can't be targeted.
- No "custom JavaScript" selectors or conditions. MV3 blocks `eval` in extensions, so CSS and XPath
  cover element lookup.
- "Link visited" checks the browser history for the link's `href` (exact URL match).

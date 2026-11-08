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
- **Marker**: Dot, Tooltip or Highlight.
  - **Dot / Tooltip**: label (number, emoji or text), colors and dot size. The position is a 3×3
    anchor grid plus Outside / On edge / Inside, and an X/Y offset in px.
  - **Highlight**: recolors the element itself, like a highlighter pen. "Include children" also
    recolors everything inside it. Its note opens from the sidebar, since the element keeps its own
    clicks.
  - **Text pattern** (Highlight only): marks just the matching text inside the element instead of
    the whole element. `*` at the start or end of the pattern means "the rest of that word"
    (`Total: *` marks "Total: $42.00", `Order #*` marks "Order #1234"). `*` in the middle means
    anything. Spaces match any whitespace, and matching ignores case. **All matches** marks every
    match; unchecked marks only the first. The sidebar shows the live match count. Drawn with the
    browser's CSS Custom Highlight API, so the page's HTML is not changed.
  - **Color presets**: one-click background/text pairs (classic yellow/black, green, pink and more),
    for every kind.
- **Iframes**: the script runs in every frame. When you pick inside an iframe, the note remembers
  that iframe's URL ("In iframe:" under Page). It shows when the top page matches the Page pattern
  and that iframe is on it. A condition's element must be in the same frame as the note's element.
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
- **Minimap** (header checkbox, on by default): a thin see-through strip at the right edge of the
  page, just left of the scrollbar.
  - It shows the visible part of the page as a yellow box with a red border, and each marker as a
    tick in its color. Unmet markers show faded in edit mode.
  - Inner scrolling panels, common in web apps, get their own strip inside the panel. Each iframe
    gets its own as well.
  - It ignores the mouse, so the scrollbar and the page work as usual. It's hidden when the master
    switch is off or the page doesn't scroll.
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
| `minimap.js` | Scroll minimap strips; fed by `content.js` after every layout |
| `sidepanel.html/.css/.js` | Sidebar UI |

## Known limits (for now)

- Iframes are matched by URL. Two iframes with the same URL on one page share notes, and only the
  first is used for the sidebar's live status.
- Shadow DOM inside page components (web components) isn't searched by selectors.
- No "custom JavaScript" selectors or conditions. MV3 blocks `eval` in extensions, so CSS and XPath
  cover element lookup.
- "Link visited" checks the browser history for the link's `href` (exact URL match).

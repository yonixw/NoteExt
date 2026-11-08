// Service worker: opens the side panel from the toolbar icon, answers "was this URL visited"
// (content scripts cannot use chrome.history), and opens the panel when a marker's Edit is clicked.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'visited') {
    const urls = msg.urls || [];
    Promise.all(
      urls.map((url) =>
        chrome.history.getVisits({ url }).then((v) => [url, v.length > 0]).catch(() => [url, false])
      )
    ).then((pairs) => sendResponse(Object.fromEntries(pairs)));
    return true;
  }
  if (msg.type === 'tabUrl') {
    // Iframes can't read the top page's URL (cross-origin), so they ask here.
    sendResponse(sender.tab ? sender.tab.url : '');
    return false;
  }
  if (msg.type === 'editNote') {
    // Remember which note to show, so a freshly opened panel can pick it up.
    chrome.storage.session.set({ pendingSelect: msg.id });
    if (sender.tab) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    return false;
  }
});

import { fetchImage, isTrustedSender } from './imageFetch';

async function toggle(tab: chrome.tabs.Tab | undefined): Promise<void> {
  const id = tab?.id;
  if (id === undefined) return;
  try {
    await chrome.tabs.sendMessage(id, { type: 'toggle' });
  } catch {
    // Content script is not injected in this tab yet.
    await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(id, { type: 'toggle' });
  }
}

chrome.action.onClicked.addListener((tab) => void toggle(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-snapshot') void toggle(tab);
});

chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }, sender, sendResponse) => {
  if (!isTrustedSender(sender, chrome.runtime.id)) return false;
  if (msg?.type === 'fetch-image' && typeof msg.url === 'string') {
    void fetchImage(msg.url).then(sendResponse);
    return true;
  }
  if (msg?.type === 'capture-tab') {
    // What the user sees, for images the proxy cannot download. activeTab covers it: the user invoked the picker here.
    chrome.tabs.captureVisibleTab(sender.tab!.windowId, { format: 'png' }).then(
      (dataUrl) => sendResponse({ dataUrl }),
      (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }
  return false;
});

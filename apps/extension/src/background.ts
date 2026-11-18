const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

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

async function fetchImage(url: string): Promise<{ dataUrl: string } | { error: string }> {
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return { error: 'image too large' };
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const type = res.headers.get('content-type') ?? 'application/octet-stream';
    return { dataUrl: `data:${type};base64,${btoa(bin)}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((msg: { type?: string; url?: string }, _sender, sendResponse) => {
  if (msg?.type !== 'fetch-image' || typeof msg.url !== 'string') return false;
  void fetchImage(msg.url).then(sendResponse);
  return true;
});

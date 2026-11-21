import { captureAndCopy } from './capture';
import { browserEnv, sharedImageFetches } from './capture/env';
import { preparePage } from './capture/prepare';
import { trackProgress } from './capture/progress';
import { captureSubtree } from './capture/exact';
import { PassRecorder } from './capture/passRecorder';
import { CaptureStatus, ScrollCover } from './picker/overlay';
import { Picker } from './picker/picker';

interface Flagged {
  __markupSnapshot?: Picker;
}

const w = window as unknown as Flagged;
const pasteKey = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘V' : 'Ctrl V';

/** Share of the progress bar the loading phase takes: most of it for a whole page, a sliver for elements. */
const LOAD_SHARE = { page: 0.55, elements: 0.12 };

const nextFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** A screenshot of what the tab shows right now, with Markup's own chrome hidden; null when refused. */
async function tabShot(): Promise<string | null> {
  const hosts = [...document.querySelectorAll<HTMLElement>('[data-markup-snapshot]')];
  const previous = hosts.map((h) => h.style.visibility);
  hosts.forEach((h) => (h.style.visibility = 'hidden'));
  try {
    await nextFrames();
    const res = (await chrome.runtime.sendMessage({ type: 'capture-tab' })) as { dataUrl?: string } | undefined;
    return res?.dataUrl ?? null;
  } catch {
    return null;
  } finally {
    hosts.forEach((h, i) => (h.style.visibility = previous[i] ?? ''));
  }
}

if (!w.__markupSnapshot) {
  let status: CaptureStatus | null = null;
  let abort: AbortController | null = null;
  const picker: Picker = new Picker(document, (targets, mode = 'exact') => {
    status?.dismiss();
    abort?.abort();
    const current = new CaptureStatus(document);
    const cancel = new AbortController();
    status = current;
    abort = cancel;
    const page = targets === 'page';
    const roots = page ? [document.documentElement] : targets;
    const what = page ? 'page' : targets.length > 1 ? `${targets.length} elements` : 'selection';
    const share = page ? LOAD_SHARE.page : LOAD_SHARE.elements;
    current.start(page ? 'Loading the whole page…' : `Capturing ${what}…`);

    if (page) picker.setChromeVisible(false);
    const cover = new ScrollCover(document);
    // The whole-page pass records canvas frames, motion and in-view-only subtrees (exact mode can splice those
    // back); a selection only records its shaders and videos as clips.
    const plain = sharedImageFetches(browserEnv());
    const recorder: PassRecorder = new PassRecorder(document, page && mode === 'exact' ? (el: Element): Promise<string> => captureSubtree(el, recorder.withRecording(plain)) : undefined);
    const prepare = async () => {
      // A whole page is scrolled through under a still picture of the tab, so the reader sees nothing
      // move; a selection only waits on its images and fonts. Either way nothing is half-loaded.
      try {
        await preparePage(document, roots, {
          scroll: page,
          signal: cancel.signal,
          onProgress: (p) => current.progress(p * share),
          recorder,
          hideScrolling: async () => {
            const shot = await tabShot();
            return !!shot && !cancel.signal.aborted && (await cover.show(shot));
          },
          afterScrolling: () => cover.remove(),
        });
      } finally {
        cover.remove();
      }
      if (cancel.signal.aborted) throw new Error('Capture cancelled');
      current.setMessage(`Capturing ${what}…`);
    };
    const tracked = trackProgress(plain, targets, (p) => current.progress(share + p * (1 - share)));
    const env = recorder.withRecording(tracked);
    // Called inside the Enter/click handler, so the clipboard write starts within the user gesture;
    // loading and reading the page happen inside the clipboard's pending promise.
    captureAndCopy(targets, mode, env, { prepare }).then(
      () => {
        // Like Paper: one snapshot per activation, then paste in the app.
        picker.stop();
        current.succeed(`Copied. Paste into Markup with ${pasteKey}`);
      },
      (err: unknown) => {
        current.fail(err instanceof Error ? err.message : String(err));
        picker.idle();
      },
    );
  });
  // Escape (or toggling the picker off) while a page is still loading cancels the capture.
  picker.onStop = () => abort?.abort();
  w.__markupSnapshot = picker;
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type !== 'toggle') return;
    if (picker.active) picker.stop();
    else picker.start();
  });
}

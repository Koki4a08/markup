import { captureAndCopy } from './capture';
import { flashToast } from './picker/overlay';
import { Picker } from './picker/picker';

interface Flagged {
  __markupSnapshot?: Picker;
}

const w = window as unknown as Flagged;

if (!w.__markupSnapshot) {
  const picker: Picker = new Picker(document, (targets, mode = 'exact') => {
    // Called inside the Enter/click handler, so the clipboard write starts within the user gesture.
    captureAndCopy(targets, mode).then(
      () => {
        // Like Paper: one snapshot per activation, then ⌘V in the app.
        picker.stop();
        flashToast(document, 'Copied — paste into Markup');
      },
      (err: unknown) => picker.toast(err instanceof Error ? err.message : String(err), true),
    );
  });
  w.__markupSnapshot = picker;
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type !== 'toggle') return;
    if (picker.active) picker.stop();
    else picker.start();
  });
}

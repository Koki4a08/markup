import { captureAndCopy } from './capture';
import { Picker } from './picker/picker';

interface Flagged {
  __markupSnapshot?: Picker;
}

const w = window as unknown as Flagged;

if (!w.__markupSnapshot) {
  const picker: Picker = new Picker(document, (targets) => {
    captureAndCopy(targets).then(
      () => picker.toast('Copied — paste into Markup'),
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

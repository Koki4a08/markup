import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './style.css';

type Release = { version: string; name: string; url: string; size: number; sha256: string | null };
type Progress = { received: number; total: number; speed: number };
type State = 'checking' | 'downloading' | 'installing' | 'done' | 'error';

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const stage = $('[data-state]');
const title = $('[data-title]');
const detail = $('[data-detail]');
const bar = $('[data-progress]');
const fill = $('[data-fill]');
const amount = $('[data-amount]');
const speed = $('[data-speed]');
const primary = $<HTMLButtonElement>('[data-action="primary"]');

const appWindow = getCurrentWindow();
$('[data-action="minimize"]').addEventListener('click', () => appWindow.minimize());
$('[data-action="close"]').addEventListener('click', () => appWindow.close());
$('[data-action="manual"]').addEventListener('click', () => invoke('open_releases'));

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

function show(state: State, heading: string, text: string) {
  stage.dataset.state = state;
  title.textContent = heading;
  detail.textContent = text;
  if (state !== 'downloading') {
    amount.textContent = '';
    speed.textContent = '';
  }
}

let onPrimary: () => void = run;
primary.addEventListener('click', () => onPrimary());

async function run() {
  try {
    show('checking', 'Finding the latest version', 'Checking GitHub for the newest Markup release.');
    const release = await invoke<Release>('latest_release');

    show('downloading', `Downloading Markup ${release.version}`, `${mb(release.size)} from GitHub releases.`);
    fill.style.width = '0%';
    const onProgress = new Channel<Progress>();
    onProgress.onmessage = ({ received, total, speed: rate }) => {
      const percent = total ? Math.min(100, (received / total) * 100) : 0;
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(percent)));
      amount.textContent = `${mb(received)} of ${mb(total)}`;
      speed.textContent = rate ? `${mb(rate)}/s` : '';
    };
    const path = await invoke<string>('download', { release, onProgress });

    show('installing', 'Installing Markup', 'Copying files and adding Markup to the Start menu.');
    await invoke('install', { path });

    show('done', 'Markup is ready', `Version ${release.version} is installed. Opening it now.`);
    primary.textContent = 'Open Markup';
    onPrimary = openApp;
    await openApp();
  } catch (error) {
    show('error', 'Setup stopped', String(error));
    primary.textContent = 'Try again';
    onPrimary = run;
  }
}

async function openApp() {
  try {
    await invoke('launch');
    // Leave the success state up for a moment so the change is visible.
    setTimeout(() => appWindow.close(), 1400);
  } catch (error) {
    show('error', 'Markup is installed', `${String(error)} You can open it from the Start menu.`);
    primary.textContent = 'Try again';
    onPrimary = openApp;
  }
}

void run();

// The app version (apps/app/src-tauri/tauri.conf.json), baked into the CLI so `markup --version` and `markup update` know it.
import { readFileSync } from 'node:fs';

export const version = JSON.parse(readFileSync(new URL('../../apps/app/src-tauri/tauri.conf.json', import.meta.url), 'utf8')).version;

/**
 * Where the desktop app keeps its account session: a supabase-js storage whose values are
 * AES-256-GCM encrypted. The ciphertext sits in the webview's localStorage; the key sits in the OS
 * credential store (see src-tauri/src/vault.rs), so a copied profile folder or a stray backup holds
 * nothing usable. Each value is bound to its storage name, so ciphertexts cannot be swapped around.
 *
 * The credential store is only touched when there is something to protect: never at startup for
 * someone who has not signed in (on Linux that could raise an unlock prompt for nothing). If it is
 * unavailable, the session lives in memory for this run only and the user signs in again next time.
 */

/** The 32-byte key, as unpadded base64url, in the OS credential store. */
export interface KeyStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
}

/** The storage shape supabase-js accepts (`auth.storage`). */
export interface AsyncStorage {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
}

type Backing = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const VAULT_PREFIX = 'markup:vault:';
const FORMAT = 'v1';

export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();

async function importKey(raw: string): Promise<CryptoKey> {
  const bytes = fromBase64url(raw);
  if (bytes.length !== 32) throw new Error('bad key length');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function createVault(keys: KeyStore, backing: Backing, warn: (message: string) => void = console.warn): AsyncStorage {
  const memory = new Map<string, string>();
  /** Set once the credential store failed: from then on, memory only for this run. */
  let unavailable = false;
  let key: CryptoKey | null = null;
  let creating: Promise<CryptoKey> | null = null;

  const fallBack = (err: unknown) => {
    if (!unavailable) warn(`Account session kept in memory only: ${err instanceof Error ? err.message : String(err)}`);
    unavailable = true;
  };

  /** The existing key, without creating one. */
  async function existingKey(): Promise<CryptoKey | null> {
    if (key) return key;
    const raw = await keys.get();
    if (!raw) return null;
    key = await importKey(raw);
    return key;
  }

  /** The key to encrypt with, created on first use. One creation at a time, so two writes never race to different keys. */
  function keyForWriting(): Promise<CryptoKey> {
    if (key) return Promise.resolve(key);
    creating ??= (async () => {
      const found = await existingKey();
      if (found) return found;
      const raw = toBase64url(crypto.getRandomValues(new Uint8Array(32)));
      await keys.set(raw);
      key = await importKey(raw);
      return key;
    })().finally(() => {
      creating = null;
    });
    return creating;
  }

  const slot = (name: string) => VAULT_PREFIX + name;

  return {
    async getItem(name) {
      if (unavailable) return memory.get(name) ?? null;
      const stored = backing.getItem(slot(name));
      if (!stored) return null;
      let cryptoKey: CryptoKey | null;
      try {
        cryptoKey = await existingKey();
      } catch (err) {
        // Locked or missing credential store: keep the ciphertext for a later run, sign in fresh now.
        fallBack(err);
        return null;
      }
      if (!cryptoKey) {
        backing.removeItem(slot(name));
        return null;
      }
      try {
        const [format, iv, data] = stored.split('.');
        if (format !== FORMAT || !iv || !data) throw new Error('unknown format');
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64url(iv), additionalData: encoder.encode(name) },
          cryptoKey,
          fromBase64url(data),
        );
        return new TextDecoder().decode(plain);
      } catch {
        // Tampered with, or written under another key: unusable, so it goes.
        backing.removeItem(slot(name));
        return null;
      }
    },

    async setItem(name, value) {
      if (unavailable) {
        memory.set(name, value);
        return;
      }
      let cryptoKey: CryptoKey;
      try {
        cryptoKey = await keyForWriting();
      } catch (err) {
        fallBack(err);
        memory.set(name, value);
        return;
      }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) }, cryptoKey, encoder.encode(value));
      backing.setItem(slot(name), `${FORMAT}.${toBase64url(iv)}.${toBase64url(new Uint8Array(data))}`);
    },

    async removeItem(name) {
      memory.delete(name);
      backing.removeItem(slot(name));
    },
  };
}

//! The key that encrypts the saved account session.
//!
//! The session itself (access + refresh token) is stored by the frontend in the webview's storage,
//! AES-GCM encrypted (see `src/cloud/vault.ts`). Only this 32-byte key goes into the OS credential
//! store: Windows Credential Manager, the macOS Keychain or the Secret Service on Linux. The whole
//! session would not fit there anyway (Credential Manager caps a secret at 2560 bytes).
//!
//! Keychain calls can block (an unlock prompt on Linux), so they run off the main thread.

const SERVICE: &str = "org.markup.app";
const ACCOUNT: &str = "session-key";

/// base64url of 32 bytes, unpadded: the only shape the frontend writes.
fn is_key(value: &str) -> bool {
  value.len() == 43 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn entry() -> Result<keyring::Entry, String> {
  keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("credential store unavailable: {e}"))
}

async fn off_main<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// The stored key, or None when there is none yet (or it is not one we wrote).
#[tauri::command]
pub async fn vault_key_get() -> Result<Option<String>, String> {
  off_main(|| match entry()?.get_password() {
    Ok(key) if is_key(&key) => Ok(Some(key)),
    Ok(_) => Ok(None),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(format!("could not read the session key: {e}")),
  })
  .await
}

#[tauri::command]
pub async fn vault_key_set(key: String) -> Result<(), String> {
  if !is_key(&key) {
    return Err("invalid key".into());
  }
  off_main(move || entry()?.set_password(&key).map_err(|e| format!("could not save the session key: {e}"))).await
}

#[tauri::command]
pub async fn vault_key_delete() -> Result<(), String> {
  off_main(|| match entry()?.delete_credential() {
    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(format!("could not delete the session key: {e}")),
  })
  .await
}

#[cfg(test)]
mod tests {
  use super::is_key;

  #[test]
  fn accepts_only_43_char_base64url() {
    assert!(is_key(&"a".repeat(43)));
    assert!(is_key("AZaz09-_AZaz09-_AZaz09-_AZaz09-_AZaz09-_abc"));
    assert!(!is_key(&"a".repeat(42)));
    assert!(!is_key(&"a".repeat(44)));
    assert!(!is_key(&format!("{}=", "a".repeat(42))));
    assert!(!is_key(&format!("{}/", "a".repeat(42))));
  }
}

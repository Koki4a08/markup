//! Markup Setup: a small bootstrapper that finds the newest Markup release on
//! GitHub, downloads its Windows installer with live progress, runs it silently
//! and opens the app. Every error comes back as a short sentence for the UI.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;

/// Public repository whose releases carry the installers.
const REPO: &str = "Koki4a08/markup";
/// The NSIS installer Tauri produces, e.g. `Markup_0.1.0_x64-setup.exe`.
const ASSET_SUFFIX: &str = "_x64-setup.exe";
const USER_AGENT: &str = "Markup-Setup";
/// Where the NSIS installer puts the app for the current user (`$LOCALAPPDATA\<productName>`).
const APP_DIR: &str = "Markup";
const APP_EXE: &str = "markup-app.exe";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Release {
  version: String,
  name: String,
  url: String,
  size: u64,
  /// Hex SHA-256 GitHub publishes for the asset; the download must match it.
  sha256: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
  received: u64,
  total: u64,
  /// Bytes per second over the whole download so far.
  speed: u64,
}

fn client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .user_agent(USER_AGENT)
    .connect_timeout(Duration::from_secs(15))
    .read_timeout(Duration::from_secs(30))
    .build()
    .map_err(|e| format!("Could not start the network client: {e}"))
}

fn network_error(e: reqwest::Error) -> String {
  if e.is_timeout() || e.is_connect() {
    "Could not reach GitHub. Check your internet connection and try again.".into()
  } else {
    format!("The download stopped: {e}")
  }
}

/// Newest published release and its Windows installer.
#[tauri::command]
async fn latest_release() -> Result<Release, String> {
  let res = client()?
    .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
    .header("Accept", "application/vnd.github+json")
    .timeout(Duration::from_secs(20))
    .send()
    .await
    .map_err(network_error)?;
  if !res.status().is_success() {
    return Err(match res.status().as_u16() {
      404 => "No Markup release is published yet.".into(),
      403 | 429 => "GitHub is rate limiting this network. Wait a minute and try again.".into(),
      code => format!("GitHub answered with status {code}."),
    });
  }
  let json: serde_json::Value = res.json().await.map_err(|_| "GitHub sent a reply this setup could not read.".to_string())?;
  pick_installer(&json)
}

/// Finds the Windows installer in a GitHub "latest release" response.
fn pick_installer(json: &serde_json::Value) -> Result<Release, String> {
  let version = json["tag_name"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
  let asset = json["assets"]
    .as_array()
    .and_then(|assets| assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(ASSET_SUFFIX))))
    .ok_or_else(|| format!("Release {version} has no Windows installer yet."))?;
  let url = asset["browser_download_url"].as_str().unwrap_or_default();
  if !url.starts_with("https://github.com/") {
    return Err("The release points to an unexpected download address.".into());
  }
  Ok(Release {
    version,
    name: asset["name"].as_str().unwrap_or_default().to_string(),
    url: url.to_string(),
    size: asset["size"].as_u64().unwrap_or(0),
    sha256: asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_lowercase),
  })
}

/// Streams the installer into the temp folder, reporting progress about ten times a second.
#[tauri::command]
async fn download(release: Release, on_progress: Channel<Progress>) -> Result<String, String> {
  if !release.url.starts_with("https://github.com/") || release.name.contains(['/', '\\']) {
    return Err("The release points to an unexpected download address.".into());
  }
  let res = client()?.get(&release.url).send().await.map_err(network_error)?;
  if !res.status().is_success() {
    return Err(format!("The installer download failed with status {}.", res.status().as_u16()));
  }
  let total = res.content_length().unwrap_or(release.size);
  let path: PathBuf = std::env::temp_dir().join(&release.name);
  let mut file = tokio::fs::File::create(&path).await.map_err(|e| format!("Could not write to the temp folder: {e}"))?;

  let started = Instant::now();
  let mut last_report = Instant::now() - Duration::from_secs(1);
  let mut received: u64 = 0;
  let mut hasher = Sha256::new();
  let mut stream = res.bytes_stream();
  while let Some(chunk) = stream.next().await {
    let chunk = chunk.map_err(network_error)?;
    file.write_all(&chunk).await.map_err(|e| format!("Could not save the installer: {e}"))?;
    hasher.update(&chunk);
    received += chunk.len() as u64;
    if last_report.elapsed() >= Duration::from_millis(100) || received == total {
      last_report = Instant::now();
      let secs = started.elapsed().as_secs_f64().max(0.001);
      let _ = on_progress.send(Progress { received, total, speed: (received as f64 / secs) as u64 });
    }
  }
  file.flush().await.map_err(|e| format!("Could not save the installer: {e}"))?;
  drop(file);
  if total > 0 && received != total {
    let _ = tokio::fs::remove_file(&path).await;
    return Err("The download ended early. Try again.".into());
  }
  // Never run a file that differs from what the release published.
  if let Some(expected) = &release.sha256 {
    let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if &actual != expected {
      let _ = tokio::fs::remove_file(&path).await;
      return Err("The downloaded file does not match the release checksum, so it was deleted. Try again.".into());
    }
  }
  Ok(path.to_string_lossy().into_owned())
}

/// Runs the downloaded NSIS installer silently and waits for it.
#[tauri::command]
async fn install(path: String) -> Result<(), String> {
  let status = tokio::process::Command::new(&path)
    .arg("/S")
    .status()
    .await
    .map_err(|e| format!("Could not start the installer: {e}"))?;
  let _ = tokio::fs::remove_file(&path).await;
  if status.success() {
    Ok(())
  } else {
    Err(format!("The installer stopped with code {}.", status.code().unwrap_or(-1)))
  }
}

fn installed_app() -> Option<PathBuf> {
  let base = std::env::var_os("LOCALAPPDATA")?;
  let exe = PathBuf::from(base).join(APP_DIR).join(APP_EXE);
  exe.exists().then_some(exe)
}

/// Opens the installed app, detached from this process.
#[tauri::command]
fn launch() -> Result<(), String> {
  let exe = installed_app().ok_or("Markup was installed, but its program file was not found.")?;
  std::process::Command::new(exe).spawn().map_err(|e| format!("Could not open Markup: {e}"))?;
  Ok(())
}

/// Opens the releases page in the default browser, for a manual download.
#[tauri::command]
fn open_releases() -> Result<(), String> {
  let url = format!("https://github.com/{REPO}/releases/latest");
  #[cfg(windows)]
  let result = std::process::Command::new("explorer").arg(&url).spawn();
  #[cfg(target_os = "macos")]
  let result = std::process::Command::new("open").arg(&url).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let result = std::process::Command::new("xdg-open").arg(&url).spawn();
  result.map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![latest_release, download, install, launch, open_releases])
    .run(tauri::generate_context!())
    .expect("error while running Markup Setup");
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn picks_the_nsis_installer_and_strips_the_v() {
    let release = json!({
      "tag_name": "v0.2.0",
      "assets": [
        { "name": "Markup_0.2.0_x64_en-US.msi", "browser_download_url": "https://github.com/a/b/x.msi", "size": 1 },
        { "name": "Markup_0.2.0_x64-setup.exe", "browser_download_url": "https://github.com/a/b/setup.exe", "size": 42, "digest": "sha256:ABCDEF" },
        { "name": "Markup-Setup.exe", "browser_download_url": "https://github.com/a/b/Markup-Setup.exe", "size": 3 }
      ]
    });
    let picked = pick_installer(&release).unwrap();
    assert_eq!(picked.version, "0.2.0");
    assert_eq!(picked.name, "Markup_0.2.0_x64-setup.exe");
    assert_eq!(picked.size, 42);
    assert_eq!(picked.sha256.as_deref(), Some("abcdef"));
  }

  #[test]
  fn explains_a_release_without_a_windows_installer() {
    let release = json!({ "tag_name": "v0.3.0", "assets": [{ "name": "Markup.dmg" }] });
    assert_eq!(pick_installer(&release).unwrap_err(), "Release 0.3.0 has no Windows installer yet.");
  }

  #[test]
  fn refuses_downloads_outside_github() {
    let release = json!({
      "tag_name": "v1.0.0",
      "assets": [{ "name": "Markup_1.0.0_x64-setup.exe", "browser_download_url": "https://evil.example/x.exe" }]
    });
    assert!(pick_installer(&release).is_err());
  }
}

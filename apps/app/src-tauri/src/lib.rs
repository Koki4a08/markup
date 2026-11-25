use tauri::{webview::NewWindowResponse, Manager, Runtime, Url, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::Emitter;

mod vault;

/// Label of the one editor window, as declared in tauri.conf.json.
const MAIN: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // A second launch (double-clicking the app again) focuses the running window instead of opening
  // another copy over the same local file store. Must be the first plugin registered.
  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }))
    // Size, position and maximized state come back where the user left them. Visibility is left
    // out: the window stays hidden until the UI has painted (see `show_when_ready`).
    .plugin(
      tauri_plugin_window_state::Builder::default()
        .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
        .build(),
    )
    // The frontend polls for a new release and restarts into it (see src/desktop/updater.ts).
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // markup://auth/callback brings a website sign-in back to the app (src/cloud/account.ts).
    // On Windows and Linux a second launch carries the link; single-instance hands it over here.
    .plugin(tauri_plugin_deep_link::init());

  // macOS: a menu bar of the app's own, so Cmd+W closes a tab rather than the only window.
  #[cfg(target_os = "macos")]
  let builder = builder.menu(app_menu).on_menu_event(|app, event| {
    // Custom items are handled by the frontend (it owns the tabs and files).
    let id: &str = event.id().as_ref();
    let _ = app.emit("menu", id);
  });

  builder
    .invoke_handler(tauri::generate_handler![show_system_menu, capture_window, vault::vault_key_get, vault::vault_key_set, vault::vault_key_delete])
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Installers register markup:// (from plugins.deep-link in tauri.conf.json). An AppImage is
      // never installed, and dev builds on Windows are not either, so they register at launch.
      #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(e) = app.deep_link().register_all() {
          log::warn!("could not register the markup:// link: {e}");
        }
      }
      let window = create_main_window(app.handle())?;
      native_webview_settings(&window);
      show_when_ready(window);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

/// Builds the window from its tauri.conf.json entry (declared with `create: false`) so the webview
/// can be told to behave like an app rather than a browser tab: it never navigates away from the
/// app, and never opens popup browser windows.
fn create_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
  let config = app
    .config()
    .app
    .windows
    .iter()
    .find(|w| w.label == MAIN)
    .cloned()
    .expect("tauri.conf.json declares the main window");
  let opener = app.clone();
  WebviewWindowBuilder::from_config(app, &config)?
    .on_navigation(is_app_url)
    .on_new_window(move |url, _features| {
      // Ctrl/Shift+click or target=_blank on a web link: hand it to the system browser.
      if matches!(url.scheme(), "http" | "https" | "mailto") {
        open_externally(&opener, url.as_str());
      }
      NewWindowResponse::Deny
    })
    .build()
}

/// Only the app itself may load in the window; a stray link or a dropped file never replaces it.
fn is_app_url(url: &Url) -> bool {
  match url.scheme() {
    "tauri" | "about" | "blob" | "data" => true,
    "http" | "https" => match url.host_str() {
      Some("tauri.localhost") => true,
      // The Vite dev server (`devUrl`).
      Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
      _ => false,
    },
    _ => false,
  }
}

#[allow(deprecated)]
fn open_externally<R: Runtime>(app: &tauri::AppHandle<R>, url: &str) {
  use tauri_plugin_shell::ShellExt;
  if let Err(e) = app.shell().open(url, None) {
    log::warn!("could not open {url}: {e}");
  }
}

/// WebView2 ships browser behaviour an app must not have: F5/Ctrl+R reload, Ctrl+P print, Ctrl+F
/// find bar, F7 caret browsing, Alt+Left back, Ctrl+Shift+I devtools in release, and so on.
/// Editing keys (copy, paste, undo in text fields) are not browser accelerators and keep working.
#[cfg(windows)]
fn native_webview_settings<R: Runtime>(window: &WebviewWindow<R>) {
  use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2Settings6};
  use windows_core::Interface;
  let devtools = cfg!(debug_assertions);
  let _ = window.with_webview(move |webview| unsafe {
    let Ok(core) = webview.controller().CoreWebView2() else { return };
    let Ok(settings) = core.Settings() else { return };
    let _ = settings.SetIsStatusBarEnabled(false);
    // Keep the accelerators in dev builds so the inspector and reload stay one key away.
    if !devtools {
      if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
      }
    }
    if let Ok(settings6) = settings.cast::<ICoreWebView2Settings6>() {
      let _ = settings6.SetIsSwipeNavigationEnabled(false);
    }
  });
}

#[cfg(not(windows))]
fn native_webview_settings<R: Runtime>(_window: &WebviewWindow<R>) {}

/// The window is created hidden so nothing paints before the UI does (no blank frame, no boot text).
/// The frontend shows it after its first paint; this is the fallback if that never arrives.
fn show_when_ready<R: Runtime>(window: WebviewWindow<R>) {
  std::thread::spawn(move || {
    std::thread::sleep(std::time::Duration::from_secs(4));
    if !window.is_visible().unwrap_or(true) {
      let _ = window.show();
      let _ = window.set_focus();
    }
  });
}

/// macOS menu bar: the standard app, Edit, View and Window menus, with a File menu whose Cmd+N and
/// Cmd+W act on files and tabs. Tauri's default menu binds Cmd+W to Close Window, which would quit
/// a one-window app; that item is left out here.
#[cfg(target_os = "macos")]
fn app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
  use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
  let name = app.package_info().name.clone();
  let about = AboutMetadata {
    name: Some(name.clone()),
    version: Some(app.package_info().version.to_string()),
    ..Default::default()
  };
  let app_submenu = Submenu::with_items(
    app,
    name,
    true,
    &[
      &PredefinedMenuItem::about(app, None, Some(about))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::services(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::hide_others(app, None)?,
      &PredefinedMenuItem::show_all(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?;
  let file = Submenu::with_items(
    app,
    "File",
    true,
    &[
      &MenuItem::with_id(app, "new-file", "New File", true, Some("CmdOrCtrl+N"))?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
    ],
  )?;
  let edit = Submenu::with_items(
    app,
    "Edit",
    true,
    &[
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
    ],
  )?;
  let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
  let window = Submenu::with_items(
    app,
    "Window",
    true,
    &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
  )?;
  Menu::with_items(app, &[&app_submenu, &file, &edit, &view, &window])
}

/// The Windows system menu (Restore, Move, Size, Minimize, Maximize, Close) for the custom title
/// bar: right-click on the bar or Alt+Space, as on any native caption. `at_cursor` is false for the
/// keyboard, which opens it at the window's top-left corner.
#[tauri::command]
fn show_system_menu(window: tauri::WebviewWindow, at_cursor: bool) {
  #[cfg(windows)]
  unsafe {
    use windows::Win32::Foundation::{LPARAM, POINT, RECT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = windows::Win32::Foundation::HWND(hwnd.0 as _);
    let menu = GetSystemMenu(hwnd, false);
    if menu.is_invalid() {
      return;
    }
    let maximized = IsZoomed(hwnd).as_bool();
    let minimized = IsIconic(hwnd).as_bool();
    let state = |on: bool| if on { MF_BYCOMMAND | MF_ENABLED } else { MF_BYCOMMAND | MF_GRAYED };
    let _ = EnableMenuItem(menu, SC_RESTORE, state(maximized || minimized));
    let _ = EnableMenuItem(menu, SC_MOVE, state(!maximized));
    let _ = EnableMenuItem(menu, SC_SIZE, state(!maximized));
    let _ = EnableMenuItem(menu, SC_MINIMIZE, state(!minimized));
    let _ = EnableMenuItem(menu, SC_MAXIMIZE, state(!maximized));
    let _ = EnableMenuItem(menu, SC_CLOSE, state(true));
    let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);
    let mut at = POINT::default();
    if at_cursor {
      let _ = GetCursorPos(&mut at);
    } else {
      let mut rect = RECT::default();
      let _ = GetWindowRect(hwnd, &mut rect);
      at = POINT { x: rect.left + 8, y: rect.top + 38 };
    }
    let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, at.x, at.y, None, hwnd, None);
    if cmd.0 != 0 {
      let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(cmd.0 as usize), LPARAM(0));
    }
  }
  #[cfg(not(windows))]
  let _ = (window, at_cursor);
}

/// The window's client area as it is on screen right now, for the colour picker's eyedropper:
/// WebView2 exposes the EyeDropper API but rejects every `open()`, so the frontend samples this
/// instead. The reply is the width and height (u32, little endian) followed by RGBA rows, top down,
/// in physical pixels.
#[tauri::command]
fn capture_window(window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
  #[cfg(windows)]
  unsafe {
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0 as _);
    let mut rect = RECT::default();
    GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    if w <= 0 || h <= 0 {
      return Err("the window has no area".into());
    }
    let mut origin = POINT::default();
    let _ = ClientToScreen(hwnd, &mut origin);
    let mut frame = RECT::default();
    GetWindowRect(hwnd, &mut frame).map_err(|e| e.to_string())?;
    let (fw, fh) = (frame.right - frame.left, frame.bottom - frame.top);
    let screen = GetDC(None);
    let memory = CreateCompatibleDC(Some(screen));
    // The whole window first, then the client area out of it. PW_RENDERFULLCONTENT (2) asks the
    // compositor for what WebView2 draws through DirectComposition, and works when another window
    // covers this one. Should it fail, copy the area from the screen instead.
    let whole = CreateCompatibleBitmap(screen, fw.max(1), fh.max(1));
    let previous = SelectObject(memory, whole.into());
    let printed = PrintWindow(hwnd, memory, PRINT_WINDOW_FLAGS(2)).as_bool();
    let bitmap = CreateCompatibleBitmap(screen, w, h);
    let copied = {
      let clip = CreateCompatibleDC(Some(screen));
      let before = SelectObject(clip, bitmap.into());
      let result = if printed {
        BitBlt(clip, 0, 0, w, h, Some(memory), origin.x - frame.left, origin.y - frame.top, SRCCOPY)
      } else {
        BitBlt(clip, 0, 0, w, h, Some(screen), origin.x, origin.y, SRCCOPY | CAPTUREBLT)
      };
      SelectObject(clip, before);
      let _ = DeleteDC(clip);
      result
    };
    let mut info = BITMAPINFO {
      bmiHeader: BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
      },
      ..Default::default()
    };
    let mut out = vec![0u8; 8 + (w as usize) * (h as usize) * 4];
    out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
    SelectObject(memory, previous);
    let _ = DeleteObject(whole.into());
    let lines = GetDIBits(memory, bitmap, 0, h as u32, Some(out[8..].as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
    let _ = DeleteObject(bitmap.into());
    let _ = DeleteDC(memory);
    ReleaseDC(None, screen);
    copied.map_err(|e| e.to_string())?;
    if lines != h {
      return Err("could not read the window's pixels".into());
    }
    // GDI hands back BGRX; the canvas wants RGBA.
    for px in out[8..].chunks_exact_mut(4) {
      px.swap(0, 2);
      px[3] = 255;
    }
    Ok(tauri::ipc::Response::new(out))
  }
  #[cfg(not(windows))]
  {
    let _ = window;
    Err("screen sampling is only available on Windows".into())
  }
}

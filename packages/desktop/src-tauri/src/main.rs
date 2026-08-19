#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop app (, "Desktop (later): Tauri wrapper, same codebase").
//!
//! It is a **client**, not a second copy of the server, and that is the whole
//! design decision. This product is one server in the workshop holding one SQLite
//! file that everybody shares; an installer that carried its own API
//! and its own database would quietly give every bench a private inventory,
//! which is precisely the thing the app exists to prevent. So the desktop app
//! asks which server, remembers the answer, and shows it in a real window.
//!
//! What that buys over a browser tab: the window is the app — no address bar
//! to navigate away from, no tab to close by accident, and a keyboard the OS
//! hands straight to it, which is what makes the key chord work on a
//! shared bench.
//!
//! Same codebase in the literal sense: it serves the very frontend the API
//! already serves, so there is nothing here to keep in step.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MAIN: &str = "main";
const SETUP: &str = "setup";

fn server_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("server.txt"))
}

fn read_server(app: &AppHandle) -> Option<String> {
    let text = fs::read_to_string(server_file(app)?).ok()?;
    let trimmed = text.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// `workshop-pc`, `workshop-pc:3000`, `http://workshop-pc:3000/` all mean the same server.
/// Typing a scheme is not something to ask of somebody reading an address off
/// a sticker on the server.
fn normalize(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Type the address of your inventory server".into());
    }
    // The scheme is decided on the untouched text. Trimming slashes first turns
    // a bare "http://" into "http:", which then looks like it needs a scheme
    // and becomes "http://http:" — a valid URL for a host that does not exist.
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| format!("{trimmed} is not an address"))?;
    if url.host_str().unwrap_or("").is_empty() {
        return Err(format!("{trimmed} is not an address"));
    }
    Ok(with_scheme.trim_end_matches('/').to_string())
}

/// Ask the server whether it is the right kind of server before opening a
/// window on it — otherwise a typo shows a blank rectangle with no explanation.
/// Done here rather than in the page because a webview asking a different
/// origin is a CORS problem, and this is not.
fn probe(base: &str) -> Result<(), String> {
    let response = ureq::get(&format!("{base}/api/v1/health"))
        .timeout(Duration::from_secs(6))
        .call()
        .map_err(|error| match error {
            ureq::Error::Status(code, _) => {
                format!("{base} answered {code} — is that the right address?")
            }
            ureq::Error::Transport(_) => {
                format!("Could not reach {base}. Is the server running, and are you on the same network?")
            }
        })?;

    let body: serde_json::Value = response
        .into_json()
        .map_err(|_| format!("{base} answered, but not like an inventory server"))?;

    if body.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err(format!("{base} answered, but not like an inventory server"))
    }
}

fn open_app_window(app: &AppHandle, base: &str) -> Result<(), String> {
    let url = base
        .parse()
        .map_err(|_| format!("{base} is not an address"))?;

    if let Some(existing) = app.get_webview_window(MAIN) {
        let _ = existing.close();
    }
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
        .title("Inventory")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .build()
        .map_err(|error| error.to_string())?;

    if let Some(setup) = app.get_webview_window(SETUP) {
        let _ = setup.close();
    }
    Ok(())
}

fn open_setup_window(app: &AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(SETUP) {
        let _ = existing.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
        .title("Inventory — connect")
        .inner_size(560.0, 620.0)
        .resizable(false)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn saved_server(app: AppHandle) -> Option<String> {
    read_server(&app)
}

#[tauri::command]
async fn connect(app: AppHandle, address: String) -> Result<String, String> {
    let base = normalize(&address)?;
    // Blocking I/O off the UI thread: the probe waits up to six seconds, and a
    // frozen window is a worse answer than a slow one.
    let checked = base.clone();
    tauri::async_runtime::spawn_blocking(move || probe(&checked))
        .await
        .map_err(|error| error.to_string())??;

    if let Some(path) = server_file(&app) {
        fs::write(path, &base).map_err(|error| error.to_string())?;
    }
    open_app_window(&app, &base)?;
    Ok(base)
}

/// Forget the server and go back to the connect screen. Reachable from the
/// menu, so somebody who moves benches is never stuck pointing at a machine
/// that no longer exists.
#[tauri::command]
fn change_server(app: AppHandle) -> Result<(), String> {
    if let Some(path) = server_file(&app) {
        let _ = fs::remove_file(path);
    }
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.close();
    }
    open_setup_window(&app)
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn accepts_what_a_person_would_actually_type() {
        // All of these are the same server, read off a sticker or a chat message.
        for input in ["workshop-pc:3000", "http://workshop-pc:3000", "http://workshop-pc:3000/", " workshop-pc:3000 "] {
            assert_eq!(normalize(input).unwrap(), "http://workshop-pc:3000", "input: {input:?}");
        }
        assert_eq!(normalize("192.168.1.20:3000").unwrap(), "http://192.168.1.20:3000");
        assert_eq!(normalize("localhost:3000").unwrap(), "http://localhost:3000");
    }

    #[test]
    fn keeps_https_when_it_was_asked_for() {
        // Only the *missing* scheme is filled in; never downgrade one that is there.
        assert_eq!(normalize("https://inventory.workshop.example").unwrap(), "https://inventory.workshop.example");
    }

    #[test]
    fn refuses_what_is_not_an_address() {
        assert!(normalize("").is_err());
        assert!(normalize("   ").is_err());
        assert!(normalize("http://").is_err());
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![saved_server, connect, change_server])
        .setup(|app| {
            let handle = app.handle().clone();

            let change = MenuItemBuilder::with_id("change-server", "Change server…").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&change]).build()?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app, event| {
                if event.id() == "change-server" {
                    let _ = change_server(app.clone());
                }
            });

            // A remembered server that has since moved must not leave the app
            // staring at nothing: fall back to the connect screen, which shows
            // the address it tried and why it gave up.
            match read_server(&handle) {
                Some(base) if probe(&base).is_ok() => open_app_window(&handle, &base)?,
                _ => open_setup_window(&handle)?,
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}

//! The shell: a window, the engine sidecar, and nothing else.
//!
//! Everything the app *does* happens in the engine (`scope-sub-engine serve
//! --stdio`). `engine.rs` starts it, passes lines between it and the window,
//! and stops it properly when the app quits. Rust owns no media logic and
//! never touches a movie file.

mod engine;
mod settings;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, RunEvent, State};

/// A folder the app was asked to open from outside its window: dropped on its
/// Dock or Finder icon (macOS). It is kept here until the window asks for it,
/// because on a cold start it arrives before there is a window to tell.
#[derive(Default)]
struct OpenedFolder(Mutex<Option<String>>);

/// The first of `paths` that is a folder. Anything else dropped on the icon —
/// a movie file, say — is not something the app opens.
// Only macOS delivers a folder this way; elsewhere this is unused outside tests.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn first_folder(paths: impl IntoIterator<Item = PathBuf>) -> Option<String> {
    paths
        .into_iter()
        .find(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Whether a path dropped on the window is a folder. The window has no file
/// access of its own; this reads nothing but the path's kind.
#[tauri::command]
fn path_is_folder(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// The folder dropped on the app's icon, once: asking takes it.
#[tauri::command]
fn opened_folder(state: State<'_, OpenedFolder>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// The autopilot script, when the app was started with one.
///
/// `SCOPE_SUB_AUTOPILOT` holds JSON (see `src/autopilot.ts`) telling the UI to
/// drive itself through a scan and a fix. It exists so the built app can be
/// exercised end to end, and screenshotted, without a person clicking through
/// native folder pickers. It can do nothing the buttons cannot.
///
/// It is compiled into debug builds and into builds made with the `autopilot`
/// feature (`pnpm tauri build --features autopilot`). A normal release build
/// ignores the variable: an app people install must not be steerable through
/// its environment.
#[tauri::command]
fn autopilot() -> Option<String> {
    #[cfg(any(debug_assertions, feature = "autopilot"))]
    {
        std::env::var("SCOPE_SUB_AUTOPILOT")
            .ok()
            .filter(|s| !s.trim().is_empty())
    }
    #[cfg(not(any(debug_assertions, feature = "autopilot")))]
    {
        None
    }
}

/// Quit, as the Quit menu item does. For the autopilot only — it is how an
/// unattended run checks what a quit in the middle of a fix leaves behind.
#[tauri::command]
fn autopilot_quit(app: AppHandle) -> Result<(), String> {
    #[cfg(any(debug_assertions, feature = "autopilot"))]
    {
        if std::env::var("SCOPE_SUB_AUTOPILOT").is_ok() {
            app.exit(0);
            return Ok(());
        }
    }
    let _ = app;
    Err("not available in this build".into())
}

/// A line for the terminal an unattended run was started from: the app has no
/// log of its own, and nothing else can say why a run stopped where it did.
#[tauri::command]
fn autopilot_log(message: String) {
    #[cfg(any(debug_assertions, feature = "autopilot"))]
    eprintln!("autopilot: {message}");
    let _ = message;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::EngineState::default())
        .manage(OpenedFolder::default())
        .invoke_handler(tauri::generate_handler![
            path_is_folder,
            opened_folder,
            autopilot,
            autopilot_quit,
            autopilot_log,
            engine::engine_start,
            engine::engine_write,
            engine::engine_stop,
            settings::tools_load,
            settings::tools_save,
            settings::prefs_load,
            settings::prefs_save
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| match event {
            // Every way out — the Quit menu, the last window closing — ends
            // here. The engine is asked to stop and given time to clean up
            // before the process goes.
            RunEvent::Exit => engine::shutdown(app, engine::QUIT_TIMEOUT),
            // A folder dropped on the app's icon. It is kept for the window to
            // take (`opened_folder`), and a running window is told to look.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                use tauri::{Emitter, Manager};
                let paths = urls.iter().filter_map(|u| u.to_file_path().ok());
                if let Some(folder) = first_folder(paths) {
                    if let Ok(mut slot) = app.state::<OpenedFolder>().0.lock() {
                        *slot = Some(folder);
                    }
                    let _ = app.emit("open-folder", ());
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_folder_is_opened_from_the_icon() {
        let dir = std::env::temp_dir().join(format!("scope-sub-drop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("movie.mkv");
        std::fs::write(&file, b"x").unwrap();
        let missing = dir.join("gone");

        assert_eq!(first_folder([file.clone(), missing.clone()]), None);
        assert_eq!(
            first_folder([file.clone(), dir.clone()]),
            Some(dir.to_string_lossy().into_owned())
        );
        assert_eq!(first_folder(Vec::<PathBuf>::new()), None);
        assert!(path_is_folder(dir.to_string_lossy().into_owned()));
        assert!(!path_is_folder(file.to_string_lossy().into_owned()));
        assert!(!path_is_folder(missing.to_string_lossy().into_owned()));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

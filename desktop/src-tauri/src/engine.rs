//! The engine sidecar, owned by the shell rather than by the window.
//!
//! The window asks for the engine to be started and sends it lines; what the
//! engine writes comes back as `engine` events. The process itself belongs to
//! Rust for one reason: quitting. Whoever owns the child decides how it ends,
//! and it must end by being *asked* — `shutdown` on its stdin — so that it
//! stops mkvmerge/mkvextract/ffmpeg, removes the half-written copy and its
//! temp files, and only then exits. Killing it outright (what the shell
//! plugin does with children the window spawned) leaves all of that behind.
//!
//! The engine runs in its own process group (on Windows: a job object, which
//! is what the shell plugin's `set_process_group` makes there), so when it
//! does have to be killed — it did not exit in time — the tools it started go
//! with it. Nothing here sends a signal: the quit is a line on stdin on every
//! platform, and the kill is the plugin's, which terminates the job on Windows.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The sidecar's name, as `bundle.externalBin` lists it (without `binaries/`).
const SIDECAR: &str = "scope-sub-engine";
/// The only arguments the engine is ever started with.
const ARGS: [&str; 2] = ["serve", "--stdio"];
/// How long a quit waits for the engine to wind down before killing it.
pub const QUIT_TIMEOUT: Duration = Duration::from_secs(15);

/// Set once the child has terminated; waited on at quit.
#[derive(Default)]
struct Gone {
    flag: Mutex<bool>,
    changed: Condvar,
}

impl Gone {
    fn set(&self) {
        *self.flag.lock().unwrap() = true;
        self.changed.notify_all();
    }

    /// True when the child went away within `timeout`.
    fn wait(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut gone = self.flag.lock().unwrap();
        while !*gone {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (next, _) = self.changed.wait_timeout(gone, deadline - now).unwrap();
            gone = next;
        }
        true
    }
}

struct Running {
    /// The window's name for this run of the engine; every event carries it.
    generation: u64,
    child: CommandChild,
    gone: Arc<Gone>,
}

#[derive(Default)]
pub struct EngineState {
    running: Mutex<Option<Running>>,
    quitting: AtomicBool,
}

#[derive(Clone, Serialize)]
struct EngineEvent {
    generation: u64,
    /// `stdout` | `stderr` | `error` | `exit`
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

/// Ask a child to stop, wait, and make sure: the group is killed either way,
/// which costs nothing when the engine has already gone and taken its tools
/// with it.
fn stop(mut running: Running, timeout: Duration) {
    let asked = running
        .child
        .write(b"{\"id\":\"quit\",\"method\":\"shutdown\"}\n")
        .is_ok();
    let went = asked && running.gone.wait(timeout);
    if !went {
        eprintln!("engine: did not stop when asked; killing it and what it started");
    }
    let _ = running.child.kill();
}

/// Start the engine. Any engine already running is stopped first: the window
/// only asks for a new one when it has given up on the old.
#[tauri::command]
pub async fn engine_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, EngineState>,
    generation: u64,
) -> Result<(), String> {
    if state.quitting.load(Ordering::SeqCst) {
        return Err("the app is quitting".into());
    }
    let old = state.running.lock().unwrap().take();
    if let Some(old) = old {
        stop(old, Duration::from_secs(2));
    }

    let (mut rx, child) = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|e| e.to_string())?
        .args(ARGS)
        .set_process_group(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    eprintln!("engine: started (pid {})", child.pid());
    let gone = Arc::new(Gone::default());
    *state.running.lock().unwrap() = Some(Running {
        generation,
        child,
        gone: gone.clone(),
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let send = |kind: &'static str, line: Option<String>, code: Option<i32>| {
            let _ = handle.emit(
                "engine",
                EngineEvent {
                    generation,
                    kind,
                    line,
                    code,
                },
            );
        };
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    send("stdout", Some(String::from_utf8_lossy(&bytes).into_owned()), None)
                }
                CommandEvent::Stderr(bytes) => {
                    send("stderr", Some(String::from_utf8_lossy(&bytes).into_owned()), None)
                }
                CommandEvent::Error(message) => send("error", Some(message), None),
                CommandEvent::Terminated(payload) => {
                    gone.set();
                    // Forget it, unless a newer engine has already taken its place.
                    let state = handle.state::<EngineState>();
                    let mut running = state.running.lock().unwrap();
                    if running.as_ref().map(|r| r.generation) == Some(generation) {
                        *running = None;
                    }
                    drop(running);
                    eprintln!("engine: exited ({:?})", payload.code);
                    send("exit", None, payload.code);
                }
                _ => {}
            }
        }
        // The channel closed without a `Terminated` (it should not): do not
        // leave a quit waiting on it.
        gone.set();
    });
    Ok(())
}

/// Send one line to the engine's stdin.
#[tauri::command]
pub async fn engine_write(
    state: State<'_, EngineState>,
    generation: u64,
    line: String,
) -> Result<(), String> {
    let mut running = state.running.lock().unwrap();
    match running.as_mut() {
        Some(r) if r.generation == generation => {
            let mut bytes = line.into_bytes();
            if bytes.last() != Some(&b'\n') {
                bytes.push(b'\n');
            }
            r.child.write(&bytes).map_err(|e| e.to_string())
        }
        _ => Err("the engine is not running".into()),
    }
}

/// Stop an engine the window has given up on (a protocol it cannot speak).
#[tauri::command]
pub async fn engine_stop(state: State<'_, EngineState>, generation: u64) -> Result<(), String> {
    let old = {
        let mut running = state.running.lock().unwrap();
        if running.as_ref().map(|r| r.generation) == Some(generation) {
            running.take()
        } else {
            None
        }
    };
    if let Some(old) = old {
        stop(old, Duration::from_secs(2));
    }
    Ok(())
}

/// The app is going away: let the engine finish cleaning up, within reason.
/// Called from `RunEvent::Exit`, after the windows have closed.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>, timeout: Duration) {
    let state = app.state::<EngineState>();
    state.quitting.store(true, Ordering::SeqCst);
    let running = state.running.lock().unwrap().take();
    if let Some(running) = running {
        stop(running, timeout);
    }
}

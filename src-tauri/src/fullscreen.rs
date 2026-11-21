use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct SavedGeometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

struct SavedWindowState {
    // Whether the window was maximized before fullscreen. When true the window
    // is restored by re-maximizing; the normal (restored) bounds of a maximized
    // window are owned by the OS and cannot be read via the window API.
    maximized: bool,
    geometry: Option<SavedGeometry>,
}

pub struct FullscreenState {
    saved: Arc<Mutex<Option<SavedWindowState>>>,
}

impl FullscreenState {
    pub fn new() -> Self {
        Self {
            saved: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
pub async fn window_fullscreen_enter(
    app: AppHandle,
    state: State<'_, FullscreenState>,
) -> Result<(), String> {
    run_window_transition(&app, Arc::clone(&state.saved), enter_fullscreen).await
}

// Tauri setters called from an async command only enqueue window messages.
// Keep the bounds reads and writes in one window-thread operation: otherwise a
// simultaneous player reassert can save fullscreen dimensions as restore bounds.
async fn run_window_transition(
    app: &AppHandle,
    saved: Arc<Mutex<Option<SavedWindowState>>>,
    transition: impl FnOnce(&tauri::WebviewWindow, &Mutex<Option<SavedWindowState>>) -> Result<(), String>
        + Send
        + 'static,
) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(transition(&main, &saved));
    })
    .map_err(|e| format!("fullscreen transition dispatch: {}", e))?;
    rx.await
        .map_err(|e| format!("fullscreen transition result: {}", e))?
}

// AppKit keeps a window fullscreen across a refused or interrupted exit, while
// tao clears its own flag as soon as the exit is requested. Entering then makes
// tao rewrite the style mask on a window that is still fullscreen, and macOS 26+
// aborts on that write outside a transition (tao-apps/tao#1414). Trust AppKit.
fn window_is_fullscreen(main: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    if let Some(fullscreen) = macos::appkit_fullscreen(main) {
        return fullscreen;
    }
    main.is_fullscreen().unwrap_or(false)
}

fn exit_native_fullscreen(main: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !main.is_fullscreen().unwrap_or(true) {
        // After a refused exit tao already reports windowed and its setter
        // returns early, leaving the still-fullscreen window untouched. Exiting
        // needs none of tao's style-mask preparation, so ask AppKit directly.
        macos::toggle_fullscreen(main);
        return Ok(());
    }
    main.set_fullscreen(false)
        .map_err(|e| format!("set_fullscreen(false): {}", e))
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};
    use objc2_foundation::MainThreadMarker;

    pub fn appkit_fullscreen(window: &tauri::WebviewWindow) -> Option<bool> {
        MainThreadMarker::new()?;
        let ns_window = ns_window(window)?;
        Some(unsafe { (*ns_window).styleMask() }.contains(NSWindowStyleMask::FullScreen))
    }

    pub fn toggle_fullscreen(window: &tauri::WebviewWindow) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        if let Some(ns_window) = ns_window(window) {
            unsafe { (*ns_window).toggleFullScreen(None) };
        }
    }

    fn ns_window(window: &tauri::WebviewWindow) -> Option<*mut NSWindow> {
        let ns_window = window.ns_window().ok()? as *mut NSWindow;
        (!ns_window.is_null()).then_some(ns_window)
    }
}

fn enter_fullscreen(
    main: &tauri::WebviewWindow,
    saved: &Mutex<Option<SavedWindowState>>,
) -> Result<(), String> {
    let already_fs = window_is_fullscreen(main);
    if !already_fs {
        #[cfg(windows)]
        crate::window_placement::pause_for_transition(main.app_handle(), true);
        // The OS owns a maximized window's restored bounds. Save its mode before
        // unmaximizing instead of capturing the maximized dimensions.
        let maximized = main.is_maximized().unwrap_or(false);
        if maximized {
            let _ = main.unmaximize();
        }
        let geometry = if maximized {
            None
        } else if let (Ok(pos), Ok(sz)) = (main.outer_position(), main.inner_size()) {
            Some(SavedGeometry {
                x: pos.x,
                y: pos.y,
                w: sz.width,
                h: sz.height,
            })
        } else {
            None
        };
        let mut saved = saved.lock().unwrap();
        // Preserve the original snapshot if the OS temporarily drops fullscreen
        // and the player reasserts it before the user has actually exited.
        saved.get_or_insert(SavedWindowState { maximized, geometry });
        main.set_fullscreen(true)
            .map_err(|e| format!("set_fullscreen(true): {}", e))?;
        let _ = main.set_focus();
    }
    let _ = main.app_handle().emit_to("main", "fs://entered", ());
    Ok(())
}

#[tauri::command]
pub async fn window_fullscreen_exit(
    app: AppHandle,
    state: State<'_, FullscreenState>,
    restore_position: Option<bool>,
) -> Result<(), String> {
    run_window_transition(&app, Arc::clone(&state.saved), move |main, saved| {
        exit_fullscreen(main, saved, restore_position.unwrap_or(true))
    })
    .await
}

fn exit_fullscreen(
    main: &tauri::WebviewWindow,
    saved: &Mutex<Option<SavedWindowState>>,
    restore_position: bool,
) -> Result<(), String> {
    let is_fs = window_is_fullscreen(main);
    #[cfg(windows)]
    crate::window_placement::pause_for_transition(main.app_handle(), false);
    if is_fs {
        exit_native_fullscreen(main)?;
    }

    // Restore even when the window is already unfullscreen'd: frontend paths
    // like exitAnyFullscreen call setFullscreen(false) directly before this
    // command runs, and the saved geometry must still be applied.
    let saved = saved.lock().unwrap().take();
    if let Some(saved) = saved {
        if saved.maximized {
            let _ = main.maximize();
        } else if let Some(geo) = saved.geometry {
            let _ = main.set_size(tauri::PhysicalSize {
                width: geo.w,
                height: geo.h,
            });
            if restore_position {
                let _ = main.set_position(tauri::PhysicalPosition { x: geo.x, y: geo.y });
            } else {
                let _ = main.center();
            }
        } else if is_fs {
            let _ = main.set_size(tauri::LogicalSize { width: 1280.0, height: 800.0 });
            let _ = main.center();
        }
        let _ = main.set_focus();
    }
    let _ = main.app_handle().emit_to("main", "fs://exited", ());
    Ok(())
}

#[cfg(windows)]
pub fn apply_transparency(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(label) else {
        eprintln!("[harbor::transparent] window {} missing", label);
        return;
    };
    let res = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
        };
        use windows::core::Interface;
        let controller = webview.controller();
        match controller.cast::<ICoreWebView2Controller2>() {
            Ok(controller2) => {
                let color = COREWEBVIEW2_COLOR {
                    A: 0,
                    R: 0,
                    G: 0,
                    B: 0,
                };
                match controller2.SetDefaultBackgroundColor(color) {
                    Ok(()) => eprintln!("[harbor::transparent] re-applied (alpha=0)"),
                    Err(e) => eprintln!("[harbor::transparent] re-apply FAILED: {:?}", e),
                }
            }
            Err(e) => eprintln!("[harbor::transparent] cast to Controller2 FAILED: {:?}", e),
        }
    });
    if let Err(e) = res {
        eprintln!("[harbor::transparent] with_webview FAILED: {:?}", e);
    }
}

/// Enable WebView2's protected persistent profile for saved web credentials.
#[cfg(windows)]
pub fn enable_credential_persistence(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let result = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile6, ICoreWebView2_13,
        };
        use windows::core::Interface;
        let credential_result = (|| -> Result<(), windows::core::Error> {
            let core = webview.controller().CoreWebView2()?;
            let core13 = core.cast::<ICoreWebView2_13>()?;
            let profile6 = core13.Profile()?.cast::<ICoreWebView2Profile6>()?;
            profile6.SetIsPasswordAutosaveEnabled(true)?;
            profile6.SetIsGeneralAutofillEnabled(true)?;
            Ok(())
        })();
        match credential_result {
            Ok(()) => eprintln!("[harbor::webview] credential persistence enabled"),
            Err(e) => eprintln!("[harbor::webview] credential persistence unavailable: {:?}", e),
        }
    });
    if let Err(e) = result {
        eprintln!("[harbor::webview] credential persistence setup failed: {:?}", e);
    }
}

#[cfg(not(windows))]
pub fn enable_credential_persistence(_app: &tauri::AppHandle, _label: &str) {}

#[tauri::command]
pub fn webview_reapply_transparency(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        apply_transparency(&_app, "main");
    }
    Ok(())
}

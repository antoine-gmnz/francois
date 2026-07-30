// Native window chrome tinting. This is really an `app`-domain command
// (`app_set_window_theme`) per the project's channel-naming convention, but the
// Win32 DWM plumbing it wraps has nothing to do with any domain's data model, so
// it gets its own file rather than living inside a domain module.

use crate::ipc::{ok, IpcResult};
use tauri::AppHandle;

#[cfg(windows)]
use tauri::Manager;

/// Paint the native caption bar with the app's own palette so the OS chrome reads as
/// part of the window instead of a grey strip sitting on top of it. The window keeps
/// its real minimize/maximize/close buttons — only their backdrop is recolored.
/// Windows 11 (build 22000+) only; older builds ignore the attributes and keep the
/// plain dark caption from `"theme": "Dark"`.
#[cfg(windows)]
pub fn tint_window_chrome(window: &tauri::WebviewWindow, theme: &str) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };

    // COLORREF is 0x00BBGGRR — byte order reversed from CSS hex.
    const fn colorref(rgb: u32) -> u32 {
        ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
    }
    // Match the caption to --bg-app for the active theme so the OS chrome disappears
    // into the window instead of reading as a strip on top of it. The values mirror
    // styles.css: dark #0f1015 / light #f5f6f8, with the theme's secondary text hue.
    let (caption, text) = if theme == "light" {
        (colorref(0xf5_f6_f8), colorref(0x4e_52_5b)) // --bg-app / --text-hint (light)
    } else {
        (colorref(0x0f_10_15), colorref(0xa9_ad_b6)) // --bg-app / --text-hint (dark)
    };
    let border = caption; // no seam between the caption and the window edge

    let Ok(hwnd) = window.hwnd() else { return };
    for (attr, color) in [
        (DWMWA_CAPTION_COLOR, caption),
        (DWMWA_TEXT_COLOR, text),
        (DWMWA_BORDER_COLOR, border),
    ] {
        // SAFETY: hwnd is live (we hold the window), and the attribute payload is the
        // COLORREF u32 the DWM docs specify for these three attributes.
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as _,
                attr as u32,
                std::ptr::addr_of!(color).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

/// francois:app:setWindowTheme — repaint the native caption bar for the given theme
/// ("light" | "dark"). The webview calls this on mount and whenever the theme toggles
/// so the OS chrome tracks --bg-app. Best-effort: a no-op on non-Windows / older builds.
#[tauri::command(async)]
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn app_set_window_theme(_app: AppHandle, theme: String) -> IpcResult<()> {
    #[cfg(windows)]
    if let Some(w) = _app.get_webview_window("main") {
        tint_window_chrome(&w, &theme);
    }
    ok(())
}

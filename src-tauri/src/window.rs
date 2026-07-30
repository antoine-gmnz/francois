// Native window chrome tinting. This is really an `app`-domain command
// (`app_set_window_theme`) per the project's channel-naming convention, but the
// Win32 DWM plumbing it wraps has nothing to do with any domain's data model, so
// it gets its own file rather than living inside a domain module.

use crate::ipc::{ok, IpcResult};
use tauri::AppHandle;

#[cfg(windows)]
use tauri::Manager;

// COLORREF is 0x00BBGGRR — byte order reversed from CSS hex.
#[cfg(windows)]
const fn colorref(rgb: u32) -> u32 {
    ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)
}

/// (caption, text) COLORREFs for the given theme. Mirrors two `styles.css` tokens
/// verbatim (design-refresh FR-12): `--bg-app` (dark #0d0f13 / light #eef0f4) for the
/// caption/border, `--text-hint` (dark #9aa2b1 / light #42464e) for the caption text —
/// so the OS chrome disappears into the window instead of reading as a strip on top
/// of it. Pulled out of `tint_window_chrome` so the value mapping is unit-testable
/// without a real HWND.
#[cfg(windows)]
fn caption_colors(theme: &str) -> (u32, u32) {
    if theme == "light" {
        (colorref(0xee_f0_f4), colorref(0x42_46_4e)) // --bg-app / --text-hint (light)
    } else {
        (colorref(0x0d_0f_13), colorref(0x9a_a2_b1)) // --bg-app / --text-hint (dark)
    }
}

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

    let (caption, text) = caption_colors(theme);
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    // design-refresh FR-12: caption COLORREFs mirror the new --bg-app / --text-hint
    // tokens (contract §5 / brief token table), byte-swapped to 0x00BBGGRR.
    #[test]
    fn caption_colors_dark_matches_new_bg_app_and_text_hint() {
        assert_eq!(
            caption_colors("dark"),
            (colorref(0x0d_0f_13), colorref(0x9a_a2_b1))
        );
    }

    #[test]
    fn caption_colors_light_matches_new_bg_app_and_text_hint() {
        assert_eq!(
            caption_colors("light"),
            (colorref(0xee_f0_f4), colorref(0x42_46_4e))
        );
    }
}

//! Boards stay where they are in the z-order: clicking or typing in a widget activates the board but never lifts it
//! above other apps (Rainmeter's "Bottom"). Only our own calls move it: `raise` for explicit show requests and
//! `set_topmost` for edit and keyboard mode. The board sinks on its own as other apps come forward.
//! Windows rewrites `hwndInsertAfter` before WM_WINDOWPOSCHANGING (HWND_TOPMOST arrives as 0), so the hook cannot
//! tell requests apart by value: our calls are synchronous and pass under a flag instead.

/// True when a z-order change should be dropped.
#[cfg_attr(not(windows), allow(dead_code))]
fn blocks(flags: u32, passing: bool) -> bool {
    const SWP_NOZORDER: u32 = 0x0004;
    !passing && flags & SWP_NOZORDER == 0
}

#[cfg(windows)]
mod win {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongW, GetWindowThreadProcessId, IsWindow, SetWindowPos, GWL_EXSTYLE, GW_HWNDPREV,
        HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WINDOWPOS, WM_NCDESTROY,
        WM_WINDOWPOSCHANGING, WS_EX_TOPMOST,
    };

    const ID: usize = 0x5742;
    static PASS: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == WM_WINDOWPOSCHANGING && lp.0 != 0 {
            let pos = &mut *(lp.0 as *mut WINDOWPOS);
            if super::blocks(pos.flags.0, PASS.load(Ordering::Relaxed)) {
                pos.flags |= SWP_NOZORDER;
            }
        } else if msg == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(proc), ID);
        }
        DefSubclassProc(hwnd, msg, wp, lp)
    }

    pub fn keep_back(w: &tauri::WebviewWindow) {
        if let Ok(h) = w.hwnd() {
            unsafe {
                let _ = SetWindowSubclass(h, Some(proc), ID, 0);
            }
        }
    }

    fn place(w: &tauri::WebviewWindow, after: HWND) {
        if let Ok(h) = w.hwnd() {
            PASS.store(true, Ordering::Relaxed);
            // synchronous (no SWP_ASYNCWINDOWPOS), also from another thread, so PASS covers exactly this call
            unsafe {
                let _ = SetWindowPos(h, Some(after), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            PASS.store(false, Ordering::Relaxed);
        }
    }

    /// In front of every normal window. A plain HWND_TOP stops below the foreground window when another app has
    /// focus (a tray click), so it goes through the topmost band and back down.
    pub fn raise(w: &tauri::WebviewWindow) {
        place(w, HWND_TOPMOST);
        place(w, HWND_NOTOPMOST);
    }

    fn is_topmost(h: HWND) -> bool {
        unsafe { GetWindowLongW(h, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0 }
    }

    /// The first window above `h` that is another app's and not topmost: where the board goes back under.
    fn window_above(h: HWND) -> Option<HWND> {
        let me = unsafe { GetCurrentProcessId() };
        let mut cur = h;
        loop {
            cur = unsafe { GetWindow(cur, GW_HWNDPREV) }.ok().filter(|c| !c.is_invalid())?;
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(cur, Some(&mut pid)) };
            if is_topmost(cur) {
                return None; // reached the topmost band: the board was the front normal window
            }
            if pid != me {
                return Some(cur);
            }
        }
    }

    // board -> the window it sat under when edit or keyboard mode lifted it (raw handles: HWND is not Send)
    static UNDER: Mutex<Vec<(isize, isize)>> = Mutex::new(Vec::new());

    /// Replaces `set_always_on_top`, whose async request the hook would drop. Turning it off puts the board back
    /// under the window it sat under before (or leaves it in front if there was none or it has closed).
    pub fn set_topmost(w: &tauri::WebviewWindow, on: bool) {
        let Ok(h) = w.hwnd() else { return };
        let mut under = UNDER.lock().unwrap();
        if on {
            if !is_topmost(h) {
                under.retain(|(b, _)| *b != h.0 as isize);
                if let Some(a) = window_above(h) {
                    under.push((h.0 as isize, a.0 as isize));
                }
            }
            place(w, HWND_TOPMOST);
        } else {
            place(w, HWND_NOTOPMOST);
            if let Some(i) = under.iter().position(|(b, _)| *b == h.0 as isize) {
                let a = HWND(under.swap_remove(i).1 as *mut _);
                if unsafe { IsWindow(Some(a)) }.as_bool() {
                    place(w, a);
                }
            }
        }
    }
}

#[cfg(windows)]
pub use win::{keep_back, raise, set_topmost};

#[cfg(not(windows))]
pub fn keep_back(_w: &tauri::WebviewWindow) {}
#[cfg(not(windows))]
pub fn raise(w: &tauri::WebviewWindow) {
    let _ = w.set_focus();
}
#[cfg(not(windows))]
pub fn set_topmost(w: &tauri::WebviewWindow, on: bool) {
    let _ = w.set_always_on_top(on);
}

#[cfg(test)]
mod tests {
    use super::blocks;

    #[test]
    fn only_our_own_calls_move_the_board() {
        assert!(blocks(0x0013, false)); // a click's activation, or tao's async topmost request
        assert!(!blocks(0x0013, true)); // raise() / set_topmost()
        assert!(!blocks(0x0037, false)); // SWP_NOZORDER (show, frame change): no z change asked
    }
}

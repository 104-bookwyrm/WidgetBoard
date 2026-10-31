//! Screen capture for the layout export and "capture this widget": a GDI copy of a screen rectangle (physical
//! pixels, the composed desktop including layered windows such as the boards), returned as RGBA.

#[cfg(windows)]
pub fn grab(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
    };
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let copied = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT).is_ok();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
        let rows = GetDIBits(mem, bmp, 0, h as u32, Some(buf.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if !copied || rows != h {
            return None;
        }
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2); // BGRA -> RGBA
            px[3] = 255;
        }
        Some(buf)
    }
}

#[cfg(not(windows))]
pub fn grab(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<Vec<u8>> {
    None
}

/// Put RGBA pixels on the clipboard as a bitmap (CF_DIB, what Paint, Clip Studio and chat apps paste).
#[cfg(windows)]
pub fn to_clipboard(rgba: &[u8], w: i32, h: i32) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Gdi::{BITMAPINFOHEADER, BI_RGB};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_DIB;
    let row = (w as usize) * 4;
    if w <= 0 || h <= 0 || rgba.len() != row * h as usize {
        return Err("bad image".into());
    }
    let head = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: h, // bottom-up rows: the layout every program reads
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let hs = std::mem::size_of::<BITMAPINFOHEADER>();
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, hs + rgba.len()).map_err(|e| e.to_string())?;
        let out = std::slice::from_raw_parts_mut(GlobalLock(mem).cast::<u8>(), hs + rgba.len());
        out[..hs].copy_from_slice(std::slice::from_raw_parts((&head as *const BITMAPINFOHEADER).cast::<u8>(), hs));
        for (y, src) in rgba.chunks_exact(row).enumerate() {
            let dst = &mut out[hs + (h as usize - 1 - y) * row..][..row];
            for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                d.copy_from_slice(&[s[2], s[1], s[0], 255]); // RGBA -> BGRA
            }
        }
        let _ = GlobalUnlock(mem);
        OpenClipboard(None).map_err(|e| e.to_string())?;
        let done = EmptyClipboard().and_then(|_| SetClipboardData(CF_DIB.0 as u32, Some(HANDLE(mem.0))).map(|_| ()));
        let _ = CloseClipboard();
        done.map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
pub fn to_clipboard(_rgba: &[u8], _w: i32, _h: i32) -> Result<(), String> {
    Err("not supported".into())
}

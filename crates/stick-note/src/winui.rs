//! Windows details.
//!
//! Stick Note is a program without a console window: double-clicking it must not flash a black box. It can still
//! talk to the terminal it was started from (`--version`, `--stop`, the log of `--serve`), it shows an error dialog
//! to someone who started it from a shortcut and so has no terminal to read the error in, and it keeps its own
//! pipes out of the background server it starts, so a test or script that waits for them is not kept waiting.
//!
//! On other systems none of this is needed and every function does nothing.

#![allow(unsafe_code)] // the only module that calls the Windows API directly

/// What `init` found out about how the program was started.
pub struct Console {
    /// There is nobody to read an error on a console or in a pipe: show it in a dialog box.
    pub dialogs: bool,
}

#[cfg(windows)]
mod imp {
    use super::Console;
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows_sys::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MessageBoxW};

    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;

    fn has_handle(which: u32) -> bool {
        // SAFETY: GetStdHandle only reads a value of the process.
        let handle = unsafe { GetStdHandle(which) };
        !handle.is_null() && handle != INVALID_HANDLE_VALUE
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Open the console of the terminal (CONIN$ or CONOUT$) and make it the standard handle.
    fn reopen(which: u32, device: &str, access: u32) {
        let name = wide(device);
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call; the other arguments are plain values.
        unsafe {
            let handle =
                CreateFileW(name.as_ptr(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut());
            if handle != INVALID_HANDLE_VALUE {
                SetStdHandle(which, handle);
            }
        }
    }

    pub fn init(attach: bool) -> Console {
        let given = has_handle(STD_OUTPUT_HANDLE) || has_handle(STD_ERROR_HANDLE); // a pipe or a file was passed in
        let mut attached = false;
        if attach && !(has_handle(STD_OUTPUT_HANDLE) && has_handle(STD_ERROR_HANDLE)) {
            // SAFETY: AttachConsole takes a process id and nothing else.
            if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } != 0 {
                attached = true;
                if !has_handle(STD_OUTPUT_HANDLE) {
                    reopen(STD_OUTPUT_HANDLE, "CONOUT$", GENERIC_READ | GENERIC_WRITE);
                }
                if !has_handle(STD_ERROR_HANDLE) {
                    reopen(STD_ERROR_HANDLE, "CONOUT$", GENERIC_READ | GENERIC_WRITE);
                }
                if !has_handle(STD_INPUT_HANDLE) {
                    reopen(STD_INPUT_HANDLE, "CONIN$", GENERIC_READ | GENERIC_WRITE);
                }
            }
        }
        Console { dialogs: !given && !attached }
    }

    pub fn message_box(text: &str) {
        let text = wide(text);
        let caption = wide("Stick Note");
        // SAFETY: both strings are NUL-terminated UTF-16 and outlive the call; a null owner window is allowed.
        unsafe {
            MessageBoxW(std::ptr::null_mut::<c_void>(), text.as_ptr(), caption.as_ptr(), MB_ICONERROR | MB_OK | MB_SETFOREGROUND);
        }
    }

    /// A program that starts another one passes on every inheritable handle, pipes included. Mark ours as not
    /// inheritable first, so the background server never holds the pipe of whoever started us.
    pub fn protect_std_handles() {
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if has_handle(which) {
                // SAFETY: the handle is a valid standard handle of this process; only its inherit flag changes.
                unsafe {
                    SetHandleInformation(GetStdHandle(which), HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Console;

    pub fn init(_attach: bool) -> Console {
        Console { dialogs: false }
    }

    pub fn message_box(_text: &str) {}

    pub fn protect_std_handles() {}
}

/// Connect to the terminal the program was started from (when `attach`) and report how it was started.
pub fn init(attach: bool) -> Console {
    imp::init(attach)
}

/// Show an error to a person who has no terminal to read it in.
pub fn message_box(text: &str) {
    imp::message_box(text);
}

pub fn protect_std_handles() {
    imp::protect_std_handles();
}

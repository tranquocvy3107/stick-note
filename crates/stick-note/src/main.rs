// No console window: Stick Note starts from a shortcut and must not flash a black box. When it is started from a
// terminal it connects to that terminal (see winui.rs).
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    stick_note::cli::main()
}

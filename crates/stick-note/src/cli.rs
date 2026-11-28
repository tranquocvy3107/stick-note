//! The command line: what `stick-note` does with its options.
//!
//!   stick-note            open the app (starts a background server when none is running)
//!   stick-note --open     the same
//!   stick-note --run      run the server in the foreground and open the app window (used by the AppImage)
//!   stick-note --serve    run the server in the foreground and print its log
//!   stick-note --bg       background mode: quit by itself when no window is open (started by --open)
//!   stick-note --stop     ask a running server to quit
//!   stick-note --version  print the version
//!   stick-note --data-dir print the folder where your notes are stored

use std::io::{self, Write};
use std::process::ExitCode;

use crate::app::{ServerOptions, StartError, log_panics, serve};
use crate::jsnum;
use crate::launcher::{open_window, probe, start_background, stop_running};
use crate::paths::{DEFAULT_PORT, Env, Platform, VERSION, app_dir, home_dir, process_env, read_build_info, resolve_data_dir};
use crate::presence::WEEK_MS;
use crate::winui;

/// Quit this long after the last window closed (can be changed with STICK_NOTE_IDLE_MS, for tests).
const DEFAULT_IDLE_EXIT_MS: u64 = 300_000;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub version: bool,
    pub data_dir: bool,
    pub help: bool,
    pub stop: bool,
    pub open: bool,
    pub run: bool,
    pub bg: bool,
    pub serve: bool,
}

impl Options {
    /// The first option nobody knows is returned as the error. No option at all means `--open`.
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut o = Self::default();
        for arg in args {
            match arg.as_str() {
                "--version" | "-v" => o.version = true,
                "--data-dir" => o.data_dir = true,
                "--help" | "-h" => o.help = true,
                "--stop" => o.stop = true,
                "--open" => o.open = true,
                "--run" => o.run = true,
                "--bg" => o.bg = true,
                "--serve" => o.serve = true,
                other => return Err(other.to_string()),
            }
        }
        o.open |= args.is_empty();
        Ok(o)
    }
}

fn usage() -> String {
    format!(
        "Stick Note {VERSION}\n\n\
         Usage: stick-note [--open | --run | --serve | --bg | --stop | --version | --data-dir]\n\n\
         \x20 (no option)   open the app; start the background server first when it is not running\n\
         \x20 --open        the same\n\
         \x20 --run         run the server in the foreground and open the app window\n\
         \x20 --serve       run the server in the foreground and print its log\n\
         \x20 --bg          background mode: quit by itself when no window is open\n\
         \x20 --stop        ask a running server to quit\n\
         \x20 --version     print the version\n\
         \x20 --data-dir    print the folder where your notes are stored\n\n\
         Settings (environment variables): PORT (default {DEFAULT_PORT}), STICK_NOTE_DATA (where the notes are kept),\n\
         STICK_NOTE_BROWSER (which browser opens the window), STICK_NOTE_IDLE_MS, STICK_NOTE_NO_OPEN."
    )
}

fn out(line: &str) {
    let _ = writeln!(io::stdout(), "{line}");
}

/// Where errors go: the terminal, and a dialog box for someone who started the program from a shortcut.
struct Ui {
    dialogs: bool,
}

impl Ui {
    fn fail(&self, console: &str, dialog: &str) {
        let _ = writeln!(io::stderr(), "{console}");
        if self.dialogs {
            winui::message_box(dialog);
        }
    }
}

/// `PORT`, or the default one. Anything JavaScript would read as 0 or "not a number" means the default.
fn port_from(env: Env) -> Result<u16, String> {
    let Some(text) = env("PORT") else { return Ok(DEFAULT_PORT) };
    let number = jsnum::number_from_str(&text);
    if number.is_nan() || number == 0.0 {
        return Ok(DEFAULT_PORT);
    }
    if number.fract() == 0.0 && (1.0..=65535.0).contains(&number) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        return Ok(number as u16);
    }
    Err(format!("PORT must be a number from 1 to 65535, not {text}"))
}

fn idle_exit_ms_from(env: Env) -> u64 {
    let number = env("STICK_NOTE_IDLE_MS").map_or(f64::NAN, |t| jsnum::number_from_str(&t));
    if number.is_nan() || number == 0.0 {
        DEFAULT_IDLE_EXIT_MS
    } else if number < 0.0 {
        0
    } else {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let ms = number.min(9e15) as u64;
        ms
    }
}

pub fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match Options::parse(&args) {
        Ok(options) => options,
        Err(unknown) => {
            let console = winui::init(true);
            Ui { dialogs: console.dialogs }.fail(&format!("Unknown option: {unknown}\n\n{}", usage()), &format!("Unknown option: {unknown}"));
            return ExitCode::from(2);
        }
    };
    // The background server must not attach to the terminal that started it: closing that terminal would end it.
    let console = winui::init(!options.bg);
    log_panics();
    let no_open = process_env("STICK_NOTE_NO_OPEN").is_some_and(|v| !v.is_empty());
    // The background server never shows a dialog: whoever started it (--open) tells the person if it did not come up.
    let ui = Ui { dialogs: console.dialogs && !no_open && !options.bg };
    ExitCode::from(execute(&options, &ui))
}

fn execute(options: &Options, ui: &Ui) -> u8 {
    let env: Env = &process_env;
    let platform = Platform::current();
    let root = app_dir();
    let build_info = read_build_info(&root);
    let data_dir = resolve_data_dir(env, &root, &build_info, platform, &home_dir());

    if options.version {
        out(VERSION);
        return 0;
    }
    if options.data_dir {
        out(&data_dir.display().to_string());
        return 0;
    }
    if options.help {
        out(&usage());
        return 0;
    }

    let port = match port_from(env) {
        Ok(port) => port,
        Err(why) => {
            ui.fail(&why, &why);
            return 1;
        }
    };
    let url = format!("http://127.0.0.1:{port}/");
    let running = probe(port);

    if options.stop {
        if !running {
            out("Stick Note is not running.");
            return 0;
        }
        let stopped = stop_running(port);
        out(if stopped { "Stick Note stopped." } else { "Stick Note did not stop in time." });
        return u8::from(!stopped);
    }

    if options.open {
        if !running && !start_background(port) {
            ui.fail(
                &format!("Could not start Stick Note on port {port}.\nRun \"stick-note --serve\" to see the detailed error."),
                &format!(
                    "Stick Note could not start (port {port}).\n\nAnother program may be using the same network port, or the files of Stick Note may be damaged. Please try again; if it keeps failing, install Stick Note again. Your notes are not affected."
                ),
            );
            return 1;
        }
        open_window(&url, env, platform);
        return 0;
    }

    if running {
        out(&format!("Stick Note is already running at {url}"));
        if options.run {
            open_window(&url, env, platform);
        }
        return 0;
    }

    let background = options.bg;
    let server = ServerOptions {
        port,
        data_dir,
        idle_exit_ms: if background || options.run { idle_exit_ms_from(env) } else { 0 },
        window_ttl_ms: WEEK_MS,
        log_to_console: !background,
        build_info,
    };
    match serve(server, |_| {
        if options.run {
            open_window(&url, env, platform);
        }
    }) {
        Ok(()) => 0,
        Err(StartError::PortInUse) => {
            if probe(port) {
                return 0; // another copy just finished starting; use that one
            }
            let why = format!("Port {port} is used by another program. Choose another port, for example: PORT=4848");
            ui.fail(&why, &why);
            1
        }
        Err(StartError::Other(why)) => {
            let message = format!("Could not start the server: {why}");
            ui.fail(&message, &message);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(ToString::to_string).collect()
    }

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn no_option_means_open_the_app() {
        assert!(Options::parse(&args(&[])).unwrap().open);
        assert!(!Options::parse(&args(&["--serve"])).unwrap().open);
        let combined = Options::parse(&args(&["--run", "--bg"])).unwrap();
        assert!(combined.run && combined.bg);
        assert!(Options::parse(&args(&["-v"])).unwrap().version);
        assert!(Options::parse(&args(&["-h"])).unwrap().help);
    }

    #[test]
    fn an_unknown_option_is_reported_instead_of_being_ignored() {
        assert_eq!(Options::parse(&args(&["--open", "--frobnicate"])).unwrap_err(), "--frobnicate");
        assert_eq!(Options::parse(&args(&["file.txt"])).unwrap_err(), "file.txt");
    }

    #[test]
    fn the_usage_text_names_every_option() {
        let text = usage();
        for flag in ["--open", "--run", "--serve", "--bg", "--stop", "--version", "--data-dir", "PORT", "STICK_NOTE_DATA"] {
            assert!(text.contains(flag), "{flag}");
        }
        assert!(text.starts_with(&format!("Stick Note {VERSION}")));
    }

    #[test]
    fn the_port_comes_from_the_environment_the_way_the_node_server_read_it() {
        assert_eq!(port_from(&env_of(&[])), Ok(DEFAULT_PORT));
        assert_eq!(port_from(&env_of(&[("PORT", "4848")])), Ok(4848));
        assert_eq!(port_from(&env_of(&[("PORT", " 4848 ")])), Ok(4848));
        assert_eq!(port_from(&env_of(&[("PORT", "")])), Ok(DEFAULT_PORT));
        assert_eq!(port_from(&env_of(&[("PORT", "0")])), Ok(DEFAULT_PORT));
        assert_eq!(port_from(&env_of(&[("PORT", "abc")])), Ok(DEFAULT_PORT));
        assert!(port_from(&env_of(&[("PORT", "70000")])).is_err());
        assert!(port_from(&env_of(&[("PORT", "12.5")])).is_err());
        assert!(port_from(&env_of(&[("PORT", "-1")])).is_err());
    }

    #[test]
    fn the_idle_delay_defaults_to_five_minutes() {
        assert_eq!(idle_exit_ms_from(&env_of(&[])), 300_000);
        assert_eq!(idle_exit_ms_from(&env_of(&[("STICK_NOTE_IDLE_MS", "600")])), 600);
        assert_eq!(idle_exit_ms_from(&env_of(&[("STICK_NOTE_IDLE_MS", "0")])), 300_000);
        assert_eq!(idle_exit_ms_from(&env_of(&[("STICK_NOTE_IDLE_MS", "soon")])), 300_000);
        assert_eq!(idle_exit_ms_from(&env_of(&[("STICK_NOTE_IDLE_MS", "-5")])), 0, "a negative delay switches the idle exit off");
    }
}

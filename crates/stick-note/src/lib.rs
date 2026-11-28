//! Stick Note: a personal whiteboard of sticky notes. The local server, the launcher and the command line, in one
//! program. It replaces the Node.js server this project started with; test/contract/ holds the tests that both
//! pass.

#![deny(unsafe_code)]

pub mod app;
pub mod cli;
mod http_util;
mod jsnum;
pub mod launcher;
pub mod logger;
pub mod paths;
pub mod presence;
pub mod store;
pub mod util;
mod winui;

pub use paths::VERSION;

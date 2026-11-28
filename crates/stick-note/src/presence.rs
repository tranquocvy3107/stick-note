//! Which app windows are open, and when the background server may quit.
//!
//! A window says hello with `GET /api/ping?w=<id>` every 20 seconds and goodbye with `POST /api/bye?w=<id>` when it
//! closes. Silence is NOT goodbye: a browser freezes or slows down a window that is minimised or hidden, so a quiet
//! window may well be open. Version 1.2.0 quit the server after 5 minutes without a heartbeat, and a window that had
//! been left alone found its server gone ("Lost connection to the server"). Now only a goodbye removes a window, or a
//! silence so long (a week by default) that the window must be gone, for example because the browser crashed.
//!
//! Windows of version 1.2.0 and older ping without an id and never say goodbye. For them the old rule still applies:
//! the server may quit once nothing at all has been heard for `idle_exit_ms`.
//!
//! The clock is a parameter (milliseconds, like `Date.now()`), so tests can "wait" for hours in no time.

use std::collections::HashMap;

/// A window silent for this long is counted as gone.
pub const WEEK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// A window id: 6 to 64 letters, digits, underscores or hyphens.
fn valid(id: &str) -> bool {
    (6..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub struct Presence {
    /// Window id -> when it was last heard from.
    windows: HashMap<String, u64>,
    /// The last ping of any window, or the moment the last one said goodbye.
    last_activity: u64,
    idle_exit_ms: u64,
    window_ttl_ms: u64,
}

impl Presence {
    /// `idle_exit_ms`: how long after the last window left (or the last anonymous ping) the server may quit.
    pub fn new(idle_exit_ms: u64, window_ttl_ms: u64, now: u64) -> Self {
        Self { windows: HashMap::new(), last_activity: now, idle_exit_ms, window_ttl_ms }
    }

    /// A window is alive. `id` is optional: pings from older versions carry none.
    pub fn ping(&mut self, id: Option<&str>, now: u64) {
        self.last_activity = now;
        if let Some(id) = id.filter(|id| valid(id)) {
            self.windows.insert(id.to_string(), now);
        }
    }

    /// A window is closing.
    pub fn bye(&mut self, id: Option<&str>, now: u64) {
        let Some(id) = id.filter(|id| valid(id)) else { return };
        self.windows.remove(id);
        self.last_activity = now;
    }

    /// The computer has just woken from sleep: nothing could be heard while it slept, so start the clocks again.
    pub fn wake(&mut self, now: u64) {
        self.last_activity = now;
        for seen in self.windows.values_mut() {
            *seen = now;
        }
    }

    /// True once no window is left and nothing has been heard for `idle_exit_ms`.
    pub fn should_quit(&mut self, now: u64) -> bool {
        let ttl = self.window_ttl_ms;
        self.windows.retain(|_, seen| now.saturating_sub(*seen) <= ttl);
        self.windows.is_empty() && now.saturating_sub(self.last_activity) > self.idle_exit_ms
    }

    /// How many windows are counted as open.
    pub fn count(&self) -> usize {
        self.windows.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: u64 = 1000;
    const MIN: u64 = 60 * SEC;
    const HOUR: u64 = 60 * MIN;
    const IDLE: u64 = 5 * MIN;
    const START: u64 = 1_000_000;

    fn presence() -> Presence {
        Presence::new(IDLE, WEEK_MS, START)
    }

    #[test]
    fn with_no_window_at_all_the_server_may_quit_once_the_delay_has_passed() {
        let mut p = presence();
        assert!(!p.should_quit(START + IDLE - SEC));
        assert!(p.should_quit(START + IDLE + SEC));
    }

    #[test]
    fn a_window_that_said_hello_keeps_the_server_alive_however_quiet_it_goes() {
        let mut p = presence();
        p.ping(Some("w-one-window"), START);
        assert_eq!(p.count(), 1);
        assert!(!p.should_quit(START + 3 * HOUR), "1.2.0 quit the server after 5 minutes of this");
        assert_eq!(p.count(), 1);
    }

    #[test]
    fn after_the_last_goodbye_the_server_quits_but_only_after_the_delay() {
        let mut p = presence();
        p.ping(Some("w-one-window"), START);
        let bye = START + HOUR;
        p.bye(Some("w-one-window"), bye);
        assert_eq!(p.count(), 0);
        assert!(!p.should_quit(bye + IDLE - SEC), "a window that is only reloading has time to come back");
        assert!(p.should_quit(bye + IDLE + SEC));
    }

    #[test]
    fn a_window_that_comes_back_after_a_goodbye_cancels_the_quit() {
        let mut p = presence();
        p.ping(Some("w-one-window"), START);
        p.bye(Some("w-one-window"), START);
        p.ping(Some("w-one-window"), START + IDLE - SEC);
        assert!(!p.should_quit(START + IDLE + HOUR));
    }

    #[test]
    fn one_window_leaving_does_not_matter_while_another_one_is_open() {
        let mut p = presence();
        p.ping(Some("w-first-window"), START);
        p.ping(Some("w-second-window"), START);
        assert_eq!(p.count(), 2);
        p.bye(Some("w-first-window"), START);
        assert!(!p.should_quit(START + HOUR));
        p.bye(Some("w-second-window"), START + HOUR);
        assert!(p.should_quit(START + HOUR + IDLE + SEC));
    }

    #[test]
    fn windows_of_version_120_and_older_keep_the_old_rule_quit_after_a_silence() {
        let mut p = presence();
        p.ping(None, START);
        p.ping(None, START);
        assert_eq!(p.count(), 0);
        assert!(!p.should_quit(START + IDLE - SEC));
        p.ping(None, START + 20 * SEC); // another heartbeat 20 seconds later in real life
        assert!(!p.should_quit(START + 20 * SEC + IDLE - SEC), "every ping starts the delay again");
        assert!(p.should_quit(START + 20 * SEC + IDLE + SEC));
    }

    #[test]
    fn a_window_that_stays_silent_for_longer_than_the_time_to_live_is_counted_as_gone() {
        let mut p = Presence::new(IDLE, 24 * HOUR, START);
        p.ping(Some("w-one-window"), START);
        assert!(!p.should_quit(START + 24 * HOUR - MIN));
        assert!(p.should_quit(START + 24 * HOUR + MIN), "for example because the browser crashed and never said goodbye");
        assert_eq!(p.count(), 0);
    }

    #[test]
    fn waking_from_sleep_starts_every_clock_again() {
        let mut p = Presence::new(IDLE, 2 * HOUR, START);
        p.ping(Some("w-one-window"), START);
        let woke = START + 10 * HOUR; // the computer slept: the window could not say anything
        p.wake(woke);
        assert!(!p.should_quit(woke));
        assert_eq!(p.count(), 1);
        assert!(!p.should_quit(woke + HOUR));
    }

    #[test]
    fn names_that_do_not_look_like_a_window_id_are_ignored() {
        let mut p = presence();
        for bad in ["", "x", "has space in it", &"a".repeat(80), "../../etc", "naïve-name", "semi;colon", "tab\tname"] {
            p.ping(Some(bad), START);
            p.bye(Some(bad), START);
        }
        p.ping(None, START);
        assert_eq!(p.count(), 0);
        p.ping(Some(&"a".repeat(64)), START);
        p.ping(Some("Abc_-9"), START);
        assert_eq!(p.count(), 2);
    }

    #[test]
    fn a_goodbye_from_a_window_the_server_never_heard_of_is_harmless() {
        let mut p = presence();
        p.ping(Some("w-one-window"), START);
        p.bye(Some("w-someone-else"), START);
        assert_eq!(p.count(), 1);
        assert!(!p.should_quit(START + HOUR));
    }

    #[test]
    fn a_clock_that_goes_backwards_never_makes_the_server_quit() {
        let mut p = presence();
        p.ping(None, START + HOUR);
        assert!(!p.should_quit(START));
    }
}

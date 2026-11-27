// Which app windows are open, and when the background server may quit.
//
// A window says hello with GET /api/ping?w=<id> every 20 seconds and goodbye with POST /api/bye?w=<id> when it
// closes. Silence is NOT goodbye: a browser freezes or slows down a window that is minimised or hidden, so a quiet
// window may well be open. Version 1.2.0 quit the server after 5 minutes without a heartbeat, and a window that had
// been left alone found its server gone ("Lost connection to the server"). Now only a goodbye removes a window, or a
// silence so long (a week by default) that the window must be gone, for example because the browser crashed.
//
// Windows of version 1.2.0 and older ping without an id and never say goodbye. For them the old rule still applies:
// the server may quit once nothing at all has been heard for `idleExitMs`.

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * @param {object}   options
 * @param {number}   options.idleExitMs     How long after the last window left (or the last anonymous ping) the server may quit.
 * @param {number}   [options.windowTtlMs]  How long a window may stay silent before it is counted as gone.
 * @param {Function} [options.now]          Clock, injectable for tests.
 */
export function createPresence({ idleExitMs, windowTtlMs = WEEK_MS, now = Date.now }) {
  const windows = new Map(); // window id -> when it was last heard from
  let lastActivity = now();  // the last ping of any window, or the moment the last one said goodbye

  const valid = (id) => typeof id === 'string' && ID_RE.test(id);

  return {
    /** A window is alive. `id` is optional: pings from older versions carry none. */
    ping(id) {
      const t = now();
      lastActivity = t;
      if (valid(id)) windows.set(id, t);
    },

    /** A window is closing. */
    bye(id) {
      if (!valid(id)) return;
      windows.delete(id);
      lastActivity = now();
    },

    /** The computer has just woken from sleep: nothing could be heard while it slept, so start the clocks again. */
    wake() {
      const t = now();
      lastActivity = t;
      for (const id of windows.keys()) windows.set(id, t);
    },

    /** True once no window is left and nothing has been heard for `idleExitMs`. */
    shouldQuit() {
      const t = now();
      for (const [id, seen] of windows) if (t - seen > windowTtlMs) windows.delete(id);
      return windows.size === 0 && t - lastActivity > idleExitMs;
    },

    /** How many windows are counted as open. */
    get count() { return windows.size; },
  };
}

// Pure helpers for the Desk app: formatting, escaping, error messages, the token vault and
// the status/control state machines. No DOM here, so every function is tested in Node
// (tests/core.test.mjs). Loaded in the page as a plain script; exposes window.Core.
"use strict";
(function (root) {
  const esc = s => String(s ?? "").replace(/[&<>"'`=]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" }[c]));
  const num = v => (v === null || v === undefined || v === "" || !isFinite(+v)) ? null : +v;
  const usd = (n, d = 2) => (n = num(n)) == null ? "—" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n, d = 2) => (n = num(n)) == null ? "—" : (n > 0 ? "+" : "") + (n * 100).toFixed(d) + "%";
  const prob = (n, d = 0) => (n = num(n)) == null ? "—" : (n * 100).toFixed(d) + "%";
  const sign = n => (n = num(n)) > 0 ? "up" : n < 0 ? "down" : "";
  const ago = (iso, now = Date.now()) => {
    if (!iso) return "—";
    const m = Math.round((now - new Date(iso)) / 60000);
    return isNaN(m) ? "—" : m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
  };
  const TICKER = /^[A-Z][A-Z.]{0,5}(-USD)?$/;
  const cleanRepo = s => String(s || "").trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const validRepo = s => /^[\w.-]+\/[\w.-]+$/.test(s);

  // ---- GitHub errors -> plain words -------------------------------------------------
  class GhError extends Error {
    constructor(status, body, where) { super(`${status} ${String(body || "").slice(0, 160)}`); this.status = status; this.body = body; this.where = where; }
  }
  function explain(err, what = "That") {
    const s = err && err.status;
    const body = String((err && err.body) || "");
    if (s === 0 || (err && err.name === "TypeError")) return `${what} didn't go through: no connection to GitHub. Check your internet and try again.`;
    if (s === 401) return `${what} failed: GitHub rejected the token (expired or revoked). Go to Control → Change token.`;
    if (s === 403 && /rate limit/i.test(body)) return `${what} failed: GitHub's rate limit was hit. Wait a few minutes and try again.`;
    if (s === 403) return `${what} failed: the token isn't allowed to do this. It needs "Actions: Read and write" and "Contents: Read" on the trading-bot repo.`;
    if (s === 404) return `${what} failed: GitHub couldn't find the repo or workflow. Check the repo name, and that the token has the trading-bot repo selected.`;
    if (s === 422) return `${what} failed: GitHub refused the request (the workflow may be disabled or its inputs changed). Open the repo's Actions tab to check.`;
    if (s >= 500) return `${what} failed: GitHub is having trouble (${s}). Try again in a minute.`;
    return `${what} failed: ${err && err.message ? err.message : "unknown error"}`;
  }

  // ---- token vault: the GitHub token is stored only encrypted with your PIN --------
  // PBKDF2-SHA256 (310k rounds) -> AES-GCM-256. The plain token lives only in memory while
  // the app is open. This stops other code, backups or anyone glancing at storage from
  // reading the token; it does NOT stop someone who has your unlocked phone AND guesses
  // the PIN offline, so use 6+ characters and keep the token's scope and expiry tight.
  const ITER = 310000;
  const b64 = buf => { let s = ""; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function keyFrom(pin, salt, subtle) {
    const base = await subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function seal(token, pin, c = root.crypto) {
    if (!pin || pin.length < 4) throw new Error("PIN must be at least 4 characters");
    const salt = c.getRandomValues(new Uint8Array(16)), iv = c.getRandomValues(new Uint8Array(12));
    const ct = await c.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(pin, salt, c.subtle), new TextEncoder().encode(token));
    return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }
  async function unseal(vault, pin, c = root.crypto) {
    const v = JSON.parse(vault);
    try {
      const pt = await c.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv) }, await keyFrom(pin, unb64(v.salt), c.subtle), unb64(v.ct));
      return new TextDecoder().decode(pt);
    } catch { throw new Error("Wrong PIN"); }
  }
  // Wrong-PIN backoff: 5 free tries, then 30s, 60s, 120s ... (kept in storage so reloads don't reset it)
  const lockoutMs = fails => fails < 5 ? 0 : Math.min(30000 * 2 ** (fails - 5), 15 * 60000);

  // ---- what the bot is doing right now --------------------------------------------
  // Combines status.json (written by every run), the STOP file, live.json and GitHub's run list.
  function botStatus({ data, paused, runs = [], live, now = Date.now() }) {
    const active = runs.find(r => r.status !== "completed");
    const lastDone = runs.find(r => r.status === "completed");
    const out = { key: "unknown", label: "No data yet", tone: "", detail: "", warnings: [] };
    if (data) {
      (data.pending_exits || []).forEach(p => out.warnings.push(`${p.ticker}: sell not finished after ${p.attempts} tr${p.attempts === 1 ? "y" : "ies"} (${p.last_issue || p.reason}). Its stop-loss stays in place and the bot keeps retrying.`));
      Object.entries(data.unprotected || {}).forEach(([t, since]) => out.warnings.push(`${t}: no server stop-loss since ${String(since).slice(0, 16).replace("T", " ")}. The bot retries every run and exits it if this lasts 2 hours.`));
      const age = (now - new Date(data.updated)) / 3600000;
      if (age > 26) out.warnings.push(`Status is ${Math.round(age)} h old: the scheduled runs may not be firing.`);
    }
    if (lastDone && ["failure", "timed_out", "startup_failure"].includes(lastDone.conclusion))
      out.warnings.push(`The last "${lastDone.name}" run failed (${ago(lastDone.updated_at || lastDone.created_at, now)}). Open GitHub Actions for the log.`);
    const s = data && data.state;
    if (s === "liquidating") Object.assign(out, { key: "liquidating", label: "Selling", tone: "warn", detail: data.state_reason || "Selling everything; retries until the broker shows no positions." });
    else if (s === "halted" || (data && data.halted)) Object.assign(out, { key: "halted", label: "Halted", tone: "warn", detail: data.state_reason || data.halt_reason || "Stopped by a risk limit. Press Resume to restart." });
    else if (paused || s === "paused" || (data && data.stopped)) Object.assign(out, { key: "paused", label: "Paused", tone: "warn", detail: "No new buys. Stop-losses and exits still run." });
    else if (active) Object.assign(out, { key: "running", label: "Running", tone: "live", detail: `${active.name} ${active.status === "queued" ? "waiting for a server" : "in progress"}` });
    else if (s === "cautious") Object.assign(out, { key: "cautious", label: "Cautious", tone: "warn", detail: data.state_reason });
    else if (live && live.done && live.ok === false && (now - new Date(live.updated)) < 36 * 3600000) Object.assign(out, { key: "error", label: "Error", tone: "warn", detail: `Last daily run stopped: ${live.detail || "see the log"}` });
    else if (data) Object.assign(out, { key: "idle", label: data.mode === "live" ? "Live money" : "Paper", tone: data.mode === "live" ? "live" : "", detail: "Waiting for the next scheduled run." });
    if (active && out.key !== "running") out.detail += ` · ${active.name} is running now`;
    return out;
  }

  // ---- a button press, from request to broker-confirmed -----------------------------
  // requested  : GitHub accepted the dispatch
  // running    : the Control workflow started and reported in
  // confirmed  : finished and the broker confirms (for panic: every position gone)
  // submitted  : finished, orders sent but not all confirmed (e.g. market closed)
  // failed     : dispatch refused, workflow crashed, or the bot reported an error
  // unknown    : no report after the time limit - check GitHub before assuming anything
  function controlStep(req, report, run, now = Date.now()) {
    if (!req) return null;
    const base = { action: req.action, since: req.at };
    if (req.error) return { ...base, step: "failed", text: req.error };
    if (report && report.request_id === req.id) {
      if (report.state === "running") return { ...base, step: "running", text: "Running on GitHub…" };
      if (report.ok === false) return { ...base, step: "failed", text: report.message || "The bot reported a failure." };
      if (req.action === "panic" && report.confirmed === false) return { ...base, step: "submitted", text: report.message, pending: report.pending || [], closed: report.closed || [] };
      return { ...base, step: "confirmed", text: report.message || "Done." };
    }
    if (run && run.status === "completed" && run.conclusion !== "success")
      return { ...base, step: "failed", text: `The Control workflow ${run.conclusion === "cancelled" ? "was cancelled" : "failed"} before reporting back. Nothing is confirmed${req.action === "panic" ? " — positions may still be open" : ""}. Check GitHub Actions.` };
    if (now - req.at > 6 * 60000) return { ...base, step: "unknown", text: "No answer from the bot after 6 minutes. Nothing is confirmed. Check GitHub Actions and Holdings." };
    return { ...base, step: "requested", text: run ? "GitHub is starting the workflow…" : "Request sent. Waiting for GitHub to start it (usually under a minute)…" };
  }

  const api = { esc, num, usd, pct, prob, sign, ago, TICKER, cleanRepo, validRepo, GhError, explain, seal, unseal, lockoutMs, botStatus, controlStep, ITER };
  root.Core = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);

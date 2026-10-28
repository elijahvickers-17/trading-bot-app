// Run with: node --test tests/   (Node 18+; no packages needed)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const Core = createRequire(import.meta.url)("../core.js");

test("escapes everything that could break out of HTML or an attribute", () => {
  assert.equal(Core.esc(`<img src=x onerror="alert(1)">'\``), "&lt;img src&#61;x onerror&#61;&quot;alert(1)&quot;&gt;&#39;&#96;");
  assert.equal(Core.esc(null), "");
});

test("number formatting tolerates bad API values", () => {
  assert.equal(Core.usd("abc"), "—");
  assert.equal(Core.usd(-7.24), "-$7.24");
  assert.equal(Core.pct(0.0123), "+1.23%");
  assert.equal(Core.sign("x"), "");
});

test("ticker allow-list for anything put into a URL or attribute", () => {
  for (const ok of ["APA", "BRK.B", "BTC-USD"]) assert.ok(Core.TICKER.test(ok), ok);
  for (const bad of ["apa", "../x", "A'B", "<s>", "TOOLONGG"]) assert.ok(!Core.TICKER.test(bad), bad);
});

test("repo input is normalized and validated", () => {
  assert.equal(Core.cleanRepo("https://github.com/elijahvickers-17/trading-bot/"), "elijahvickers-17/trading-bot");
  assert.ok(!Core.validRepo("elijahvickers-17/trading-bot/../x"));
});

test("token vault: round trip, wrong PIN, no plaintext in the stored blob", async () => {
  const token = "github_pat_TESTONLY_not_a_real_token_1234567890";
  const vault = await Core.seal(token, "482913", globalThis.crypto);
  assert.ok(!vault.includes("github_pat"));
  assert.equal(await Core.unseal(vault, "482913", globalThis.crypto), token);
  await assert.rejects(() => Core.unseal(vault, "000000", globalThis.crypto), /Wrong PIN/);
  await assert.rejects(() => Core.seal(token, "12", globalThis.crypto), /at least 4/);
});

test("wrong-PIN lockout grows", () => {
  assert.equal(Core.lockoutMs(4), 0);
  assert.equal(Core.lockoutMs(5), 30000);
  assert.ok(Core.lockoutMs(7) > Core.lockoutMs(6));
  assert.equal(Core.lockoutMs(50), 15 * 60000);
});

test("GitHub errors become clear messages", () => {
  const e = s => new Core.GhError(s, s === 403 ? "API rate limit exceeded" : "x");
  assert.match(Core.explain(e(401), "Pause"), /rejected the token/);
  assert.match(Core.explain(e(403)), /rate limit/);
  assert.match(Core.explain(new Core.GhError(403, "Resource not accessible")), /Actions: Read and write/);
  assert.match(Core.explain(e(404)), /couldn't find/);
  assert.match(Core.explain(e(422)), /refused/);
  assert.match(Core.explain(new Core.GhError(0, "Failed to fetch")), /no connection/);
});

const NOW = Date.parse("2026-10-27T18:00:00Z");
const req = (action = "panic") => ({ id: "r1", action, at: NOW - 60000 });

test("control: dispatch refused -> failed, nothing claimed", () => {
  const st = Core.controlStep({ ...req(), error: "Sell everything failed: ..." }, null, null, NOW);
  assert.equal(st.step, "failed");
});

test("control: requested, then running, then confirmed", () => {
  assert.equal(Core.controlStep(req(), null, null, NOW).step, "requested");
  assert.equal(Core.controlStep(req(), { request_id: "other", state: "done", ok: true }, null, NOW).step, "requested");
  assert.equal(Core.controlStep(req(), { request_id: "r1", state: "running" }, null, NOW).step, "running");
  assert.equal(Core.controlStep(req(), { request_id: "r1", state: "done", ok: true, confirmed: true, message: "confirmed closed: APA" }, null, NOW).step, "confirmed");
});

test("control: panic with positions still open is 'submitted', never 'confirmed'", () => {
  const st = Core.controlStep(req(), { request_id: "r1", state: "done", ok: true, confirmed: false, pending: [{ ticker: "APA", why: "market closed" }] }, null, NOW);
  assert.equal(st.step, "submitted");
  assert.equal(st.pending[0].ticker, "APA");
});

test("control: broker error is reported as failed", () => {
  assert.equal(Core.controlStep(req(), { request_id: "r1", state: "done", ok: false, message: "failed: LMT" }, null, NOW).step, "failed");
});

test("control: workflow crashed before reporting -> failed with a warning", () => {
  const st = Core.controlStep(req(), null, { status: "completed", conclusion: "failure" }, NOW);
  assert.equal(st.step, "failed");
  assert.match(st.text, /positions may still be open/);
});

test("control: silence for too long is 'unknown', not success", () => {
  assert.equal(Core.controlStep({ ...req(), at: NOW - 7 * 60000 }, null, null, NOW).step, "unknown");
});

test("bot status priorities: liquidating > halted > paused > running > idle", () => {
  const base = { updated: new Date(NOW).toISOString(), mode: "paper" };
  const run = [{ status: "in_progress", name: "Monitor" }];
  assert.equal(Core.botStatus({ data: { ...base, state: "liquidating", state_reason: "panic" }, paused: true, runs: run, now: NOW }).key, "liquidating");
  assert.equal(Core.botStatus({ data: { ...base, state: "halted", halted: true }, paused: true, now: NOW }).key, "halted");
  assert.equal(Core.botStatus({ data: { ...base, state: "active" }, paused: true, now: NOW }).key, "paused");
  assert.equal(Core.botStatus({ data: { ...base, state: "active" }, runs: run, now: NOW }).key, "running");
  assert.equal(Core.botStatus({ data: { ...base, state: "active" }, now: NOW }).key, "idle");
  assert.equal(Core.botStatus({ data: null, now: NOW }).key, "unknown");
});

test("bot status surfaces stuck exits, missing stops, stale data and failed runs", () => {
  const s = Core.botStatus({
    data: { updated: new Date(NOW - 30 * 3600000).toISOString(), state: "active", pending_exits: [{ ticker: "APA", attempts: 2, reason: "stop-loss" }], unprotected: { SOL: "2026-10-27T12:00:00" } },
    runs: [{ status: "completed", conclusion: "failure", name: "Monitor", updated_at: new Date(NOW).toISOString() }], now: NOW,
  });
  assert.equal(s.warnings.length, 4);
  assert.match(s.warnings.join(" "), /APA.*retrying/);
});

test("last daily run error shows as error", () => {
  const s = Core.botStatus({ data: { updated: new Date(NOW).toISOString(), state: "active" }, live: { done: true, ok: false, detail: "429", updated: new Date(NOW).toISOString() }, now: NOW });
  assert.equal(s.key, "error");
});

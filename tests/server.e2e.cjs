// Server mode (v2): connect, position actions, broker-confirmed results. Mocked server, no network.
// Run: node tests/server.e2e.cjs
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const srv = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split("?")[0]); const f = path.join(root, rel === "/" ? "index.html" : rel);
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" }); fs.createReadStream(f).pipe(r);
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}/`, SERVER = "https://1-2-3-4.sslip.io";
const now = new Date().toISOString();
const status = { updated: now, mode: "paper", state: "active", stopped: false, capital: 10000, equity: 10020, return: 0.002, started: now,
  benchmarks: { SPY: -0.01 }, stats: {}, equity_curve: [], trades: [], decisions: [], pending_exits: [], unprotected: {},
  positions: [{ ticker: "ACN", qty: 2, entry: 244.84, price: 262.6, value: 525.2, pnl: 35.5, pnl_pct: 0.0725, stop: 220.36, tp: 293.81, trail_from: 269.3, on_server: true },
              { ticker: "TSLA", qty: 1, entry: 404.78, price: 408.2, value: 408.2, pnl: 3.4, pnl_pct: 0.008, stop: 371.35, tp: 471.66, trail_from: 438, on_server: true }],
  watchlist: { stocks: ["ACN", "TSLA"], crypto: [] }, paused_tickers: {},
  goals: { profile: "growth", label: "Fast growth", budget: null, notes: "" },
  profiles: { growth: { label: "Fast growth", summary: "x", sleeves: { intraday: 0.6, swing: 0.4, long_term: 0 } },
              balanced: { label: "Balanced", summary: "y", sleeves: { intraday: 0.3, swing: 0.4, long_term: 0.3 } } },
  day_trading: { active: true, share: 0.6, date: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), pnl: 12.5,
                 watch: [{ ticker: "NVDA", gap: 0.034 }], trades: [{ ticker: "NVDA", setup: "orb", qty: 10, fill: 190.1, pnl: 12.5 }],
                 backtest: { period: ["2026-09-11", "2026-11-05"], sleeve_equity: 6000, stats: { trades: 75, total_pnl: -75.34, return_on_sleeve: -0.0126, win_rate: 0.507, profit_factor: 0.85 } } },
  server: { up_since: now, last_tick: now, daily_running: false, last_error: "", streams: { stocks: "connected" } }, live: null,
  approvals: { settings: { enabled: true, minutes: 30, on_timeout: "skip" },
    pending: [{ id: "abc123def0", ticker: "NVDA", side: "buy", notional: 1200, fraction: null, rating: "Buy", price: 190.5, ai: "nvidia/x",
                reason: "agents: Buy; stop 6.0% | odds: favorable", report: "2026-11-06_NVDA.md", expires: new Date(Date.now() + 25 * 60000).toISOString(), on_timeout: "skip", status: "pending" },
              { id: "fff999aaa1", ticker: "ACN", side: "sell", notional: null, fraction: 1, rating: "Sell", price: 262.6, ai: "",
                reason: "agents: Sell", report: "", expires: new Date(Date.now() + 3 * 60000).toISOString(), on_timeout: "skip", status: "pending" }],
    recent: [{ id: "0000aaaa11", ticker: "TSLA", side: "buy", notional: 900, status: "expired", note: "no answer in time - nothing traded" }] } };
const calls = [];
(async () => {
  const b = await chromium.launch(); const page = await b.newPage(); const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.route(SERVER + "/api/**", async route => {
    const u = new URL(route.request().url()), p = u.pathname.replace("/api/", ""), body = route.request().postData();
    calls.push([p, body ? JSON.parse(body) : null]);
    const json = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
    if (p === "login") return JSON.parse(body).password === "secret-pass-1" ? json({ token: "T", days: 30 }) : json({ detail: "Wrong password." }, 401);
    if (route.request().headers().authorization !== "Bearer T") return json({ detail: "Sign in again" }, 401);
    if (p === "status" || p === "refresh") return json(status);
    if (p === "events") return json([{ time: now, kind: "fill", text: "SELL ACN 1 @ 262.63 (limit)" }]);
    if (p === "goals") return json({ saved: true });
    if (p === "orders") return json([{ symbol: "ACN", side: "sell", type: "limit", qty: 1, limit: 293.81, stop: null, oco: true, status: "new" }]);
    if (p === "approvals/abc123def0") return json({ id: "abc123def0", status: "done", confirmed: true, broker: "filled" });
    if (p === "approvals/fff999aaa1") return json({ id: "fff999aaa1", status: "denied", confirmed: true });
    if (p === "approval-settings") return json({ settings: JSON.parse(body), pending: [], recent: [] });
    if (p === "report/2026-11-06_NVDA.md") return json({ markdown: "# NVDA\n\nStrong **momentum**.<img src=x onerror=alert(1)>" });
    if (p === "action") {
      const a = JSON.parse(body);
      if (a.action === "sell_half" && a.ticker === "TSLA") return json({ detail: "TSLA has 1 share(s) - can't sell half; use Close" }, 400);
      if (a.action === "close") return json({ action: "close", confirmed: true, sold: 2, left: 0, broker: "filled" });
      if (a.action === "panic") return json({ confirmed: false, closed: ["ACN"], pending: [{ ticker: "TSLA", why: "market closed - order queued" }], errors: [] });
      return json({ confirmed: true, broker: "1 sh: take-profit @ 300.00 / stop @ 245.10" });
    }
    return json({});
  });
  const ok = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };
  await page.goto(BASE); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.click("[data-act=srv-connect]");
  await page.fill("#srvUrl", "1-2-3-4.sslip.io"); await page.fill("#srvPw", "nope"); await page.click("[data-act=srv-login]");
  await page.waitForSelector("text=Wrong password");
  ok(true, "wrong password is refused with the server's reason");
  await page.fill("#srvPw", "secret-pass-1"); await page.click("[data-act=srv-login]");
  await page.waitForSelector("text=Bot equity");
  const ls = await page.evaluate(() => JSON.stringify(localStorage));
  ok(!ls.includes("secret-pass-1") && ls.includes("srv_token"), "password not stored; session token is");
  ok(await page.isVisible("text=SELL ACN 1 @ 262.63"), "activity feed shows fills");
  // approval mode
  ok(await page.isVisible("text=Waiting for your OK · 2") && await page.isVisible("text=Buy $1,200 of NVDA"), "open proposals shown on Today");
  ok(/3 min left/.test(await page.textContent("#approvals")) && /then it's skipped/.test(await page.textContent("#approvals")), "time left and what happens without an answer");
  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 1100 }); await page.locator("#approvals").screenshot({ path: process.env.SHOTS + "/approvals.png" }); await page.setViewportSize({ width: 1280, height: 720 }); }
  await page.click("[data-act=prop-why][data-t=NVDA]");
  await page.waitForSelector("#rep >> text=momentum");
  ok(!(await page.innerHTML("#rep")).includes("onerror"), "agents' report is sanitized");
  await page.click("[data-act=close-sheet]");
  await page.click("[data-act=prop-approve][data-id=abc123def0]");
  ok(!calls.some(c => c[0].startsWith("approvals/")), "first tap on Approve only asks to confirm");
  await page.click("[data-act=prop-approve][data-id=abc123def0]");
  await page.waitForSelector("#toast >> text=confirmed by Alpaca");
  ok(calls.some(c => c[0] === "approvals/abc123def0" && c[1].decision === "approve"), "approve sent");
  await page.click("[data-act=prop-deny][data-id=fff999aaa1]");
  await page.waitForSelector("#toast >> text=nothing traded");
  ok(calls.some(c => c[0] === "approvals/fff999aaa1" && c[1].decision === "deny"), "deny is one tap");
  await page.click("nav button[data-tab=control]");
  ok(await page.isVisible("text=no answer in time - nothing traded"), "recent answers listed in Control");
  await page.selectOption("#apMin", "60"); await page.click("[data-act=appr-save][data-on='1']");
  await page.waitForTimeout(300);
  const ap = calls.filter(c => c[0] === "approval-settings").pop();
  ok(ap && ap[1].enabled === true && ap[1].minutes === 60 && ap[1].on_timeout === "skip", "approval settings saved");
  await page.click("[data-act=appr-save][data-on='0']"); await page.waitForTimeout(300);
  ok(calls.filter(c => c[0] === "approval-settings").pop()[1].enabled === false, "approval mode can be turned off");
  await page.click("nav button[data-tab=home]");
  await page.click("nav button[data-tab=positions]");
  await page.waitForSelector("text=Orders waiting at Alpaca");
  await page.waitForSelector("text=take-profit @ $293.81");
  ok(true, "open Alpaca orders listed");
  await page.click("[data-act=pos][data-t=TSLA]");
  ok(await page.isDisabled("[data-act=pos-act][data-a=sell_half]"), "sell half disabled for 1 share");
  await page.click("[data-act=close-sheet]");
  await page.click("[data-act=pos][data-t=ACN]");
  await page.click("[data-act=pos-act][data-a=close]");
  ok(!calls.some(c => c[0] === "action"), "first tap on Close only asks to confirm");
  await page.click("[data-act=pos-act][data-a=close]");
  await page.waitForSelector("text=Close: confirmed by Alpaca");
  ok(/sold 2, 0 left/.test(await page.textContent("#posResult")), "close shows what Alpaca confirmed");
  await page.click("[data-act=close-sheet]");
  await page.click("[data-act=pos][data-t=ACN]");
  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 900 }); await page.screenshot({ path: process.env.SHOTS + "/sheet.png" }); }
  await page.fill("#xStop", "245.10"); await page.fill("#xTp", "$300");
  await page.click("[data-act=pos-exits]");
  await page.waitForSelector("text=Change exits: confirmed by Alpaca");
  ok(calls.some(c => c[0] === "action" && c[1].action === "set_exits" && c[1].stop === 245.1 && c[1].tp === 300), "exits sent as numbers");
  await page.click("[data-act=close-sheet]");
  await page.click("nav button[data-tab=control]");
  await page.click("[data-act=panic]"); await page.fill("#confirm", "SELL"); await page.click("[data-act=panic-confirm]");
  await page.waitForSelector("#toast >> text=not confirmed yet");
  ok(/still open: TSLA/.test(await page.textContent("#toast")), "panic shows confirmed vs still-open");
  await page.click("nav button[data-tab=home]");
  ok(await page.isVisible("text=Day trading · 60% of the money") && await page.isVisible("text=Losing in the test so far"), "Today shows day trading + an honest backtest line");
  await page.click("nav button[data-tab=goals]");
  await page.fill("[data-sleeve=intraday]", "50"); await page.dispatchEvent("[data-sleeve=intraday]", "change");
  await page.click("[data-act=save-goals]");
  await page.waitForSelector("#toast >> text=add up to 100%");
  ok(true, "a split that isn't 100% is refused");
  await page.fill("[data-sleeve=swing]", "50"); await page.dispatchEvent("[data-sleeve=swing]", "change");
  await page.click("[data-act=save-goals]");
  await page.waitForTimeout(400);
  const g = calls.filter(c => c[0] === "goals").pop();
  ok(g && g[1].sleeves.intraday === 0.5 && g[1].sleeves.swing === 0.5 && g[1].sleeves.long_term === 0, "custom split saved");
  ok(g && g[1].day_trading === false, "day trading stays off unless switched on");
  await page.click("[data-act=toggle-day]"); await page.click("[data-act=save-goals]"); await page.waitForTimeout(400);
  ok(calls.filter(c => c[0] === "goals").pop()[1].day_trading === true, "day-trading switch saved");
  ok(errors.length === 0, "no script errors " + errors.join(" | "));
  await b.close(); srv.close();
})();

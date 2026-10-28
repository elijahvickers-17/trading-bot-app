// Browser test with a mocked GitHub API (no network, no real token). Run: node tests/ui.e2e.cjs
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split("?")[0]) === "/" ? "index.html" : decodeURIComponent(q.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".html") ? "text/html" : "application/octet-stream" });
  fs.createReadStream(f).pipe(r);
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}/`;
const TOKEN = "github_pat_TESTONLY_fake";
const now = new Date().toISOString();
const status = {
  updated: now, mode: "paper", stopped: false, state: "active", state_reason: "", halted: false, capital: 10000, equity: 9992.76, return: -0.0007,
  realized_pnl: 0, started: now, benchmarks: { SPY: 0.005 }, pending_exits: [], unprotected: {},
  stats: { closed_trades: 0, partial_exits: 0, fees_paid: 0, win_rate: null, profit_factor: null, avg_win: null, avg_loss: null, max_drawdown: 0.002 },
  positions: [{ ticker: "APA", qty: 9, entry: 51.24, price: 50.44, value: 453.9, pnl: -7.24, pnl_pct: -0.016, stop: 47.37, since: "2026-10-27" }],
  equity_curve: [[now, 10000], [now, 9992]], trades: [], closed_trades: [],
  decisions: [{ time: now, ticker: `<img src=x onerror="window.__xss=1">`, rating: "Overweight", action: "buy $476.82", report: "../../evil.md" }],
  watchlist: { stocks: ["APA", "<b>"], crypto: [] }, scout: null, goals: null, profiles: {}, risk: {},
  shadow: { ideas: 1, leader: null, bot: { trades: 1, pnl: -7.24, wins: 0, skipped_or_unfilled: 0, avg_ret: -0.016 }, agents: { trades: 0, pnl: 0, wins: 0, skipped_or_unfilled: 0, avg_ret: null },
    same_size: { n: 0 }, insights: { scored: 0 }, recent: [{ ticker: "APA", date: "2026-10-27", rating: "Overweight", plan: { entry_type: "limit", entry: 49.66, stop: 47.5, target: 56, size_usd: 300 }, bot: { status: "open", pnl: -7.24, entry: 51.24 }, agents: { status: "waiting", note: "limit $49.66 not reached yet (0 of 5 days)" } }], note: "Small sample" },
};
let dispatchStatus = 204, controlReport = null, dispatched = [], monitorRun = null;
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.route("https://api.github.com/**", async route => {
    const u = route.request().url(), auth = route.request().headers().authorization;
    if (auth !== `Bearer ${TOKEN}`) return route.fulfill({ status: 401, body: "Bad credentials" });
    if (u.includes("monitor.yml/dispatches")) { monitorRun = { created_at: new Date().toISOString(), status: "completed", conclusion: "success" }; status.positions[0].price = 52.5; status.updated = new Date().toISOString(); return route.fulfill({ status: 204, body: "" }); }
    if (u.includes("monitor.yml/runs")) return route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: monitorRun ? [monitorRun] : [] }) });
    if (u.includes("/dispatches")) { dispatched.push(JSON.parse(route.request().postData())); return route.fulfill({ status: dispatchStatus, body: dispatchStatus === 204 ? "" : "Resource not accessible by personal access token" }); }
    if (u.includes("journal/status.json")) return route.fulfill({ status: 200, body: JSON.stringify(status) });
    if (u.includes("journal/control.json")) return controlReport ? route.fulfill({ status: 200, body: JSON.stringify(controlReport) }) : route.fulfill({ status: 404, body: "" });
    if (u.includes("/contents/STOP") || u.includes("live.json") || u.includes("timemachine")) return route.fulfill({ status: 404, body: "" });
    if (u.includes("runs")) return route.fulfill({ status: 200, body: JSON.stringify({ workflow_runs: [] }) });
    return route.fulfill({ status: 200, body: "{}" });
  });
  const ok = (c, m) => { if (!c) { console.log("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };

  // 1. migration from a plain-text token
  await page.goto(BASE);
  await page.evaluate(t => { localStorage.clear(); localStorage.setItem("gh_token", t); }, TOKEN);
  await page.reload();
  ok(await page.isVisible("text=Protect your token"), "old plain-text token triggers the PIN screen");
  await page.fill("#pin", "482913"); await page.fill("#pin2", "482913");
  await page.click("[data-act=secure]");
  await page.waitForSelector("text=Bot equity");
  const ls = await page.evaluate(() => JSON.stringify(localStorage));
  ok(!ls.includes(TOKEN) && ls.includes("gh_vault"), "token stored encrypted only, plain copy removed");

  // 2. reload -> locked; wrong PIN rejected; right PIN unlocks
  await page.reload();
  ok(await page.isVisible("text=Unlock"), "reopening the app asks for the PIN");
  await page.fill("#pin", "000000"); await page.click("[data-act=unlock]");
  await page.waitForTimeout(400);
  ok(await page.isVisible("text=Unlock"), "wrong PIN stays locked");
  await page.fill("#pin", "482913"); await page.click("[data-act=unlock]");
  await page.waitForSelector("text=Bot equity");
  ok(true, "right PIN unlocks");

  // 2b. refresh prices from Today
  ok(await page.isVisible("text=Refresh prices"), "Today shows a Refresh prices button");
  ok(await page.isVisible(".card.list >> text=APA"), "Today lists the holdings");
  await page.click("[data-act=refresh-prices]");
  await page.waitForSelector("text=Prices updated", { timeout: 15000 });
  ok(/52\.50/.test(await page.textContent("main")), "after refresh the new APA price shows");
  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 900 }); await page.screenshot({ path: process.env.SHOTS + "/today.png" }); }

  // 3. hostile values from the API are shown as text, never run
  await page.click("nav button[data-tab=decisions]");
  await page.waitForTimeout(300);
  ok(!(await page.evaluate(() => window.__xss)), "HTML in a ticker is escaped, not executed");
  ok(await page.isVisible("text=A/B test · agents' plan vs bot"), "A/B card shows on the Agents tab");
  await page.click("[data-act=report]");
  await page.waitForTimeout(300);
  ok(!(await page.isVisible("text=Loading the agents")), "report link with a bad path is refused, not fetched");

  // 4. panic: dispatch refused -> clear failure, nothing claimed
  await page.click("[data-act=close-sheet]");
  await page.click("nav button[data-tab=control]");
  dispatchStatus = 403;
  await page.click("[data-act=panic]"); await page.fill("#confirm", "SELL"); await page.click("[data-act=panic-confirm]");
  await page.waitForSelector(".ctl");
  const t1 = await page.textContent(".ctl");
  ok(/Failed/.test(t1) && /Nothing was sold/.test(t1) && /Actions: Read and write/.test(t1), "refused dispatch shows Failed + why + nothing sold");
  await page.click("[data-act=ctl-dismiss]");

  // 5. panic: accepted -> requested -> running -> submitted (market closed) 
  dispatchStatus = 204;
  await page.click("[data-act=panic]"); await page.fill("#confirm", "SELL"); await page.click("[data-act=panic-confirm]");
  await page.waitForSelector(".ctl");
  ok(/Requested/.test(await page.textContent(".ctl")), "accepted dispatch shows Requested");
  const id = dispatched[dispatched.length - 1].inputs.request_id;
  ok(dispatched[dispatched.length - 1].inputs.action === "panic" && id, "dispatch carries action + request id");
  controlReport = { request_id: id, state: "running" };
  await page.waitForFunction(() => /Running on GitHub/.test(document.querySelector(".ctl")?.textContent || ""), null, { timeout: 8000 });
  ok(true, "then Running");
  controlReport = { request_id: id, state: "done", ok: true, confirmed: false, closed: [], pending: [{ ticker: "APA", why: "market closed - order queued for the next open" }], errors: [], message: "still open: APA (market closed)" };
  await page.waitForFunction(() => /not all confirmed/.test(document.querySelector(".ctl")?.textContent || ""), null, { timeout: 8000 });
  ok(/APA \(market closed/.test(await page.textContent(".ctl")), "then 'orders sent, not confirmed' listing APA, not success");

  if (process.env.SHOTS) { await page.setViewportSize({ width: 390, height: 1100 }); await page.screenshot({ path: process.env.SHOTS + "/control.png" });
    await page.click("nav button[data-tab=decisions]"); await page.waitForTimeout(300); await page.screenshot({ path: process.env.SHOTS + "/agents.png" }); }
  ok(errors.filter(e => !/401|404|Failed to load resource/.test(e)).length === 0, "no script or CSP errors: " + errors.join(" | "));
  await b.close(); srv.close();
})();

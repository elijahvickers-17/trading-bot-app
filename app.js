// Desk: the phone app for the trading bot. Reads journal/status.json etc. from the GitHub
// repo and starts workflows. All HTML from data goes through Core.esc; the agents' Markdown
// reports go through DOMPurify. No inline event handlers: every button has a data-act and
// one delegated listener runs it (lets the page use a strict Content-Security-Policy).
"use strict";
(function () {
  const { esc, usd, pct, prob, sign, ago, GhError, explain } = Core;
  const $ = s => document.querySelector(s);
  const store = {
    get(k, d = "") { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // The token is only ever in this variable (memory). Storage holds the PIN-encrypted vault.
  let cfg = { token: "", repo: store.get("gh_repo", "elijahvickers-17/trading-bot") };
  const legacyToken = store.get("gh_token");            // from older versions: plain text, migrate it
  let live = null, pollTimer = null, ctlTimer = null, ctlReport = null, ctlRuns = [];
  let data = null, paused = false, runs = [], tab = store.get("tab", "home"), oddsCache = {}, loadError = "";
  let ctlReq = (() => { try { return JSON.parse(store.get("ctl_req") || "null"); } catch { return null; } })();
  let draft = null;
  let refreshing = null;   // {at, note} while a price refresh is running

  function toast(msg, ms = 3600) { const t = $("#toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", ms); }

  async function gh(path, opts = {}) {
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${cfg.repo}` + (path ? `/${path}` : ""), {
        method: opts.method || "GET", body: opts.body,
        headers: { Authorization: `Bearer ${cfg.token}`, Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        cache: "no-store", referrerPolicy: "no-referrer",
      });
    } catch (e) { throw new GhError(0, e.message, path); }
    if (r.status === 404 && opts.allow404) return null;
    if (!r.ok) throw new GhError(r.status, await r.text().catch(() => ""), path);
    if (r.status === 204) return true;
    return opts.raw ? r.text() : r.json();
  }

  async function load() {
    try {
      const [status, stop, rr, lv] = await Promise.all([
        gh("contents/journal/status.json", { raw: true, allow404: true }),
        gh("contents/STOP", { allow404: true }),
        gh("actions/runs?per_page=10").catch(() => ({ workflow_runs: [] })),
        gh("contents/journal/live.json", { raw: true, allow404: true }).catch(() => null),
      ]);
      data = status ? JSON.parse(status) : null;
      try { live = lv ? JSON.parse(lv) : null; } catch { live = null; }
      paused = !!stop;
      runs = rr.workflow_runs || [];
      store.set("cache", status || "");
      loadError = "";
    } catch (e) {
      const c = store.get("cache"); if (c) { try { data = JSON.parse(c); } catch {} }
      loadError = explain(e, "Refreshing") + (data ? " Showing the last saved copy." : "");
      if (e.status === 401) { cfg.token = ""; }
    }
    render();
    clearTimeout(pollTimer);
    if (runs.some(r => r.status !== "completed") && cfg.token) pollTimer = setTimeout(() => { if (!document.hidden) load(); }, 15000);
  }

  // ---- header + status ---------------------------------------------------------------
  function header() {
    const m = $("#mode");
    const s = Core.botStatus({ data, paused, runs, live });
    m.textContent = s.label;
    m.className = "pill" + (s.tone ? " " + s.tone : "");
  }

  function statusCard(compact) {
    const s = Core.botStatus({ data, paused, runs, live });
    const showDetail = !compact || ["liquidating", "halted", "paused", "error", "cautious"].includes(s.key);
    return `${loadError ? `<div class="card warnbox">${esc(loadError)}</div>` : ""}
      ${showDetail && s.detail ? `<div class="card status ${esc(s.key)}"><div class="row"><span class="label">Bot status</span><span class="pill ${esc(s.tone)}">${esc(s.label)}</span></div><p style="margin:8px 0 0">${esc(s.detail)}</p></div>` : ""}
      ${s.warnings.map(w => `<div class="card warnbox">${esc(w)}</div>`).join("")}
      ${controlCard()}`;
  }

  function equityChart(points, w = 520, h = 120) {
    if (!points || points.length < 2) return `<div class="empty">The chart fills in after a few runs.</div>`;
    const v = points.map(p => +p[1]), lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
    const xy = v.map((y, i) => [i * w / (v.length - 1), h - 6 - (y - lo) / span * (h - 12)]);
    const line = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    const col = v[v.length - 1] >= v[0] ? "var(--up)" : "var(--down)";
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="Equity over time">
      <path d="${line} L${w} ${h} L0 ${h}Z" fill="${col}" opacity=".08"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
      <div class="row note"><span>${usd(lo, 0)} low</span><span>${usd(hi, 0)} high</span></div>`;
  }

  const mins = iso => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  const ICON = { waiting: "○", analyzing: "●", done: "●", failed: "✕" };
  const COLOR = { done: "var(--up)", failed: "var(--down)", analyzing: "var(--accent)" };
  const planList = plan => (plan || []).map(p => `<div class="row planrow">
      <span><b style="color:${COLOR[p.status] || "var(--ink3)"}">${ICON[p.status] || "○"}</b> ${esc(p.ticker)}</span>
      <span class="muted" style="text-align:right;max-width:70%">${p.status === "analyzing" ? esc(p.result || "working…") : esc(p.result || p.status)}</span></div>`).join("");

  function running() {
    const r = runs.find(r => r.status !== "completed");
    if (!r) return "";
    const started = r.run_started_at || r.created_at;
    if (r.name !== "Daily analysis")
      return `<div class="card row"><span><span class="tag">Running</span> ${esc(r.name)}</span><span class="muted">${esc(ago(started))}</span></div>`;
    const mine = live && String(live.run_id) === String(r.id) && !live.done;
    if (!mine) return `<div class="card"><div class="row"><span><span class="tag">Running</span> Daily analysis</span><span class="muted">${mins(started)} min</span></div>
        <p style="margin:10px 0 0">${r.status === "queued" ? "Waiting for a GitHub server…" : "Starting up: installing the AI tools (about 1–2 minutes)…"}</p>
        <p class="note">Updates every 15 seconds.</p></div>`;
    const doneN = (live.plan || []).filter(p => p.status === "done" || p.status === "failed").length;
    const total = (live.plan || []).length;
    const width = total ? Math.round(100 * doneN / total) : 5;
    const stale = mins(live.updated) >= 6;
    return `<div class="card"><div class="row"><span><span class="tag">Running</span> Daily analysis</span><span class="muted">${mins(started)} min</span></div>
      <div style="font:600 17px var(--sans);margin-top:10px">${esc(live.stage)}</div>
      ${live.detail ? `<div class="muted" style="font-size:14px;margin-top:2px">${esc(live.detail)}</div>` : ""}
      ${total ? `<div class="bar" style="margin:12px 0 4px"><i style="width:${width}%;background:var(--accent)"></i></div><div class="note" style="margin-top:0">${doneN} of ${total} reviewed · each takes a few minutes</div>` : ""}
      ${planList(live.plan)}
      <p class="note">Last update ${esc(ago(live.updated))}${stale ? " — slow step (the AI may be busy and retrying); it's still running" : ""}. Refreshes every 15 seconds.</p></div>`;
  }

  function lastRun() {
    if (!live || !live.done || runs.some(r => r.status !== "completed" && r.name === "Daily analysis")) return "";
    return `<details class="card"><summary class="row" style="cursor:pointer;list-style:none"><span><span class="label">Last daily run</span><br><b>${live.ok ? "Finished" : "Stopped with an error"}</b> · ${esc(ago(live.updated))}</span><span class="muted">${esc(live.detail || "")}</span></summary>
      ${planList(live.plan)}
      <div class="label" style="margin-top:12px">Step by step</div>
      ${(live.steps || []).map(s => `<div style="font-size:13px;padding:3px 0"><span class="muted num">${esc((s.time || "").slice(11, 16))}</span> ${esc(s.text)}</div>`).join("")}</details>`;
  }

  // ---- A/B: agents' plan vs the bot -----------------------------------------------
  function abCard(full) {
    const s = data && data.shadow;
    if (!s) return full ? `<div class="card"><div class="label">A/B test</div><p class="note">Starts with the next Buy/Overweight call: the agents' own plan (limit entry, stop, target, size) is simulated on real prices next to the bot's real trade.</p></div>` : "";
    const lead = s.leader === "agents" ? "The agents' plan is ahead" : s.leader === "bot" ? "The bot's way is ahead" : s.leader === "tie" ? "Even so far" : "No finished comparison yet";
    const arm = (name, a) => `<div class="stat"><div class="label">${name}</div><div class="v ${sign(a.pnl)}">${usd(a.pnl)}</div>
      <div class="s">${a.trades} trade${a.trades === 1 ? "" : "s"} · ${a.wins} win${a.wins === 1 ? "" : "s"}${a.skipped_or_unfilled ? ` · ${a.skipped_or_unfilled} not filled/skipped` : ""}${a.avg_ret != null ? ` · avg ${pct(a.avg_ret)}` : ""}</div></div>`;
    const ins = s.insights || {};
    const row = i => {
      const ag = i.agents || {}, bo = i.bot || {}, p = i.plan || {};
      return `<div class="item"><div class="row"><span class="tk">${esc(i.ticker)}</span><span class="muted num">${esc(i.date)} · ${esc(i.rating)}</span></div>
        <div class="note" style="margin-top:4px">Agents' plan: ${p.entry_type === "limit" ? `limit ${usd(p.entry)}` : "buy at market"} · stop ${p.stop ? usd(p.stop) : "bot's"} · target ${p.target ? usd(p.target) : "bot's"} · ${p.size_usd ? usd(p.size_usd, 0) : "bot's size"}</div>
        <div class="row" style="font-size:13px;margin-top:6px"><span>Bot: <b class="${sign(bo.pnl)}">${bo.pnl != null ? usd(bo.pnl) : "—"}</b> <span class="muted">${esc(bo.status)}${bo.entry ? ` @ ${usd(bo.entry)}` : ""}</span></span>
          <span>Agents: <b class="${sign(ag.pnl)}">${ag.pnl != null ? usd(ag.pnl) : "—"}</b> <span class="muted">${esc(ag.status)}</span></span></div>
        <div class="note">${esc(ag.note || ag.exit_why || ag.entry_how || "")}</div></div>`;
    };
    return `<div class="card"><div class="row"><span class="label">A/B test · agents' plan vs bot</span><span class="muted">${s.ideas} idea${s.ideas === 1 ? "" : "s"}</span></div>
      <div style="font:600 18px var(--sans);margin:8px 0">${esc(lead)}</div>
      <div class="grid">${arm("Bot (real trades)", s.bot)}${arm("Agents' plan (simulated)", s.agents)}</div>
      ${s.same_size && s.same_size.n ? `<p class="note">Same dollars in each: bot ${usd(s.same_size.bot)} vs agents ${usd(s.same_size.agents)} over ${s.same_size.n} idea${s.same_size.n === 1 ? "" : "s"}.</p>` : ""}
      ${ins.scored ? `<p class="note">Were the calls right? ${ins.correct} of ${ins.scored} ratings pointed the right way 5 trading days later${ins.avg_excess_bullish != null ? `; bullish calls averaged ${pct(ins.avg_excess_bullish)} vs SPY` : ""}.</p>` : ""}
      ${full ? `<div class="list" style="margin-top:8px">${(s.recent || []).map(row).join("")}</div>` : ""}
      <p class="note">${esc(s.note || "")} The agents' side is simulated conservatively (limit starts the next day, stop counts first on a day that hits both, costs and fees included). Nothing is ordered for it.</p></div>`;
  }

  // ---- views ---------------------------------------------------------------------------
  // ---- refresh prices: runs the Monitor workflow (live Alpaca prices + stop checks) --
  function refreshBar() {
    const when = data && data.updated ? new Date(data.updated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    return `<div class="refresh row"><span class="muted" style="font-size:13px">${refreshing
        ? `<span class="spin"></span> ${esc(refreshing.note)}`
        : `Prices as of <b>${esc(when)}</b> · ${esc(ago(data && data.updated))}`}</span>
      <button class="chip" data-act="refresh-prices" ${refreshing ? "disabled" : ""}>${refreshing ? "Updating…" : "↻ Refresh prices"}</button></div>`;
  }

  async function refreshPrices() {
    if (refreshing) return;
    const daily = runs.find(r => r.status !== "completed" && r.name === "Daily analysis");
    refreshing = { at: Date.now(), note: daily ? "Analysis is running; prices refresh right after it finishes…" : "Getting live prices from Alpaca (about a minute)…" };
    render();
    try {
      const busy = (await gh("actions/workflows/monitor.yml/runs?per_page=1")).workflow_runs?.[0];
      if (!(busy && busy.status !== "completed")) await gh("actions/workflows/monitor.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main" }) });
    } catch (e) { refreshing = null; render(); return toast(explain(e, "Refreshing prices"), 8000); }
    const limit = refreshing.at + (daily ? 90 : 5) * 60000;
    const tick = async () => {
      if (!refreshing) return;
      try {
        const r = (await gh("actions/workflows/monitor.yml/runs?per_page=3")).workflow_runs || [];
        const mine = r.find(x => new Date(x.created_at) >= refreshing.at - 120000);
        if (mine && mine.status === "completed") {
          refreshing = null;
          await load();
          return toast(mine.conclusion === "success" ? "Prices updated" : "The price check failed on GitHub. Showing the last saved prices.", 5000);
        }
        if (mine && mine.status !== "queued" && !daily) { refreshing.note = "Reading prices and checking stops…"; render(); }
      } catch {}
      if (Date.now() > limit) { refreshing = null; render(); return toast("Still waiting on GitHub. Pull down to reload in a minute.", 6000); }
      setTimeout(tick, 5000);
    };
    setTimeout(tick, 6000);
  }

  function miniHoldings() {
    const ps = data.positions || [];
    if (!ps.length) return "";
    const total = ps.reduce((a, p) => a + (+p.pnl || 0), 0);
    return `<div class="card list"><div class="row" style="padding-bottom:6px"><span class="label">Holdings</span><span class="num ${sign(total)}">${usd(total)} open</span></div>
      ${ps.map(p => `<button class="item rowbtn" data-act="go" data-tab="positions"><div class="row"><span class="tk">${esc(p.ticker)}</span>
        <span class="num ${sign(p.pnl)}">${usd(p.pnl)} · ${pct(p.pnl_pct)}</span></div>
        <div class="row muted num" style="font-size:12.5px;margin-top:2px"><span>${esc(+p.qty)} @ ${usd(p.entry)} → ${usd(p.price)}</span><span>stop ${usd(p.stop)}</span></div></button>`).join("")}</div>`;
  }

  function viewHome() {
    if (!data) return `${statusCard()}${running()}<div class="card empty">No results yet. The first run writes them — or press <b>Run analysis now</b> in Control.</div>`;
    const s = data.stats || {}, b = Object.entries(data.benchmarks || {});
    const beat = b.filter(([, r]) => r != null);
    const regimes = data.scout && data.scout.regimes;
    return `
    ${statusCard(true)}
    ${running()}
    <div class="hero">
      <div class="label">Bot equity · since ${esc(new Date(data.started).toLocaleDateString())}</div>
      <div class="big">${usd(data.equity)}</div>
      <div class="delta ${sign(data.return)}">${pct(data.return)} · ${usd(data.equity - data.capital)}</div>
      ${refreshBar()}
      ${data.goals ? `<div style="margin-top:10px"><button class="chip" data-act="go" data-tab="goals">Goal: ${esc(data.goals.label)} · ${usd(data.capital, 0)} budget</button></div>` : ""}
      ${regimes && regimes.stocks ? `<div class="chips">${["stocks", "crypto"].map(k => { const r = regimes[k]; if (!r) return ""; const c = r.state === "risk_on" ? "var(--up)" : r.state === "risk_off" ? "var(--down)" : "var(--warn)";
        return `<span class="chip" style="border-color:${c}" title="${esc(r.why)}"><b style="color:${c}">●</b> ${k === "stocks" ? "Stocks" : "Crypto"}: ${esc(String(r.state).replace("_", " "))}</span>`; }).join("")}</div>` : ""}
    </div>
    <div class="card">${equityChart(data.equity_curve)}</div>
    ${miniHoldings()}
    <div class="label" style="margin:16px 0 8px">Versus just holding</div>
    <div class="grid">
      ${beat.map(([k, r]) => `<div class="stat"><div class="label">${esc(k)}</div><div class="v ${sign(r)}">${pct(r)}</div>
        <div class="s">${Math.abs(data.return - r) < 0.0005 ? "Bot is even with it" : (data.return > r ? "Bot is ahead" : "Bot is behind") + " by " + prob(Math.abs(data.return - r), 2)}</div></div>`).join("")}
    </div>
    ${!(data.positions || []).length && !s.closed_trades ? `<p class="note">The bot hasn't bought anything yet, so it's all cash at 0%. Any "ahead" or "behind" here is just the market moving, not the bot's skill.</p>` : ""}
    ${abCard(false)}
    <div class="label" style="margin:16px 0 8px">Scorecard · completed trades, after fees</div>
    <div class="grid">
      <div class="stat"><div class="label">Win rate</div><div class="v">${s.win_rate == null ? "—" : Math.round(s.win_rate * 100) + "%"}</div><div class="s">${s.closed_trades || 0} completed${s.partial_exits ? ` · ${s.partial_exits} partial exit${s.partial_exits === 1 ? "" : "s"}` : ""}</div></div>
      <div class="stat"><div class="label">Profit factor</div><div class="v">${s.profit_factor == null ? "—" : (+s.profit_factor).toFixed(2)}</div><div class="s">wins ÷ losses ($)</div></div>
      <div class="stat"><div class="label">Avg win / loss</div><div class="v" style="font-size:17px">${usd(s.avg_win, 0)} / ${usd(s.avg_loss, 0)}</div><div class="s">fees paid ${usd(s.fees_paid || 0)}</div></div>
      <div class="stat"><div class="label">Worst drop</div><div class="v down">${pct(-(s.max_drawdown || 0))}</div><div class="s">peak to trough</div></div>
    </div>
    <p class="note">Updated ${esc(ago(data.updated))}. ${(s.closed_trades || 0) < 20 ? "Under 20 completed trades: too few to judge the win rate yet." : ""}</p>`;
  }

  function exitsLine(p) {
    if (p.tp == null && p.trail_from == null) return "";
    const parts = [];
    if (p.tp != null) parts.push(`Take profit ${usd(p.tp)} (½)`);
    else if (p.tp_taken) parts.push("½ profit taken");
    parts.push(p.trail_on ? `<b class="up">Trailing on</b> · locked ${usd(p.locked_stop)}` : `Trailing from ${usd(p.trail_from)}`);
    return `<div class="row" style="margin-top:4px;font-size:12.5px"><span class="muted">${parts.join(" · ")}</span>
      <span class="muted">${p.on_server ? "on Alpaca" : "checked by bot"}</span></div>`;
  }

  function viewPositions() {
    if (!data) return `<div class="empty">Nothing yet.</div>`;
    const ps = data.positions || [];
    const invested = ps.reduce((a, p) => a + (+p.value || 0), 0);
    const pend = Object.fromEntries((data.pending_exits || []).map(p => [p.ticker, p]));
    const unprot = data.unprotected || {};
    return `
    ${statusCard(true)}
    <div class="hero"><div class="label">Invested</div><div class="big">${usd(invested, 0)}</div>
      <div class="delta muted">${usd(data.equity - invested, 0)} in cash · ${ps.length} position${ps.length === 1 ? "" : "s"}</div>
      ${refreshBar()}</div>
    <div class="card list">${ps.length ? ps.map(p => {
      const toStop = 1 - p.stop / p.price;
      return `<div class="item">
        <div class="row"><span class="tk">${esc(p.ticker)}</span><span class="num ${sign(p.pnl)}">${usd(p.pnl)} · ${pct(p.pnl_pct)}</span></div>
        <div class="row muted num" style="font-size:12.5px;margin-top:3px"><span>${esc((+p.qty).toLocaleString(undefined, { maximumFractionDigits: 6 }))} @ ${usd(p.entry)}</span><span>now ${usd(p.price)}</span></div>
        <div class="row" style="margin-top:8px;font-size:12.5px"><span class="${unprot[p.ticker] ? "down" : "muted"}">${unprot[p.ticker] ? "No server stop right now (retrying)" : `Stop ${usd(p.stop)} · ${prob(toStop, 1)} below`}</span><span class="muted">${p.tp_taken ? "½ profit taken · " : ""}since ${esc(p.since || "—")}</span></div>
        ${exitsLine(p)}
        ${pend[p.ticker] ? `<div class="note warn">Sell in progress: ${esc(pend[p.ticker].reason)} · try ${esc(pend[p.ticker].attempts)}</div>` : ""}
      </div>`;
    }).join("") : `<div class="empty">No open positions.</div>`}</div>
    <div class="label" style="margin:18px 0 8px">Recent trades</div>
    <div class="card list">${(data.trades || []).slice(0, 30).map(t => {
      const failed = /error|skipped|cancel/i.test(t.status || "");
      return `<div class="item">
       <div class="row"><span><b>${esc(String(t.side || "").toUpperCase())}</b> ${esc(t.ticker)}${t.exit_type ? ` <span class="pill">${t.exit_type === "full" ? "closed" : "partial"}</span>` : ""}</span><span class="num ${sign(t.realized_pnl)}">${t.realized_pnl != null ? usd(t.realized_pnl) : t.price ? usd(t.price) : ""}</span></div>
       <div class="row muted" style="font-size:12.5px"><span>${esc(t.reason)}${t.fees ? ` · fees ${usd(t.fees)}` : ""}</span><span>${esc((t.time || "").slice(5, 16))}</span></div>
       ${failed || (t.status && t.status !== "filled") ? `<div class="note ${failed ? "down" : ""}">Broker: ${esc(t.status)}</div>` : ""}</div>`;
    }).join("") || `<div class="empty">No trades yet.</div>`}</div>
    <p class="note">Realized P&amp;L is net of estimated fees (SEC/FINRA on stock sells, 0.25% on crypto). "partial" = some shares sold, position still open.</p>`;
  }

  function viewDecisions() {
    if (!data) return `<div class="empty">Nothing yet.</div>`;
    const ds = data.decisions || [];
    const sc = data.scout;
    const scoutCard = sc ? `<div class="card"><div class="row"><span class="label">Today's research</span><span class="pill">${esc(sc.screen || "")}</span></div>
        ${sc.error ? `<p class="note">Scout failed: ${esc(sc.error)}. Holdings were still reviewed.</p>` : ""}
        ${(sc.picks || []).map(p => `<div style="margin-top:10px"><span class="tk">${esc(p.ticker)}</span><div class="muted" style="font-size:13.5px">${esc(p.why)}</div></div>`).join("") || `<p class="note">No new candidates today.</p>`}
        ${sc.market_note ? `<p class="note">${esc(sc.market_note)}</p>` : ""}
        <p class="note">${sc.method === "scores" ? "Picked by screen score (AI pick unavailable)." : "Picked by the AI research lead"} from ${(sc.shortlist || []).length} shortlisted of the S&amp;P 500 + crypto · ${esc(sc.date || "")}.</p></div>` : "";
    return `<div class="hero"><div class="label">Agent team</div><div style="font:600 22px var(--sans)">Scout → analysts → bull vs bear → trader → risk team</div>
      <p class="note">The scout picks what fits your goal; the team analyzes it with 30 days of news. Tap a decision for the full reasoning.</p></div>
    ${running()}${lastRun()}
    ${abCard(true)}
    ${scoutCard}
    <div class="card list">${ds.map((d, i) => `<button class="item rowbtn" data-act="report" data-i="${i}">
       <div class="row"><span class="tk">${esc(d.ticker)}</span><span class="rating ${esc((d.rating || "").toLowerCase())}">${esc(d.rating)}</span></div>
       <div class="row" style="font-size:13px;margin-top:4px"><span>${d.action === "none" ? `<span class="muted">${esc(d.detail || "no trade")}</span>` : `<b>${esc(d.action)}</b>`}</span></div>
       ${d.tm_verdict ? `<div style="font-size:12.5px;margin-top:4px" class="muted">Time Machine: ${esc(d.tm_verdict)}</div>` : ""}
       <div class="muted" style="font-size:12px;margin-top:4px">${esc((d.time || "").slice(0, 16))}${d.minutes ? ` · ${esc(d.minutes)} min` : ""}${d.ai ? ` · AI: ${esc(d.ai)}` : ""}</div></button>`).join("") || `<div class="empty">No decisions yet.</div>`}</div>`;
  }

  async function openReport(i) {
    const d = (data.decisions || [])[i];
    if (!d) return;
    const date = (d.time || "").slice(0, 10);
    sheet(`<div class="label">${esc(date)}</div><h2 style="margin:6px 0">${esc(d.ticker)} · <span class="rating ${esc((d.rating || "").toLowerCase())}">${esc(d.rating)}</span></h2>
      ${d.tm_summary ? `<div class="card" style="font-size:13.5px"><span class="tag">Time Machine</span><p style="margin:8px 0 0">${esc(d.tm_summary)}</p></div>` : ""}
      <div id="rep" class="md"><p class="muted">Loading the agents' reasoning…</p></div>`);
    if (!d.report || !/^[\w.-]+\.md$/.test(d.report)) { $("#rep").innerHTML = `<p class="muted">${esc(d.detail || "No report saved.")}</p>`; return; }
    try {
      const md = await gh(`contents/reports/${encodeURIComponent(d.report)}`, { raw: true });
      $("#rep").innerHTML = DOMPurify.sanitize(marked.parse(md), { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style"] });
    } catch (e) { $("#rep").innerHTML = `<p class="muted">${esc(explain(e, "Loading the report"))}</p>`; }
  }

  function oddsBars(o) {
    if (!o) return "";
    const w = v => Math.max(0, Math.min(100, (+v || 0) * 100)).toFixed(1);
    const seg = (v, c) => `<i style="width:${w(v)}%;background:${c}"></i>`;
    return `<div class="bar" style="margin:8px 0 6px">${seg(o.p_target, "var(--up)")}${seg(o.p_trail, "color-mix(in srgb,var(--up) 45%,var(--chip))")}${seg(o.p_open_at_end, "var(--ink3)")}${seg(o.p_stop, "var(--down)")}</div>
    <div class="row num" style="font-size:12px;flex-wrap:wrap"><span class="up">target ${prob(o.p_target)}</span><span>trail ${prob(o.p_trail)}</span><span class="muted">still open ${prob(o.p_open_at_end)}</span><span class="down">stop ${prob(o.p_stop)}</span></div>
    <div class="row num" style="font-size:12.5px;margin-top:6px"><span>profit in <b>${prob(o.p_profit)}</b></span><span>avg <b class="${sign(o.mean)}">${pct(o.mean)}</b></span><span class="muted">5–95%: ${pct(o.p5, 1)} … ${pct(o.p95, 1)}</span></div>`;
  }

  function viewOdds() {
    const tickers = data && data.watchlist ? [...data.watchlist.stocks, ...data.watchlist.crypto].filter(t => Core.TICKER.test(t)) : [];
    const sel = tickers.includes(store.get("odds_sel")) ? store.get("odds_sel") : tickers[0] || "";
    const o = oddsCache[sel];
    const verdictTag = v => `<span class="tag" style="background:${v === "favorable" ? "var(--up)" : v === "unfavorable" ? "var(--down)" : "var(--ink)"}">${esc(v)}</span>`;
    setTimeout(() => sel && !oddsCache[sel] && loadOdds(sel), 0);
    const r = o && o.rules;
    return `<div class="hero"><div class="label">Time Machine</div><div style="font:600 22px var(--sans)">Odds before any money goes in</div>
       <p class="note">10,000 replays of each asset's own last year, plus every real day of the last two years, run through the bot's exact stop, take-profit and trailing rules, after costs on entry and exit.</p></div>
     <div class="sparkgrid">${tickers.map(t => `<button class="spark ${t === sel ? "sel" : ""}" data-act="odds" data-t="${esc(t)}"><div class="label" style="color:var(--ink)">${esc(t.replace("-USD", ""))}</div>
        <div class="muted" style="font-size:11.5px">${esc(oddsCache[t] && oddsCache[t].verdict || "tap")}</div></button>`).join("")}</div>
     <div class="card">${!sel ? `<div class="empty">No watchlist yet.</div>` : !o ? `<div class="empty">Loading ${esc(sel)}…</div>` : o.missing ? `<div class="empty">No odds for ${esc(sel)} yet. They're computed when the agents want to buy it.</div>` : `
       <div class="row"><span class="tk">${esc(sel)}</span>${verdictTag(o.verdict)}</div>
       <div class="label" style="margin-top:14px">10,000 replays</div>${oddsBars(o.monte_carlo)}
       ${o.history_similar ? `<div class="label" style="margin-top:16px">History · ${esc(o.history_similar.days)} days that looked like today</div>${oddsBars(o.history_similar)}` : ""}
       ${o.history ? `<div class="label" style="margin-top:16px">History · all ${esc(o.history.days)} days</div>${oddsBars(o.history)}` : ""}
       ${r ? `<p class="note">Rules tested: stop −${(r.stop * 100).toFixed(0)}%, sell half at +${(r.target * 100).toFixed(0)}%, trail ${(r.trail * 100).toFixed(0)}% after +${(r.trail_activate * 100).toFixed(0)}%, ${esc(r.horizon)}-day horizon. A replay of the past, not a prediction.</p>` : ""}`}
     </div>`;
  }
  async function loadOdds(t) {
    try {
      const raw = await gh(`contents/journal/timemachine/${encodeURIComponent(t)}.json`, { raw: true, allow404: true });
      oddsCache[t] = raw ? JSON.parse(raw) : { missing: true };
    } catch { oddsCache[t] = { missing: true }; }
    if (tab === "odds") render();
  }

  function viewGoals() {
    if (!data || !data.profiles) return `<div class="empty">Goals appear after the bot's first run.</div>`;
    const g = data.goals || {};
    draft = draft || { profile: g.profile || "growth", budget: g.budget ?? "", notes: g.notes || "" };
    return `<div class="hero"><div class="label">Your goals</div><div style="font:600 22px var(--sans)">Tell the bot what you're investing for</div>
      <p class="note">Your strategy sets the hard risk rules. Your own words go to the AI agents with every analysis, so their calls fit your situation. Change it any time.</p></div>
    ${controlCard()}
    <div class="label" style="margin-top:6px">Strategy</div>
    ${Object.entries(data.profiles).map(([k, p]) => `<button class="opt ${draft.profile === k ? "on" : ""}" data-act="profile" data-k="${esc(k)}"><b>${esc(p.label)}</b><span>${esc(p.summary)}</span></button>`).join("")}
    <div class="label" style="margin-top:16px">Budget for the bot</div>
    <input id="gBudget" data-bind="budget" inputmode="decimal" placeholder="${esc(usd(data.capital, 0))} (current)" value="${esc(draft.budget)}">
    <div class="label">In your own words</div>
    <textarea id="gNotes" data-bind="notes" maxlength="1500" placeholder="e.g. I'm a student putting in a small amount to learn and grow it fast. I can handle swings but don't want to lose more than half.">${esc(draft.notes)}</textarea>
    <p class="note" style="margin-top:-4px">Don't include account numbers or passwords; this text is sent to the AI.</p>
    <button class="btn" data-act="save-goals">Save goals</button>
    ${g.updated ? `<p class="note">Current: ${esc(g.label)}${g.budget ? ` · ${usd(g.budget, 0)}` : ""} · saved ${esc(ago(g.updated))}</p>` : ""}
    <p class="note">Changing the budget resets what "return" is measured against.</p>`;
  }

  function viewControl() {
    const tickers = data && data.watchlist ? [...data.watchlist.stocks, ...data.watchlist.crypto].filter(t => Core.TICKER.test(t)) : [];
    const s = Core.botStatus({ data, paused, runs, live });
    const busy = ctlReq && ["requested", "running"].includes((Core.controlStep(ctlReq, ctlReport, ctlRun()) || {}).step);
    const stopped = paused || s.key === "halted" || s.key === "paused" || s.key === "liquidating";
    return `<div class="hero"><div class="label">Control</div><div style="font:600 22px var(--sans)">${esc(s.label)}</div>
      <p class="note">${esc(s.detail)}</p></div>
    ${statusCard(true)}
    ${running()}
    <button class="btn" data-act="dispatch" data-file="daily.yml" data-msg="Analysis requested for the whole watchlist">Run analysis now</button>
    <select id="one">${tickers.map(t => `<option>${esc(t)}</option>`).join("")}</select>
    <button class="btn ghost" data-act="analyze-one">Analyze just this one</button>
    <button class="btn ghost" data-act="dispatch" data-file="monitor.yml" data-msg="Stop check requested">Check stops &amp; refresh</button>
    ${stopped ? `<button class="btn" data-act="control" data-action="resume" ${busy ? "disabled" : ""}>Resume trading</button>`
      : `<button class="btn ghost" data-act="control" data-action="pause" ${busy ? "disabled" : ""}>Pause trading</button>`}
    <button class="btn danger" data-act="panic" ${busy ? "disabled" : ""}>Sell everything &amp; pause</button>
    <div class="card" style="margin-top:22px"><div class="label">Settings</div>
      <div class="note">Repo: ${esc(cfg.repo)}<br>Token: stored on this phone only, encrypted with your PIN. Unlocked until you close the app.</div>
      <button class="btn ghost" data-act="lock">Lock now</button>
      <button class="btn ghost" data-act="logout">Change token</button>
      <div class="note">Notifications: open the ntfy app and subscribe to your topic name (the NTFY_TOPIC secret).</div></div>`;
  }

  // ---- control requests: requested -> running -> confirmed / submitted / failed ------
  const ACTION_WORD = { pause: "Pause", resume: "Resume", panic: "Sell everything", goals: "Save goals" };
  const ctlRun = () => ctlReq && ctlRuns.find(r => r.name === "Control" && new Date(r.created_at) >= ctlReq.at - 60000);
  function controlCard() {
    const st = Core.controlStep(ctlReq, ctlReport, ctlRun());
    if (!st) return "";
    const steps = ["requested", "running", "done"];
    const at = st.step === "requested" ? 0 : st.step === "running" ? 1 : 2;
    const tone = { confirmed: "up", submitted: "warn", failed: "down", unknown: "warn" }[st.step] || "";
    const title = { requested: "Requested", running: "Running", confirmed: "Confirmed", submitted: "Orders sent — not all confirmed yet", failed: "Failed", unknown: "Not confirmed" }[st.step];
    return `<div class="card ctl"><div class="row"><span class="label">${esc(ACTION_WORD[st.action] || st.action)} · ${esc(ago(st.since))}</span>
        ${["confirmed", "submitted", "failed", "unknown"].includes(st.step) ? `<button class="chip" data-act="ctl-dismiss">Dismiss</button>` : ""}</div>
      <div class="steps">${steps.map((s, i) => `<span class="${i < at || (i === at && at === 2) ? "on" : i === at ? "now" : ""}">${s === "done" ? "Done" : s[0].toUpperCase() + s.slice(1)}</span>`).join("")}</div>
      <div class="${tone}" style="font:600 16px var(--sans);margin-top:8px">${esc(title)}</div>
      <p style="margin:6px 0 0;font-size:14px">${esc(st.text)}</p>
      ${st.pending && st.pending.length ? `<p class="note">Still open at the broker: ${st.pending.map(p => esc(`${p.ticker} (${p.why})`)).join(", ")}. The bot keeps retrying every run until Alpaca shows them closed.</p>` : ""}</div>`;
  }

  async function pollControl() {
    clearTimeout(ctlTimer);
    if (!ctlReq || !cfg.token) return;
    try {
      const [rep, rr] = await Promise.all([
        gh("contents/journal/control.json", { raw: true, allow404: true }).catch(() => null),
        gh("actions/workflows/control.yml/runs?per_page=5").catch(() => ({ workflow_runs: [] })),
      ]);
      try { ctlReport = rep ? JSON.parse(rep) : null; } catch { ctlReport = null; }
      ctlRuns = (rr.workflow_runs || []).map(r => ({ ...r, name: "Control" }));
    } catch {}
    const st = Core.controlStep(ctlReq, ctlReport, ctlRun());
    render();
    if (st && ["requested", "running"].includes(st.step)) ctlTimer = setTimeout(pollControl, 5000);
    else if (st && st.step !== "failed") load();
  }

  async function control(action, extra = {}) {
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
    ctlReq = { id, action, at: Date.now() };
    ctlReport = null;
    try {
      await gh("actions/workflows/control.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs: { action, request_id: id, ...extra } }) });
    } catch (e) {
      ctlReq.error = explain(e, ACTION_WORD[action] || action) + (action === "panic" ? " Nothing was sold. Try again, or sell in the Alpaca app." : "");
    }
    store.set("ctl_req", JSON.stringify(ctlReq));
    render();
    if (!ctlReq.error) pollControl();
  }

  async function dispatch(file, inputs, msg) {
    try {
      await gh(`actions/workflows/${file}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
      toast(msg + ". GitHub usually starts it within a minute.");
      setTimeout(load, 8000);
    } catch (e) { toast(explain(e, "Starting the run"), 8000); }
  }

  function sheet(html) {
    $("#sheetBody").innerHTML = `<div class="row" style="padding:10px 0"><span></span><button class="chip" data-act="close-sheet">Close</button></div>` + html;
    $("#sheet").classList.add("open");
  }
  const closeSheet = () => $("#sheet").classList.remove("open");

  // ---- token setup, lock screen, migration -----------------------------------------
  const failKey = "pin_fails";
  function viewSetup() {
    return `<div class="hero"><div class="big" style="font-size:34px">Connect your bot</div>
      <p class="muted">Paste a GitHub token that can read your <b>trading-bot</b> repo and start its workflows, and pick a PIN. The token is saved on this phone only, encrypted with the PIN.</p></div>
      <div class="label">Repo</div><input id="repo" value="${esc(cfg.repo)}" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="label">GitHub token</div><input id="tok" type="password" placeholder="github_pat_…" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
      <div class="label">PIN (6+ characters)</div><input id="pin" type="password" inputmode="numeric" autocomplete="new-password">
      <div class="label">PIN again</div><input id="pin2" type="password" inputmode="numeric" autocomplete="new-password">
      <button class="btn" data-act="setup">Connect</button>
      <p class="note">Make it at github.com → Settings → Developer settings → Fine-grained tokens. Only select the trading-bot repo; permissions: <b>Contents: Read</b>, <b>Actions: Read and write</b>; set an expiry (90 days).</p>`;
  }
  function viewSecure() {
    return `<div class="hero"><div class="big" style="font-size:30px">Protect your token</div>
      <p class="muted">This app used to keep your GitHub token in plain text. Pick a PIN and it will be stored encrypted instead; the plain copy is deleted.</p></div>
      <div class="label">PIN (6+ characters)</div><input id="pin" type="password" inputmode="numeric" autocomplete="new-password">
      <div class="label">PIN again</div><input id="pin2" type="password" inputmode="numeric" autocomplete="new-password">
      <button class="btn" data-act="secure">Encrypt and continue</button>
      <button class="btn ghost" data-act="logout">Forget the token instead</button>`;
  }
  function viewLock() {
    const wait = Math.max(0, (+store.get("pin_until", "0")) - Date.now());
    return `<div class="hero"><div class="big" style="font-size:34px">Unlock</div><p class="muted">Enter your PIN to open ${esc(cfg.repo)}.</p></div>
      <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" ${wait ? "disabled" : ""}>
      <button class="btn" data-act="unlock" ${wait ? "disabled" : ""}>${wait ? `Too many tries — wait ${Math.ceil(wait / 1000)} s` : "Unlock"}</button>
      <button class="btn ghost" data-act="logout">Forgot PIN? Set up again</button>
      ${data ? `<p class="note">Last saved status (offline): ${esc(usd(data.equity))} · ${esc(ago(data.updated))}</p>` : ""}`;
  }
  async function readPins() {
    const pin = $("#pin").value, pin2 = $("#pin2").value;
    if (pin.length < 6) { toast("Use at least 6 characters for the PIN"); return null; }
    if (pin !== pin2) { toast("The two PINs don't match"); return null; }
    return pin;
  }

  const handlers = {
    "refresh-prices": () => refreshPrices(),
    go: el => { tab = el.dataset.tab; store.set("tab", tab); render(); scrollTo(0, 0); },
    report: el => openReport(+el.dataset.i),
    odds: el => { store.set("odds_sel", el.dataset.t); render(); },
    profile: el => { draft.profile = el.dataset.k; render(); },
    "save-goals": () => {
      const goals = { profile: draft.profile, budget: String(draft.budget).replace(/[$,\s]/g, "") || null, notes: String(draft.notes || "").trim() };
      if (goals.budget && !(+goals.budget >= 50)) return toast("Budget must be at least $50");
      control("goals", { goals: JSON.stringify(goals) });
    },
    dispatch: el => dispatch(el.dataset.file, el.dataset.file === "daily.yml" ? { tickers: "" } : {}, el.dataset.msg),
    "analyze-one": () => { const t = $("#one").value; if (!Core.TICKER.test(t)) return toast("Pick a ticker from the list"); dispatch("daily.yml", { tickers: t }, "Analysis requested for " + t); },
    control: el => control(el.dataset.action),
    panic: () => sheet(`<h2>Sell everything?</h2><p>This sends a close order for every position the bot holds and pauses it. The app then shows which sales the broker <b>confirmed</b> and which are only <b>submitted</b> (e.g. stocks while the market is closed fill at the next open). Type <b>SELL</b> to confirm.</p>
      <input id="confirm" autocomplete="off" autocapitalize="characters" placeholder="SELL">
      <button class="btn danger" data-act="panic-confirm">Sell everything</button>
      <button class="btn ghost" data-act="close-sheet">Cancel</button>`),
    "panic-confirm": () => { if ($("#confirm").value.trim().toUpperCase() !== "SELL") return toast("Type SELL to confirm"); closeSheet(); control("panic"); },
    "close-sheet": closeSheet,
    "ctl-dismiss": () => { ctlReq = null; store.del("ctl_req"); render(); },
    lock: () => { cfg.token = ""; render(); },
    logout: () => { store.del("gh_token"); store.del("gh_vault"); store.del(failKey); store.del("pin_until"); cfg.token = ""; render(); },
    setup: async () => {
      const repo = Core.cleanRepo($("#repo").value);
      const token = $("#tok").value.replace(/\s+/g, "");
      if (!Core.validRepo(repo)) return toast("Repo should look like elijahvickers-17/trading-bot");
      if (!token) return toast("Paste your GitHub token first");
      const pin = await readPins(); if (!pin) return;
      cfg = { token, repo };
      try { await gh(""); }
      catch (e) { cfg.token = ""; return toast(e.status === 401 ? "GitHub didn't accept that token. Copy it again and paste the whole thing." : explain(e, "Connecting"), 8000); }
      store.set("gh_vault", await Core.seal(token, pin)); store.set("gh_repo", repo); store.del("gh_token");
      toast("Connected. Token saved encrypted."); load(); pollControl();
    },
    secure: async () => {
      const pin = await readPins(); if (!pin) return;
      store.set("gh_vault", await Core.seal(cfg.token, pin)); store.del("gh_token");
      toast("Token encrypted. The plain copy is gone."); render(); load(); pollControl();
    },
    unlock: async () => {
      const fails = +store.get(failKey, "0");
      try {
        cfg.token = await Core.unseal(store.get("gh_vault"), $("#pin").value);
        store.set(failKey, "0"); store.del("pin_until"); render(); load(); pollControl();
      } catch {
        store.set(failKey, String(fails + 1));
        const wait = Core.lockoutMs(fails + 1);
        if (wait) store.set("pin_until", String(Date.now() + wait));
        toast("Wrong PIN"); render();
      }
    },
  };

  document.addEventListener("click", e => {
    const el = e.target.closest("[data-act]");
    if (!el || el.disabled) return;
    const h = handlers[el.dataset.act];
    if (h) { e.preventDefault(); h(el); }
  });
  document.addEventListener("input", e => { const k = e.target.dataset && e.target.dataset.bind; if (k && draft) draft[k] = e.target.value; });
  document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "pin" && !$("#pin2")) handlers.unlock(); });

  const views = { home: viewHome, positions: viewPositions, decisions: viewDecisions, odds: viewOdds, goals: viewGoals, control: viewControl };
  function render() {
    const needSecure = !!legacyToken && !store.get("gh_vault") && store.get("gh_token");
    const locked = !cfg.token && store.get("gh_vault");
    header();
    document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
    $("#nav").classList.toggle("hide", !cfg.token || needSecure);
    $("#view").innerHTML = needSecure ? viewSecure() : cfg.token ? (views[tab] || viewHome)() : locked ? viewLock() : viewSetup();
  }
  document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => { tab = b.dataset.tab; store.set("tab", tab); render(); scrollTo(0, 0); }));

  let startY = null;
  addEventListener("touchstart", e => { startY = scrollY === 0 ? e.touches[0].clientY : null; }, { passive: true });
  addEventListener("touchend", e => { if (startY != null && e.changedTouches[0].clientY - startY > 90 && cfg.token) { toast("Refreshing…", 1200); load(); } startY = null; }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && cfg.token) { load(); if (ctlReq) pollControl(); } });
  setInterval(() => {   // count the wrong-PIN wait down; the input is disabled meanwhile, so re-rendering loses nothing
    const until = +store.get("pin_until", "0");
    if (!cfg.token && until && $("#pin")) { if (Date.now() >= until) store.del("pin_until"); render(); }
  }, 1000);

  const cached = store.get("cache"); if (cached) { try { data = JSON.parse(cached); } catch {} }
  if (legacyToken && !store.get("gh_vault")) cfg.token = legacyToken;   // usable once, until a PIN is set
  render();
  if (cfg.token && store.get("gh_vault")) { load(); pollControl(); }
})();

# Trading bot app — context for Claude Code

The phone app (PWA on GitHub Pages) for the bot in `elijahvickers-17/trading-bot`.
**Read that repo's `CLAUDE.md` and `docs/ROADMAP-v2.md` first** — v2 replaces this app's
GitHub-API backend with the bot server's own API.

## Today (v1)

- Static files, no build: `index.html` (markup, CSS, CSP), `core.js` (pure, Node-tested helpers:
  escaping, PIN vault, error messages, `botStatus`, `controlStep`), `app.js` (UI; one delegated
  click handler via `data-act`, no inline JS), `vendor/` (marked 12.0.2, DOMPurify 3.3.3).
- Reads `journal/status.json`, `live.json`, `control.json`, `timemachine/*.json`, `reports/*.md`
  from the bot repo via the GitHub contents API; buttons dispatch GitHub workflows.
- The GitHub token is stored only AES-GCM-encrypted with a PIN (PBKDF2 310k); plaintext lives in
  memory only.
- Tabs: Today (equity, refresh prices, holdings, A/B card, scorecard) · Holdings (positions with
  stop / take-profit / trailing, trades) · Agents (live run, A/B detail, scout, decisions) ·
  Odds (Time Machine) · Goals · Control.

## Rules

- Escape every value from the API (`Core.esc`); sanitize Markdown with DOMPurify; keep the CSP
  strict (scripts from self only); no inline handlers.
- Never put a token or secret in code, URLs or logs.
- Controls must show requested → running/sent → confirmed by the broker; never claim success
  without broker confirmation.

## Tests

```
node --test tests/*.test.mjs   # logic
node tests/ui.e2e.cjs          # Playwright browser test with a mocked GitHub API
```

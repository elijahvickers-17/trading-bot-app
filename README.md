# AI Desk

The iPhone app for the trading bot. Open the GitHub Pages link in Safari → Share → **Add to Home Screen**.

This repo holds only the app's screens. Your keys, trades and positions stay in the private `trading-bot` repo; the app reads them with a token saved only on your phone.

## Security

- **Token**: stored only encrypted (AES-GCM, key from your PIN via PBKDF2 310k rounds). The plain token lives in memory while the app is open; closing the app locks it. Older plain-text copies are migrated and deleted on first open. Five wrong PINs start a growing wait.
  - Limits: someone with your unlocked phone's storage could still try PINs offline, so use 6+ characters, give the token only the trading-bot repo, *Contents: Read* + *Actions: Read and write*, and a 90-day expiry.
  - **Stronger option (needs a tiny backend):** a Cloudflare Worker (free) holds the token as a secret and exposes only `status`, `dispatch(action)` endpoints; put it behind Cloudflare Access (email one-time code) so only you can call it. Then the phone never holds a GitHub token at all.
- **No inline JavaScript**; one delegated click handler. A Content-Security-Policy allows scripts only from this site and network calls only to api.github.com.
- **Vendored libraries** (no CDN): `vendor/marked-12.0.2.min.js`, `vendor/purify-3.3.3.min.js` (DOMPurify). Every value from GitHub is escaped; agent reports are sanitized.
- **Controls** carry a request id. The app shows *Requested → Running → Done*, and "done" means what the broker confirmed: a panic that couldn't close everything shows *Orders sent — not all confirmed* with what's still open.

## Tests

```
node --test tests/*.test.mjs   # logic: escaping, vault, error messages, status + control states
node tests/ui.e2e.cjs          # browser: PIN migration/unlock, XSS, failed/accepted panic flow (mocked GitHub)
```

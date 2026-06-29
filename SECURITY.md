# Security

VliegmasjienPRO is a self-hosted app for a single owner plus optional anonymous
"public" viewers. This document maps the **OWASP Top 10 (2021)** to what the app
does about each. Security is best-effort hardening, not a guarantee — please run
it behind HTTPS (a reverse proxy) when exposing it beyond your LAN.

| # | Category | Mitigations |
|---|----------|-------------|
| **A01** | Broken Access Control | Public/authenticated split is enforced **server-side**, not just in the UI: the receiver location, per-aircraft distances, zones, coverage (range/heatmap), alerts and all config/settings mutations are stripped or `401`-gated for anonymous requests (`server/auth.js` `requireAuth`/`authed`). Same-origin only (no CORS headers). |
| **A02** | Cryptographic Failures | Password stored only as a **scrypt** hash + per-user salt; sessions are stateless **HMAC-SHA256** cookies (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS). Secrets (hash, session key, API keys) are never sent to the browser (`publicConfig` strips them). HSTS set when the request is over TLS. |
| **A03** | Injection | All SQL uses **parameterized** `node:sqlite` statements (the only interpolated identifier is a fixed table-name allowlist). All third-party strings rendered in the DOM are **HTML-escaped** (`esc()`), backed by a strict CSP that blocks inline/injected script execution. |
| **A04** | Insecure Design | Anonymous is the safe default (location hidden until a password is set); login is rate-limited; bootstrap setup only works while no password exists. |
| **A05** | Security Misconfiguration | Strict **Content-Security-Policy**, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP; `X-Powered-By` disabled. Generic error handler (no stack traces), API 404 fallback, JSON body size limit. |
| **A06** | Vulnerable & Outdated Components | Tiny, current dependency set (express, leaflet, satellite.js, leaflet.heat, qrcode, flag-icons); all front-end libraries are **vendored locally** (no third-party CDN scripts). `npm audit` reports 0 known vulnerabilities. |
| **A07** | Identification & Auth Failures | Single password (min 8 chars, scrypt), **optional TOTP 2FA**, **brute-force lockout** (escalating per-client + global flood guard, HTTP 429), `timingSafeEqual` comparisons, and **session-secret rotation on password change** (invalidates other sessions). |
| **A08** | Software & Data Integrity | No untrusted remote code (everything vendored, `script-src 'self'`). **Prototype-pollution guard** in the config deep-merge. JSON parsing only (no `eval`/deserialization gadgets). |
| **A09** | Logging & Monitoring | Auth events (login success / failure / lockout) and server errors are logged; the in-app alert log records notifications. |
| **A10** | SSRF | The only user-supplied outbound fetch (aircraft-DB import URL) is restricted to **http/https**, with redirects disabled and a timeout. Other outbound calls go to fixed, known hosts. |

## Reporting

Found something? Open an issue at
<https://github.com/bpduguard/VliegmasjienPRO> (avoid posting exploit details
publicly for anything sensitive).

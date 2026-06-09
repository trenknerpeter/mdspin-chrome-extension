# Per-user JWT quota for the MDSpin extension

**Date:** 2026-06-09
**Status:** Approved design — ready for implementation planning
**Repos touched:** `mdspin-chrome-extension` (worker + popup), `true_frontend` (proxy route)

## Problem

The extension sends conversions through the web proxy at `https://www.mdspin.app/api/convert`. The proxy resolves the caller's identity for rate-limiting via `supabase.auth.getUser()`, which reads the **mdspin.app session cookie**. The extension's request is a `fetch` from the MV3 service worker and carries no reliable identity of its own.

Consequences observed in the live `daily_usage` table and confirmed with the maintainer:

1. **Unreliable server-side identity.** A signed-in extension user is only recognized by the proxy if they *also* happen to be logged into `www.mdspin.app` in the same browser (so the request carries the site cookie). Without that cookie they fall to the **anonymous IP limit (3/day, shared per NAT)** — the "3 / 3 spins" a tester hit. The extension sign-in alone does not reach the proxy.
2. **Double-counting.** For users the proxy *does* recognize (cookie present), every conversion increments their `daily_usage` row **twice**: once server-side by the proxy ([true_frontend `route.ts`](../../../../true_frontend/app/api/convert/route.ts) `incrementUsage`) and once client-side by the popup ([`Popup.tsx` `incrementUsage`](../../src/popup/Popup.tsx)). This halves their effective quota (≈10 real conversions before the popup blocks them at "20").

### Verified facts (Supabase `ixdsddfxkrkytiitfici`)

- `increment_daily_usage` RPC increments by **exactly 1**; there are **no triggers** on `daily_usage`. So the 2× is two independent writers, not a DB bug.
- Limits live only in `true_frontend/lib/rate-limit.ts`: `ANON_DAILY_LIMIT = 3` (keyed by IP), `AUTH_DAILY_LIMIT = 20` (keyed by Supabase `user.id`).
- The backend (`mdc-api`) has **no rate-limiting**, and its JWT path (`verifyAccessToken` / `OAUTH_JWT_SECRET`) validates the API's *own* OAuth JWT — **not** a Supabase access token. (This is why "extension → backend direct" was rejected.)

## Goal

A signed-in extension user gets their real per-user quota (20/day), attributed to their account, **reliably** — independent of any website cookie. Anonymous users keep the proxy's anonymous fallback. No shared secret is reintroduced into the shipped bundle (the JWT is the user's own, short-lived token).

## Approach (chosen)

**Proxy accepts a Bearer JWT.** The extension worker attaches the signed-in user's Supabase access token to the existing proxy request; the proxy resolves the user from that token. This reuses the entire existing rate-limit + `daily_usage` system and keeps a single conversion entry point.

Rejected alternative — *extension → backend direct*: the backend neither validates Supabase JWTs nor rate-limits, so it would require duplicating the quota system and adding JWT verification. Larger, riskier, and would give unlimited/unattributed usage in the interim.

## Design

### Component 1 — Proxy identity resolution
**File:** `true_frontend/app/api/convert/route.ts`

Resolve identity with precedence **bearer token → cookie → anonymous IP**:

1. Read `Authorization: Bearer <jwt>` from the request.
2. If present: `const { data: { user } } = await supabase.auth.getUser(token)`.
3. Else fall back to the existing cookie-based `supabase.auth.getUser()`, then to `getClientIp(req)`.

A bad/expired/forged token yields no user and falls through to cookie/IP — the route must **not 500** on it. Everything downstream (`checkRateLimit`, `incrementUsage`, the 429 message, the `X-RateLimit-*` headers) already keys off the resolved `identifier`/`identifierType`, so **no other proxy change is needed**. Because the increment already attributes to whatever identity is resolved, deploying this is **backward-safe**: requests without a bearer behave exactly as today.

### Component 2 — Worker attaches the token and surfaces headers
**File:** `mdspin-chrome-extension/src/background/worker.ts` (`convertFile`)

- Obtain a token (see Component 3 for source). If present and unexpired, add `Authorization: Bearer <token>` to the existing `fetch`. If absent, send no header → anonymous path, exactly as today.
- After the response, read `X-RateLimit-Limit` and `X-RateLimit-Remaining` and include them in the result object returned to the caller (popup/content script).
- **No `@supabase/supabase-js` client in the worker** — it only handles a token string.

### Component 3 — Token source (popup is the sole refresh authority)
**File:** `mdspin-chrome-extension/src/popup/Popup.tsx`

- **Popup path (primary, satisfies acceptance criteria):** in `handleFile`, call `supabase.auth.getSession()` (refreshes if near expiry — the popup is a live page) and pass `session.access_token` in the `CONVERT_FILE` message. The worker forwards it.
- **Inline path (secondary, beta):** mirror `{ access_token, expires_at }` into `chrome.storage.local` on initial `getSession()` and on every `onAuthStateChange` (incl. `TOKEN_REFRESHED`); clear it on `SIGNED_OUT`. For content-script-initiated conversions (no token in the message), the worker reads this mirror and attaches the token only if `expires_at` is still in the future.

Keeping the popup as the only context that refreshes avoids Supabase refresh-token rotation races (no second client in the service worker).

### Component 4 — Remove the popup's client-side increment (kills the double-count)
**File:** `mdspin-chrome-extension/src/popup/Popup.tsx`

- **Remove** the client-side `daily_usage` write in `incrementUsage` ([`Popup.tsx:272-304`](../../src/popup/Popup.tsx)). The proxy is the single writer.
- Keep the initial usage **read** (`loadUsage`) for display on popup open.
- After a successful conversion, update the displayed `remaining`/`limit` from the `X-RateLimit-*` headers surfaced by the worker (Component 2) instead of re-reading/writing the DB. This avoids the fire-and-forget read race (the proxy's `incrementUsage` is not awaited).
- The optimistic-UI decrement may be kept for snappiness, but headers are authoritative.

## Error handling

- No session / expired token / refresh unavailable → no `Authorization` header → anonymous path (no regression).
- Invalid or expired token reaching the proxy → `getUser(token)` returns no user → cookie/IP fallback; never 500.
- 429 from the proxy → worker already surfaces the proxy's human-readable message ([`worker.ts:280-282`](../../src/background/worker.ts)); unchanged.

## Rollout / sequencing

1. Deploy the `true_frontend` proxy change first. It is backward-safe — old extensions send no bearer and keep their current behavior, so there is no double-count window introduced by the proxy alone.
2. Ship the extension update (worker + popup) after. The worker sends the bearer **and** the popup stops its client-side increment in the **same release**, so a given installed version is internally consistent.

## Out of scope (this spec)

- The sign-in / "only works with DevTools open" bug (Observation 1, likely the popup tearing down during the Google `launchWebAuthFlow`). Tracked as a separate work item; deferred by maintainer's choice.
- Any `true_frontend` UI (website) changes — untouched; its quota behavior is unchanged.
- Worker-side token refresh for the inline path — future improvement; for now stale-token inline conversions fall back to anonymous.

## Low-risk checks during implementation

- Confirm the MV3 worker `fetch` + `Authorization` header to `www.mdspin.app` is not blocked by a CORS preflight. Expected fine: `host_permissions` already grants the worker credentialed cross-origin access to `www.mdspin.app` (that privilege is why the site cookie reaches the proxy today), which also bypasses CORS for that host.
- Confirm `supabase.auth.getUser(token)` on the proxy resolves the user from an extension-issued access token (same Supabase project `ixdsddfxkrkytiitfici`).

## Acceptance criteria

- A signed-in extension user gets **20/day attributed to their account**, not 3/IP, regardless of whether they are logged into the website.
- Each conversion increments the user's `daily_usage` row by **+1, not +2**.
- The popup displays an accurate `remaining / 20`, driven by the proxy's `X-RateLimit-*` headers after each conversion.
- Anonymous (signed-out) users still work and still hit the anonymous fallback with the "sign in for more" message.
- No shared secret is present in the shipped extension bundle.
- **End-to-end:** build the extension, sign in, convert >3 files in a session, and confirm it does not hit the anonymous cap and counts each conversion once.

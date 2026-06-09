# Per-user JWT Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make signed-in extension users reliably get their 20/day per-user quota (attributed to their account) instead of the anonymous 3/IP cap, and stop conversions from double-counting.

**Architecture:** The extension worker attaches the signed-in user's Supabase access token as `Authorization: Bearer <jwt>` to the existing proxy request. The proxy (`true_frontend`) resolves identity bearer → cookie → IP and remains the single writer to `daily_usage`. The popup stops writing `daily_usage` itself and drives its display from the proxy's `X-RateLimit-*` response headers. The popup is the sole token-refresh authority and mirrors the session into `chrome.storage.local` so inline (content-script) conversions can use it too.

**Tech Stack:** Next.js 16 route handler + `@supabase/ssr` (proxy); MV3 service worker + Preact popup + `@supabase/supabase-js` (extension). No test framework — verification is manual/E2E (build, load, sign in, convert, inspect `daily_usage` + response headers).

**Spec:** `docs/superpowers/specs/2026-06-09-extension-per-user-jwt-quota-design.md`

**Repo layout note:** Tasks 1 lives in `~/Documents/Master/MDC_project/true_frontend`. Tasks 2–3 live in `~/Documents/Master/MDC_project/mdspin-chrome-extension`. Commit each in its own repo.

---

## File Structure

- **Modify** `true_frontend/app/api/convert/route.ts` — add bearer-token identity resolution before the cookie/IP fallback (lines ~44-48). No other change.
- **Modify** `mdspin-chrome-extension/src/background/worker.ts` — add `getAccessToken` helper; attach `Authorization` header in `convertFile`; surface `X-RateLimit-*` headers in the returned object.
- **Modify** `mdspin-chrome-extension/src/popup/Popup.tsx` — add `mirrorSession` helper; mirror session on auth changes; pass `accessToken` in the `CONVERT_FILE` message; replace client-side `incrementUsage` (DB write) with `recordUsage` (header-driven display + anon-only local counter).

No content-script changes: inline conversions already route `CONVERT_FILE` through the worker, which falls back to the mirrored token.

---

## Task 1: Proxy — bearer-token identity resolution

**Files:**
- Modify: `true_frontend/app/api/convert/route.ts:44-48`

- [ ] **Step 1: Replace the identity-resolution block**

Find this block (currently lines ~44-48):

```ts
  // ── 2. Rate limit check ────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const identifier = user ? user.id : getClientIp(req);
  const identifierType: 'user' | 'ip' = user ? 'user' : 'ip';
```

Replace it with:

```ts
  // ── 2. Rate limit check ────────────────────────────────────
  // Identity precedence: bearer token (extension) → session cookie (website) → anonymous IP.
  const supabase = await createClient();

  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] = null;

  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) user = data.user;
    } catch {
      // Malformed/expired token — fall through to cookie/IP. Never 500 on this.
    }
  }

  if (!user) {
    const { data } = await supabase.auth.getUser(); // cookie-based session
    user = data.user;
  }

  const identifier = user ? user.id : getClientIp(req);
  const identifierType: 'user' | 'ip' = user ? 'user' : 'ip';
```

Everything downstream (`checkRateLimit`, `incrementUsage`, the 429 message, `X-RateLimit-*` headers) is unchanged — it already keys off `identifier`/`identifierType`.

- [ ] **Step 2: Type-check and lint**

Run (from `true_frontend`):
```bash
npx tsc --noEmit && npm run lint
```
Expected: no errors. (If `tsc` complains about the `user` type annotation, simplify it to `let user: { id: string } | null = null;` — only `user.id` and truthiness are used.)

- [ ] **Step 3: Manual check — bad token falls through, no 500**

Start the dev server and send a forged bearer with a small sample file:
```bash
npm run dev   # in one terminal (true_frontend)
# in another terminal:
curl -i -X POST http://localhost:3000/api/convert \
  -H "Authorization: Bearer not-a-real-jwt" \
  -F "file=@/path/to/any-sample.pdf"
```
Expected: **not** HTTP 500. You get either a normal `200` conversion or a `429`, with header `X-RateLimit-Limit: 3` (anonymous — the forged token was ignored and it fell back to IP). A real per-user `20` is verified end-to-end in Task 4.

- [ ] **Step 4: Commit**

```bash
git add app/api/convert/route.ts
git commit -m "feat: accept Supabase Bearer token for rate-limit identity in convert proxy"
```

---

## Task 2: Worker — attach the token and surface rate-limit headers

**Files:**
- Modify: `mdspin-chrome-extension/src/background/worker.ts` (`convertFile` ~236-291)

- [ ] **Step 1: Add the `getAccessToken` helper**

Insert this function immediately **above** `async function convertFile(` (around line 236):

```ts
/**
 * Resolve a Supabase access token for the conversion request.
 * Popup conversions pass a fresh token in the message. Inline (content-script)
 * conversions have none, so fall back to the session the popup mirrored into
 * chrome.storage.local — but only if it has not expired.
 */
async function getAccessToken(messageToken?: string | null): Promise<string | null> {
  if (messageToken) return messageToken;
  const { mdspinSession } = await chrome.storage.local.get("mdspinSession");
  if (mdspinSession?.access_token && typeof mdspinSession.expires_at === "number") {
    const nowSec = Math.floor(Date.now() / 1000);
    if (mdspinSession.expires_at > nowSec + 30) return mdspinSession.access_token;
  }
  return null;
}
```

- [ ] **Step 2: Update the `convertFile` signature and return type**

Change the signature (currently ~236-240):

```ts
async function convertFile(message: {
  fileName: string;
  fileData: string;
  fileType: string;
}): Promise<{ markdown?: string; error?: string }> {
```

to:

```ts
async function convertFile(message: {
  fileName: string;
  fileData: string;
  fileType: string;
  accessToken?: string | null;
}): Promise<{ markdown?: string; error?: string; rateLimit?: { limit: number; remaining: number } }> {
```

- [ ] **Step 3: Attach the Authorization header on the fetch**

Find (currently ~250-254):

```ts
  let response: Response;
  try {
    // No Authorization header — the proxy holds the key server-side.
    // Do NOT set Content-Type; fetch sets the multipart boundary itself.
    response = await fetch(API_URL, { method: "POST", body: form });
  } catch (err) {
```

Replace with:

```ts
  // Attach the user's Supabase token when signed in — the proxy uses it to
  // resolve per-user quota. Anonymous conversions send no header (unchanged).
  const headers: Record<string, string> = {};
  const token = await getAccessToken(message.accessToken);
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    // Do NOT set Content-Type; fetch sets the multipart boundary itself.
    response = await fetch(API_URL, { method: "POST", body: form, headers });
  } catch (err) {
```

- [ ] **Step 4: Surface the rate-limit headers in the success return**

Find (currently ~288-290):

```ts
  const data = await response.json();
  console.log("[MDSpin BG] Response keys:", Object.keys(data));
  return { markdown: data.markdown_text ?? "" };
```

Replace with:

```ts
  const data = await response.json();
  console.log("[MDSpin BG] Response keys:", Object.keys(data));
  const limit = Number(response.headers.get("X-RateLimit-Limit"));
  const remaining = Number(response.headers.get("X-RateLimit-Remaining"));
  const rateLimit =
    Number.isFinite(limit) && Number.isFinite(remaining) ? { limit, remaining } : undefined;
  return { markdown: data.markdown_text ?? "", rateLimit };
```

(The `CONVERT_FILE` listener already does `sendResponse(result)`, so `rateLimit` is forwarded to the popup with no listener change.)

- [ ] **Step 5: Type-check**

Run (from `mdspin-chrome-extension`):
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/background/worker.ts
git commit -m "feat: worker attaches Supabase bearer token and surfaces rate-limit headers"
```

---

## Task 3: Popup — pass token, mirror session, stop double-counting

**Files:**
- Modify: `mdspin-chrome-extension/src/popup/Popup.tsx`

- [ ] **Step 1: Add the `mirrorSession` helper**

Insert at module scope, right after the `AUTH_LIMIT` constant (after line ~13):

```tsx
// Mirror the Supabase session into chrome.storage.local so the service worker
// (and inline content-script conversions) can read the access token. The popup
// is the ONLY context that refreshes tokens, avoiding refresh-token races.
function mirrorSession(
  session: { access_token: string; expires_at?: number } | null
) {
  if (session?.access_token && typeof session.expires_at === "number") {
    chrome.storage.local.set({
      mdspinSession: {
        access_token: session.access_token,
        expires_at: session.expires_at,
      },
    });
  } else {
    chrome.storage.local.remove("mdspinSession");
  }
}
```

- [ ] **Step 2: Mirror the session on load and on auth changes**

In the mount `useEffect`, find (currently ~106-123):

```tsx
    supabase.auth.getSession().then(({ data }) => {
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
      if (sessionUser) {
        setAuthView("none");
        setAuthEmail("");
        setAuthPassword("");
      }
    });
```

Replace with (adds two `mirrorSession(...)` calls):

```tsx
    supabase.auth.getSession().then(({ data }) => {
      mirrorSession(data.session);
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      mirrorSession(session);
      const sessionUser = session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
      if (sessionUser) {
        setAuthView("none");
        setAuthEmail("");
        setAuthPassword("");
      }
    });
```

- [ ] **Step 3: Replace `incrementUsage` with `recordUsage`**

Delete the entire `incrementUsage` function (currently ~272-304) and replace it with:

```tsx
  // Record usage after a conversion. The proxy is the SINGLE writer to
  // daily_usage, so authenticated users get NO client-side DB write here
  // (that was the double-count bug). Display is driven by the proxy's
  // authoritative X-RateLimit-* headers.
  function recordUsage(
    currentUser: User | null,
    rateLimit?: { limit: number; remaining: number }
  ) {
    if (rateLimit && Number.isFinite(rateLimit.remaining)) {
      setUsage({ remaining: Math.max(0, rateLimit.remaining), limit: rateLimit.limit });
    } else {
      // Fallback if headers were unavailable: optimistic local decrement.
      setUsage((prev) =>
        prev ? { ...prev, remaining: Math.max(0, prev.remaining - 1) } : prev
      );
    }

    // Anonymous users have no per-user row in the popup's view, so keep a local
    // counter for display persistence across popup reopens (the proxy's IP limit
    // is the real enforcement). Authenticated users persist via the proxy only.
    if (!currentUser) {
      const todayUtc = new Date().toISOString().split("T")[0];
      chrome.storage.local.get("dailyUsage", (result) => {
        const stored = result.dailyUsage as { date: string; count: number } | undefined;
        const count = stored?.date === todayUtc ? stored.count : 0;
        chrome.storage.local.set({ dailyUsage: { date: todayUtc, count: count + 1 } });
      });
    }
  }
```

(`loadUsage` is unchanged — it still reads the initial count for display on popup open.)

- [ ] **Step 4: Send the token and use header-driven usage in `handleFile`**

In `handleFile`, find (currently ~332-348):

```tsx
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CONVERT_FILE",
        fileName: file.name,
        fileData: await fileToBase64(file),
        fileType: file.type,
      });
      if (response.error) {
        setState({ kind: "error", message: response.error });
      } else {
        const wordCount = countWords(response.markdown);
        setState({ kind: "result", markdown: response.markdown, fileName: file.name, wordCount });
        chrome.storage.local.set({
          lastConversion: { markdownText: response.markdown, fileName: file.name, wordCount, convertedAt: new Date().toISOString() },
        });
        incrementUsage(user).catch((err) => console.error("[MDSpin] Usage increment failed:", err));
      }
    } catch {
      setState({ kind: "error", message: "Conversion failed. Please try again." });
    }
```

Replace with:

```tsx
    try {
      const { data: { session } } = await supabase.auth.getSession();
      mirrorSession(session); // keep the worker's mirrored token fresh
      const response = await chrome.runtime.sendMessage({
        type: "CONVERT_FILE",
        fileName: file.name,
        fileData: await fileToBase64(file),
        fileType: file.type,
        accessToken: session?.access_token ?? null,
      });
      if (response.error) {
        setState({ kind: "error", message: response.error });
      } else {
        const wordCount = countWords(response.markdown);
        setState({ kind: "result", markdown: response.markdown, fileName: file.name, wordCount });
        chrome.storage.local.set({
          lastConversion: { markdownText: response.markdown, fileName: file.name, wordCount, convertedAt: new Date().toISOString() },
        });
        recordUsage(user, response.rateLimit);
      }
    } catch {
      setState({ kind: "error", message: "Conversion failed. Please try again." });
    }
```

- [ ] **Step 5: Type-check (confirms no leftover `incrementUsage` references)**

Run (from `mdspin-chrome-extension`):
```bash
npx tsc --noEmit
```
Expected: no errors. If it reports `Cannot find name 'incrementUsage'`, you missed a call site — grep `grep -n incrementUsage src/popup/Popup.tsx` and replace each with `recordUsage(user, response.rateLimit)` (or remove if not in a conversion path).

- [ ] **Step 6: Commit**

```bash
git add src/popup/Popup.tsx
git commit -m "feat: popup sends bearer token, mirrors session, stops client-side usage double-count"
```

---

## Task 4: End-to-end verification (acceptance criteria)

**Prerequisite:** Task 1 must be **deployed** to `https://www.mdspin.app` (the worker calls that hardcoded URL). The proxy change is backward-safe, so deploying it to production first is low-risk. *(Alternative without prod deploy: temporarily set `API_URL` in `worker.ts` to a Vercel preview URL — or `http://localhost:3000/api/convert` with `http://localhost:3000/*` added to `manifest.json` `host_permissions` — then revert before shipping.)*

- [ ] **Step 1: Build the extension**

Per the project memory: **kill any running Vite dev server first** (CRXJS otherwise ships a broken dev-mode loader). Then (from `mdspin-chrome-extension`):
```bash
npm run build
```
Load/reload `dist/` at `chrome://extensions` (Developer mode → Load unpacked, or hit the reload ↻ icon).

- [ ] **Step 2: Record the starting count for your user**

In the Supabase SQL editor (project `ixdsddfxkrkytiitfici`), run — replace `<USER_ID>` with your auth user id:
```sql
select identifier, identifier_type, date, conversion_count, updated_at
from daily_usage
where identifier = '<USER_ID>' and identifier_type = 'user'
  and date = (now() at time zone 'utc')::date;
```
Note the `conversion_count` (or absence of a row = 0).

- [ ] **Step 3: Convert one file while signed in, confirm +1 (not +2)**

Sign in via the popup, convert a small PDF. Open the **service worker** DevTools (`chrome://extensions` → MDSpin → "service worker") → Network tab → the `convert` request → Headers, and confirm the response shows **`X-RateLimit-Limit: 20`** (proves per-user attribution, not the anonymous 3). Re-run the SQL from Step 2: `conversion_count` must have increased by **exactly 1**.

- [ ] **Step 4: Convert >3 files in the session, confirm no anonymous cap**

Convert at least 4 more files. None should fail with the anonymous limit; the popup footer should count down from `/20`, and each conversion should add exactly 1 to the DB row (not 2). This is the core acceptance criterion.

- [ ] **Step 5: Verify the anonymous path still works**

Sign out in the popup. Confirm the footer shows `/3`, and that converting still works and surfaces the "sign in for more" message once the anonymous IP limit is hit (`X-RateLimit-Limit: 3` on the response).

- [ ] **Step 6: (If you used the local/preview `API_URL` override) revert it**

Restore `API_URL = "https://www.mdspin.app/api/convert"` in `worker.ts` and remove any temporary `host_permissions` entry, then rebuild. Confirm `git diff` shows no stray override before shipping.

- [ ] **Step 7: Final confirmation**

Confirm all acceptance criteria from the spec hold:
- Signed-in user gets 20/day attributed to their account (not 3/IP), regardless of website cookie.
- Each conversion increments `daily_usage` by +1.
- Popup shows accurate `remaining / 20`.
- Anonymous users still work with the "sign in for more" message.
- No shared secret in the bundle (the only credential sent is the user's own short-lived JWT).

---

## Self-Review (completed during authoring)

- **Spec coverage:** Component 1 → Task 1; Component 2 → Task 2; Component 3 (token source: message + mirror) → Task 2 (`getAccessToken`) + Task 3 (Steps 1–2, 4); Component 4 (remove client increment + header-driven display) → Task 3 (Steps 3–4). Acceptance criteria → Task 4. Out-of-scope items (sign-in bug, website UI, worker-side refresh) are intentionally absent.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; the one `<USER_ID>` / `<path>` are explicit user-supplied values, not placeholders for logic.
- **Type consistency:** `rateLimit: { limit: number; remaining: number }` is produced in Task 2 Step 4 and consumed identically in Task 3 (`recordUsage`, `handleFile`). `mdspinSession: { access_token, expires_at }` is written in Task 3 Step 1 and read in Task 2 Step 1. `recordUsage(user, response.rateLimit)` replaces all `incrementUsage` call sites (guarded by Task 3 Step 5 grep).

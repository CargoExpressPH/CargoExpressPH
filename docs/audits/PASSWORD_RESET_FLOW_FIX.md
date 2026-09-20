# Password Reset Flow — Investigation & Fix

Date: 2026-09-16
Scope: Forgot Password → email link → Reset Password → return to Login.
Recovery method: **Supabase `resetPasswordForEmail` + `updateUser`, implicit-flow email link.** No OTP was introduced.

## 1. Confirmed root cause

The flow's core mechanics (session verification before rendering the form, blocking
normal-login redirects during recovery, cross-tab stranding recovery, double-submit guards,
sign-out-before-navigate) were **already implemented and hardened** across several prior commits
(`a1d65e7`, `00a5c5e`, `c7a34bf`, `cba82f7`, `b53c7a8` — see `git log` on
`src/pages/auth/ResetPasswordPage.jsx`). Tracing the flow end to end against the installed
`@supabase/supabase-js@2.104.1` / `@supabase/auth-js` source turned up three concrete, narrower
defects that match the reported symptom ("unclear whether the password was saved and whether the
user returns correctly to Login"):

1. **`goToSignIn()` in `ResetPasswordPage.jsx` used `navigate('/login')` with no `replace: true`
   and passed no success message.** The reset form's completed/success screen stayed in browser
   history, and nothing on `/login` was ever built to display a "password updated" confirmation —
   `LoginPage.jsx` had no flash-message mechanism at all. So even though the reset itself worked,
   there was no persisted confirmation on the screen the user actually lands on, and Back could
   return to a dead success screen whose recovery session had already been destroyed.
2. **`AuthContext.jsx` used `window.location.assign(...)` (twice) to move the recovery flow onto
   `/reset-password`.** `assign()` pushes a new browser-history entry; `replace()` swaps the
   current one. Using `assign()` here stacks extra history entries that can carry the recovery
   hash, needlessly increasing how many Back-presses land on a stale recovery URL.
3. No functional bug in `updateUser`/session handling itself was found — `changePassword()`
   only resolves `success: true` when Supabase's `updateUser` call itself returns no error
   (`AuthContext.jsx:431-439`), and the UI's `success` state is only set from that resolved
   value, not assumed optimistically.

None of this pointed to a page-refresh-shaped problem — the underlying `updateUser` call was
already correct; the gap was entirely in **post-success navigation and feedback**, exactly the
part of the flow requested for repair.

## 2. Files changed

| File | Change |
|---|---|
| `src/pages/auth/ResetPasswordPage.jsx` | `goToSignIn()` now navigates with `{ replace: true, state: { flashMessage: '...' } }` instead of a bare `navigate('/login')`. |
| `src/contexts/AuthContext.jsx` | Both recovery-redirect `window.location.assign(...)` calls changed to `window.location.replace(...)`. |
| `src/pages/auth/LoginPage.jsx` | Added a one-time flash-message banner sourced from `location.state.flashMessage`; the state is scrubbed via `navigate(location.pathname, { replace: true, state: null })` on mount so reload/Back never re-shows it; cleared as soon as the user edits either field. |
| `src/styles/tabs-steps.css` | Added `.login-success-box` (mirrors the existing `.login-error-box`, using the existing `--success`/`--success-bg`/`--success-text` tokens — no new tokens introduced). |

No changes were made to `ForgotPasswordPage.jsx`'s request flow, `changePassword`/`resetPassword`
in `AuthContext.jsx`, route guards, or any Supabase migration/RLS policy — all of those were
already correct for this flow (see §5).

## 3. Recovery flow used by the project

- **Implicit flow**, not PKCE, not OTP. `src/lib/supabase.js`'s `createClient(...)` does not set
  `flowType`, and no `exchangeCodeForSession` call exists anywhere in the codebase (confirmed by
  a full-repo grep) — consistent with the implicit default.
- `resetPasswordForEmail(email, { redirectTo })` triggers Supabase to email a link that resolves
  through `<SUPABASE_URL>/auth/v1/verify?...&type=recovery`, which redirects the browser to
  `redirectTo` with `#access_token=...&refresh_token=...&type=recovery` appended to the URL hash.
- `supabase.auth.getSession()`/`onAuthStateChange` (client-side, via `detectSessionInUrl: true`)
  parses that hash **once**, fires `PASSWORD_RECOVERY`, and establishes a real (if intended to be
  short-lived-in-purpose) session for the target account.
- `updateUser({ password })` uses that session's access token to set the new password. This is a
  real, working session — not a token the app inspects itself — so "was the password saved" is
  answered strictly by whether that call returns an error, not by any local assumption.

## 4. Redirect / session handling (what actually happens, verified against the installed SDK)

- **URL hygiene**: verified directly in `node_modules/@supabase/auth-js/dist/main/GoTrueClient.js`
  (implicit-flow branch, ~line 3092) that the SDK itself runs `window.location.hash = ''` after
  successfully parsing the recovery tokens — the raw access/refresh tokens are removed from the
  visible URL automatically, before any app code runs. This satisfies "remove sensitive recovery
  URL parameters after successful processing" for the *current* URL. It is a **same-document hash
  change**, which browsers generally record as a new history entry — so the very first entry (the
  tab as opened directly from the email client) can still contain the original hash in history
  even though the address bar no longer shows it. This is intrinsic to how `auth-js` implements
  the implicit flow and is not something application code can change without abandoning the
  implicit-flow approach entirely (out of scope — OTP/PKCE were explicitly excluded).
- **"Single-use" scope**: the one-time-use guarantee Supabase advertises applies to the **emailed
  `/auth/v1/verify` link**, not to the access/refresh token it exchanges that link for. Once
  exchanged, the resulting session is a normal (short-lived, admin-configured expiry) session like
  any other. Re-opening the *same emailed link* a second time is correctly rejected by Supabase
  server-side (confirmed by design, not independently re-tested against live Supabase in this
  session — see §7); a stale copy of the *already-exchanged* access token sitting in browser
  history is bounded by that token's own expiry, not by single-use semantics.
- **Sign-out scope on completion**: `logout()` (called by `goToSignIn`) ends with a bare
  `supabase.auth.signOut()`. Checked directly in the installed
  `@supabase/auth-js/dist/main/GoTrueClient.js` (`async signOut(options = { scope: 'global' })`,
  with the SDK's own doc comment: *"By default, `signOut()` uses the global scope, which signs out
  all other sessions that the user is logged into as well."*) — **this does invalidate the
  account's other active sessions/devices**, as a documented side effect of the SDK default, not
  because the app added special logic for it. This was verified by reading the installed SDK
  source, not by testing a second live device in this session (see §7 for what remains
  unverified).
- **Route guards**: `/reset-password` is registered in `src/App.jsx` **outside** both
  `AuthRoute` and `ProtectedRoute`, so no guard fires during the reset itself.
  `resolveAuthRouteState` (`src/lib/authRouteState.js`) only redirects `/login` away when both
  `user` and `userProfile.role` are set; the `PASSWORD_RECOVERY` handler in `AuthContext.jsx`
  deliberately never sets `user`, and `logout()` clears it before the final `navigate('/login')`
  — so landing on `/login` after a reset renders the form, not a dashboard bounce.
- **Duplicate-processing guard**: only `AuthContext.jsx` owns `onAuthStateChange`-driven
  navigation. `ResetPasswordPage.jsx` also subscribes to `onAuthStateChange`, but only to flip a
  local `ready`/`linkInvalid` UI flag — it never itself navigates or re-triggers the token
  exchange, so there is exactly one place deciding where to send the browser.
- **Existing signed-in session on the same device**: opening a recovery link for account A in a
  browser currently signed in as account B overwrites the shared `sb-*` localStorage session with
  account A's recovery session (both use the same storage key) — this is inherent Supabase
  client behavior, not application logic, and account B's normal session is lost on that device
  once this happens. Not independently re-tested live in this session; documented from SDK
  behavior for the same reason as above.

## 5. Relevant Supabase configuration (dashboard — **not changed, requires your action**)

I did not have dashboard credentials and made **no changes to any Supabase project setting**, per
the instruction not to touch production auth settings without authorization. Please verify:

1. **Redirect URLs allow-list** (Authentication → URL Configuration → Redirect URLs) must include:
   - `https://cargoexpress-ph.online/reset-password` (production — confirm this is the live
     custom domain; `getPasswordResetRedirectUrl()` in `AuthContext.jsx` uses
     `window.location.origin` automatically in any non-localhost context, so it will match
     whatever domain the app is actually served from without a code change).
   - Optionally `http://localhost:5173/reset-password`, only if the team wants to test the full
     email-link flow from local dev — local `.env` currently sets `VITE_APP_URL=http://localhost:5173`,
     which `getPasswordResetRedirectUrl()` falls back to specifically because `window.location.hostname`
     includes `localhost`.
   - If the deployed URL is not on this allow-list, `resetPasswordForEmail` still returns success
     (GoTrue doesn't reveal this at request time), but the emailed link is rejected by Supabase's
     `/verify` redirect step — this looks identical to "nothing happens" from the user's side and
     cannot be distinguished from inside this repo. **This is the single most likely deployed-only
     failure mode and needs to be confirmed against the live project.**
2. **Site URL** — used only as a fallback when no `redirectTo` is supplied; not directly relevant
   here since the code always passes an explicit `redirectTo`, but worth confirming it's set to
   the production domain for consistency with other auth emails.
3. **Email template** for "Reset Password" — default Supabase template is compatible with the
   implicit flow already in use; no repo-local copy of this template exists (it's dashboard-only),
   so its current wording/branding could not be inspected from the codebase.
4. **Recovery token / OTP expiry** (Authentication → Providers → Email) — determines how long the
   link is valid; not inspectable from the repo.

No `supabase db push` or Edge Function deploy is required for the fixes in §2 — they are pure
client-side navigation/UI changes.

## 6. Tests performed and actual results

Run in this repo, this session:

| Check | Result |
|---|---|
| `npm test` (smoke, axe-lint, token-lint, then the full contract-test chain) | `smoke-check`, `axe-lint` (161 files), and `token-lint` (217 tokens / 198 files) **passed** — these are the checks relevant to the new JSX/CSS. The chain later hit a **pre-existing, unrelated** failure in `scripts/payment-refund-pgtest/run.mjs` (a Windows path-resolution bug: `ENOENT ... C:\C:\Users\...`, caused by the project folder path containing spaces, independent of anything touched here). Reproduced before touching any file in this task; not a regression from this change. |
| `npx vite build` | Production build completed successfully; all lazy chunks (including `LoginPage`, `ResetPasswordPage`) built without errors. |
| Code-path re-read for: double submit, mismatched passwords, sign-out-failure vs. update-failure conflation, route-guard bounce, duplicate `onAuthStateChange` navigation | Confirmed correct by inspection (see §4); no code change needed for these — they were already handled. |

**Not performed in this session** (see §7 for why and what's needed):

- Live email delivery through Supabase (request → real inbox → click link → set password → sign
  in with new password → confirm old password rejected).
- Live multi-device/session test to directly observe other sessions being signed out (documented
  in §4 from SDK source, not from a live second-device observation).
- Expired-link / already-used-link / malformed-link behavior against a real Supabase project.
- Manual browser testing of Back/refresh/double-click in an actual browser (desktop, mobile,
  installed PWA) — I do not have a browser-driving tool in this environment.
- Playwright E2E (`tests/*.spec.js`) — these run against a live Supabase project via
  `npm run preview`; not run in this session since that requires a real dev/staging Supabase
  project and a disposable mailbox, neither of which is available here.

## 7. Remaining verification gaps — do not treat these as passed

State clearly, per your instruction not to mark unverified items as passed based on code review
alone:

- **Redirect URL allow-list on the live Supabase project** — unverified; see §5.1. This is the
  most likely explanation if the *original* reported symptom was actually "the email link goes
  nowhere / errors" rather than "the post-success screen is confusing." If that's still happening
  after this fix, check this first.
- **Actual email template content/branding** — unverified (dashboard-only, no local copy).
- **Live confirmation that a used/expired link produces `linkInvalid: true`** — the logic
  (`ResetPasswordPage.jsx` lines ~95-123: waits up to 4s for a session, then flags invalid) is
  sound by inspection, but has not been exercised against a real expired/reused Supabase link in
  this session.
- **Cross-browser / in-app-browser (e.g. Gmail's in-app Chrome tab, Facebook in-app browser)
  behavior** — the implicit-flow session lives only in that browser instance's localStorage. If
  the email is opened in a different browser than the one the user normally uses, the reset still
  completes correctly in the browser that opened the link, but that device/browser's other
  sessions elsewhere are unaffected until `signOut({scope:'global'})` propagates (which invalidates
  server-side sessions, not other browsers' cached UI state until they next make an authenticated
  request). Not independently tested live.
- **Installed PWA behavior specifically** — no PWA-specific redirect logic exists for this flow
  (it's plain SPA routing once `sw.js`'s network-first navigation strategy serves the page), but
  this was not exercised in an actual installed PWA window in this session.
- **`npm run test:e2e` (Playwright)** — not run; needs a real dev/staging Supabase project and
  `E2E_BASE_URL` per `CLAUDE.md`/`playwright.config.js`; do not point it at production.

## 8. Local vs. deployed status

- **Code changes**: applied locally in this working tree only. Nothing has been committed or
  pushed (per instructions, commits are only made when explicitly requested).
- **Local dev testing**: `npm test` and `npm run build` were run locally and passed (aside from
  the pre-existing unrelated pgtest path bug noted in §6). No live Supabase calls were exercised
  (no dev server session was driven through a browser in this task).
- **Deployed (cargoexpress-ph.online)**: unaffected so far — nothing has been deployed. The
  Supabase project's Redirect URL allow-list, Site URL, and email template (§5) were not
  inspected or changed, and I made **no production authentication setting changes**, per
  instruction.
- **Next step before shipping**: build and deploy this branch to a preview/staging environment (or
  run `npm run dev` locally against a disposable Supabase test project), then work through the
  live checklist in §7 with a disposable test account and an authorized test mailbox.

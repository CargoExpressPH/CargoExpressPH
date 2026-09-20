# Push Notification Enablement Fix

Date: 2026-09-16
Symptom: on `/customer/profile`, toggling Push Notifications on stays Disabled and shows
"Could not enable push notifications. Please try again."

## 1. Confirmed root cause and evidence

Traced the exact call chain the toggle makes:

```
ProfilePage.handlePushToggle(true)
  -> usePushNotification().enablePush()               [src/hooks/usePushNotification.js:33]
    -> Notification.requestPermission()                (real user-gesture click, confirmed)
    -> requestNotificationPermission(userId, {...})     re-exported from src/lib/push-notifications.js,
                                                          implemented in src/lib/firebase-messaging.js:111
      -> getCurrentFcmToken()
        -> getMessagingContext()
          -> app check (Firebase initialized?)
          -> isFcmSupported() check
          -> Notification.permission === 'granted' check
          -> service worker registration                <-- confirmed defect, see below
          -> getToken(messaging, { serviceWorkerRegistration, vapidKey })
      -> registerPushDevice(userId, token)                src/lib/push-device.js -> claim_push_device_registration RPC
```

**Confirmed defect:** `getMessagingContext()` obtained the service worker registration with
`navigator.serviceWorker.getRegistration('/')`. `index.html`'s own registration script (the
"Service Worker Registration" block) registers `/sw.js` inside a `window.addEventListener('load', ...)`
handler — i.e. registration only *starts* after the page finishes loading, and installing +
activating takes additional, variable time. `getRegistration('/')` returns a registration object
the instant one exists, **even while it is still installing**, with `.active` still `null`. The
Push API's `pushManager.subscribe()` — which Firebase's `getToken()` calls internally — requires
an *active* worker and rejects with an `InvalidStateError` against a registration with none. A
customer who opens the app and taps "Enable Push" before that installation finishes (a realistic
window on a fresh page load, especially on a slower mobile connection — the exact audience this
PWA targets per `src/lib/supabase.js`'s own 60s-timeout comment) hits exactly this failure, which
was previously swallowed by a bare `catch { return null; }` and surfaced only as the generic
`fcm_failed` → "Could not enable push notifications" toast.

This is a genuine, reproducible-by-code-inspection race condition, not a guess from the generic
error message — verified by reading `index.html`'s registration script, `public/sw.js`'s
`skipWaiting()`/`clients.claim()` behavior, and how `firebase/messaging`'s `getToken()` uses the
registration it's given (Push API spec: `subscribe()` requires `registration.active`).

**What was ruled out** (checked directly, not assumed):

| Candidate | Status | Evidence |
|---|---|---|
| Firebase app fails to init (missing `VITE_FIREBASE_*`) | Ruled out locally | All required vars present and non-empty in the local `.env` (`VITE_FIREBASE_API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID`, `MESSAGING_SENDER_ID`, `APP_ID`, `VITE_FIREBASE_VAPID_KEY`) — checked by length/presence only, values never printed. **Not verified for the deployed build** — see §8. |
| `public/firebase-messaging-sw.js`'s hardcoded config drifted from `.env` | Ruled out | Programmatically compared `apiKey`/`authDomain`/`projectId`/`messagingSenderId`/`appId` between `.env` and the hardcoded values in `firebase-messaging-sw.js` — all five match exactly (length-compared, values never printed). |
| `manifest.json` missing legacy `gcm_sender_id` | Not applicable | Modern FCM Web Push (VAPID, v1 API) doesn't use this field; irrelevant to this project's setup. |
| Competing service worker registrations / an update hook unregistering the worker | Ruled out | `src/hooks/useServiceWorkerUpdate.js` only listens for `controllerchange`; it never registers, unregisters, or replaces anything. Only one `register('/sw.js', { scope: '/' })` call exists in the app (`index.html`). |
| Duplicate/leftover device registrations from repeated attempts | Ruled out | `claim_push_device_registration` (`supabase/migrations/20260904235511_secure_push_registrations_and_policies.sql`) deletes any row matching the device's `device_id` OR the new `token` before inserting — repeated calls and account switches on the same device are already idempotent and cannot leak one account's push registration to another. |
| Token/RLS rejection at the database layer | Not the cause here, but now visible if it recurs | `claim_push_device_registration`'s FCM-token validation (length 20–4096, no whitespace/control chars) accepts real FCM tokens; RLS/RPC grants are correctly scoped to `authenticated`. `push-device.js`'s `registerPushDevice()` already had diagnostic logging added in this session (see below) that will print the exact Postgres error code/message if this is ever the actual failure. |
| .env / .env.example hygiene | Already correct | `.env.example` **already exists** (contrary to the "may not have one" premise) and already documents every `VITE_FIREBASE_*` var, `VITE_VAPID_PUBLIC_KEY`/`VITE_FIREBASE_VAPID_KEY`, and clearly separates them from server-only Edge Function secrets. `.gitignore` already ignores `.env`/`.env.*` with an explicit `!.env.example` exception, and `.env` is confirmed not tracked by git. No file was created or needed here. |

## 2. Exact stage that failed

**Service worker readiness**, inside `getMessagingContext()` in `src/lib/firebase-messaging.js` —
specifically the moment the code asked "is there a registration?" instead of "is there an *active*
registration?" before handing it to `getToken()`.

## 3. Files changed

| File | Change |
|---|---|
| `src/lib/firebase-messaging.js` | Replaced `navigator.serviceWorker.getRegistration('/')` with a new `getReadyServiceWorkerRegistration()` helper that awaits `navigator.serviceWorker.ready` (which only resolves once a registration is active), wrapped in a 10s timeout so an actual registration failure (404, script error) fails visibly instead of hanging the toggle forever. Also carries the `[push-debug]` diagnostic logging added earlier in this session (see below) at every failure branch of `getMessagingContext`, `getCurrentFcmToken`, and `requestNotificationPermission`. |
| `src/lib/push-device.js` | (Already carries diagnostic logging from earlier in this session — see §4.) No further change needed; reviewed again and confirmed correct for dedup, multi-device, and account-switch safety. |

No changes to RLS, RPC grants, authentication checks, or browser permission logic — the fix is
purely "wait for the service worker to actually be ready before asking it for a push token."

## 4. Diagnostic logging already in place (from earlier this session)

Both `src/lib/firebase-messaging.js` and `src/lib/push-device.js` already carry `console.error('[push-debug] ...')` lines at every point that previously failed silently: missing Firebase config, unsupported browser, permission not granted, no active service worker (new), `getToken()` throwing (with the Firebase error `.code`/`.message`), an empty token, `registerPushDevice` returning false, and the RPC/fallback-upsert error code and message. These are temporary and intentionally verbose — see "remaining verification steps" below for how to use them, and remove them once the deployed behavior is confirmed fixed.

## 5. Distinguishing failure categories (per the investigation checklist)

- **Unsupported browser**: `isFcmSupported()` false → logged explicitly, toast path unaffected (falls through to the generic message today; see note below).
- **Dismissed/blocked permission**: `Notification.permission !== 'granted'` after `requestPermission()` → hook returns `reason: 'denied'`, which already gets its own accurate toast ("Permission denied. Enable notifications in device settings.") — this is not the bug reported here, since it's already distinguished. If it does turn out to be blocked: **the user must change it in their browser's own site settings** (Chrome: address-bar padlock → Site settings → Notifications; Android: same, or Settings → Apps → Chrome → Notifications). The app cannot override this — and correctly does not try to re-prompt automatically.
- **Configuration failure** (Firebase never initializes) vs **token-registration failure** (Firebase works, but saving to Supabase fails): both previously produced the same silent `null` → same generic toast. They are now fully distinguished **in the console** by the `[push-debug]` logging (different messages for "firebase app is null" vs "registerPushDevice returned false" with the actual Postgres error). The user-facing toast still shows one generic message for both — deliberately not expanded further in this pass to keep the change narrowly scoped; splitting the toast copy is a small, separate follow-up if wanted.
- **Service-worker-not-active** (the confirmed root cause here): now has its own distinct log line and is structurally prevented by waiting for `navigator.serviceWorker.ready`.

## 6. Sending path (traced, not modified)

Verified this is a genuinely separate concern from enablement, and made no changes to it:

- Delivery is driven by `supabase/functions/send-push` plus the durable outbox tables added in
  `20260904235457_complete_push_delivery_system.sql` (push delivery jobs, retries, invalid-token
  cleanup) — this is a mature, already-hardened system independent of whether a *given* enable
  attempt succeeds.
- Foreground messages are handled by `onForegroundMessage` (`onMessage` from `firebase/messaging`)
  in the main app; background messages are handled by `public/firebase-messaging-sw.js`'s
  `onBackgroundMessage`. These are two different code paths for two different app states, not
  overlapping handlers — no duplicate-display risk identified.
- **This is completely separate from the email announcement subscription preference** — no code
  touched by this fix reads or writes `wants_announcements` anywhere. Confirmed by grep: neither
  `firebase-messaging.js` nor `push-device.js` references it.
- Not independently tested against a live device in this session (see §8).

## 7. Tests performed and actual results

| Check | Result |
|---|---|
| `npx vite build` | Succeeded, both before and after the fix — no build/type errors introduced. |
| Static trace of the full enable chain | Completed; documented above. |
| `.env` Firebase vars present/non-empty | Confirmed programmatically (presence/length only — no values printed). |
| `.env` vs `firebase-messaging-sw.js` hardcoded config consistency | Confirmed programmatically, exact match on all 5 fields (length-compared, values never printed). |
| RLS/RPC review for duplicate registration, multi-device, account-switch leakage | Confirmed correct by reading the migration SQL directly. |
| `.gitignore`/`.env.example` hygiene | Confirmed already correct; no changes needed. |

**Not performed in this session — I do not have a browser or a live device here:**

- Actually clicking the toggle in a real browser and confirming it now succeeds.
- Confirming the exact `[push-debug]` console output on a real device.
- A real device receiving a test push end-to-end (enable → send-push → device).
- Testing on the deployed (Vercel) build specifically — only the local `.env` and the local build
  were inspected.
- iOS/Safari Web Push path (`push-notifications.js`'s Apple branch) — this fix only touches the
  FCM/Chrome/Android/desktop path (`firebase-messaging.js`). The same theoretical
  registration-not-yet-active race exists in `getIosServiceWorkerRegistration()` too, but was left
  untouched to keep this change narrowly scoped to the reported symptom; flagging it as a residual
  if iOS push enablement shows the same intermittent failure.

Do not treat any of the above as passed based on this code review alone.

## 8. Local vs. deployed status

- **Local `.env`**: has all required Firebase client variables, non-empty, and consistent with the
  hardcoded values in the messaging service worker.
- **Deployed environment (Vercel or wherever this is hosted)**: **not verified**. `VITE_`-prefixed
  variables are inlined into the client bundle at *build* time — if the hosting dashboard is
  missing or has stale values for `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, or `VITE_FIREBASE_VAPID_KEY`, the
  deployed app will fail differently (and earlier — Firebase never initializes) than what was
  fixed here, and **updating `.env.example` or the local `.env` has no effect on that build at
  all**. This is a separate, unverified failure mode from the one fixed in this session.
- Nothing was pushed, deployed, or changed in the Supabase project or Vercel dashboard.

## 9. Exact remaining steps

1. **Deploy this change** (or run `npm run dev`/`npm run build && npm run preview` locally) and
   reproduce the toggle click with DevTools console open. Every `[push-debug]` line will now say
   exactly which stage failed if it still fails.
2. **If it now succeeds**: remove the temporary `[push-debug]` console logging from
   `src/lib/firebase-messaging.js` and `src/lib/push-device.js` before considering this closed —
   it was left in deliberately for this verification step, not intended to ship long-term.
3. **If it still fails**: check which `[push-debug]` line printed —
   - "firebase app is null" → check the **hosting provider's** environment variable dashboard, not
     `.env` (build-time only, must be set before `npm run build`, on the Production environment
     specifically).
   - "no ACTIVE service worker" / "service worker never became active" → open DevTools →
     Application → Service Workers on the live site; check `/sw.js` returns real JavaScript (not
     the SPA's HTML fallback) and actually reaches "activated".
   - "getToken() threw" with an error code → that code (e.g.
     `messaging/token-subscribe-failed`) points at a genuine Firebase/VAPID-key mismatch, most
     often a stale browser-side push subscription from before the current VAPID key was set —
     clearing site data for that origin and retrying isolates this.
   - "claim_push_device_registration RPC failed" with a Postgres error code → a real RLS/validation
     failure, and the code+message will say exactly what.
4. Confirm the deployed `VITE_FIREBASE_*`/`VITE_FIREBASE_VAPID_KEY` values match the actual Firebase
   project — this cannot be done from this environment.

---

## Taglish summary

**Bakit hindi ma-enable, ano ang inayos, at ano pa ang kailangan naming gawin?**

Yung dahilan kung bakit hindi ma-enable ang push notifications: pag bagong bukas lang ng app, yung
"service worker" (yung background script na kailangan para makatanggap ng push) ay nagre-register
pa lang — hindi pa siya fully "active." Kapag pinindot agad ng customer yung "Enable Push" bago pa
matapos yun, sinasabi ng Firebase na "hindi pwede, wala pang aktibong service worker" — pero dahil
naka-generic catch lang dati yung error, ang lumalabas lang sa customer ay "Could not enable push
notifications. Please try again," kahit ibang-iba pala ang tunay na dahilan.

Inayos ko na yung code para maghintay muna talaga ito hanggang tunay na "active" na yung service
worker bago mag-attempt kumuha ng push token — hindi na basta "meron bang naka-register," kundi
"gumagana na ba talaga siya." Nilagyan ko rin ng detalyadong console logs (temporary lang, para sa
debugging) sa bawat hakbang, para kung may mapalabas pa ring error sa production, makikita agad
KUNG SAAN talaga ito na-stuck — hindi na basta hulaan.

Ang hindi ko pa nagagawa (kailangan ng browser/live na device na wala ako dito): i-verify mismo sa
totoong deployed site (hal. Vercel) kung tama yung mga Firebase environment variables doon — dahil
lokal na `.env` lang ang nachek ko. Kung may environment variable na mali o kulang sa deployed
site, ibang klaseng error pa ang lalabas (mag-fa-fail agad ang Firebase init, hindi na ito yung
service-worker timing issue na inayos dito). Kaya kailangan pa rin i-deploy itong fix, subukan sa
totoong browser, at tingnan yung console logs kung may error pa ring lalabas.

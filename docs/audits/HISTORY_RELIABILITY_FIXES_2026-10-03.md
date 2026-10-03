# Booking and financial history reliability fixes

Date: 2026-10-03

## Implemented scope

All seven requested findings are addressed in this change. These fixes use the existing Supabase Free plan and require no database migration or provider setting change.

| Requested priority | Finding | Implemented behavior |
| --- | --- | --- |
| #8 | F03: failed queries appear as zero orders/totals | Customer and trip detail order reads propagate failures. A failed page rejects the entire read; the screen shows an error and Retry. A successful empty query can still show zero. |
| #10 | F01: stale booking filters | A request guard ties results to the current user, filter, search and page. Obsolete successes, errors and loading updates cannot replace newer results. |
| #11 | F07: stale customer/trip details | The same guard protects route changes, repeated loads and unmounts. Customer/trip data resets on a record change. Old trip gate refreshes cannot update another trip. |
| #7 | F02: login fails with blocked storage | Remembered-email preferences and onboarding storage reads/writes catch denied or full storage. The login form and success navigation remain usable. |
| #9 | F04: inconsistent financial month | Payment month grouping and date labels explicitly use Asia/Manila. Named date parts avoid relying on Safari locale formatting order. |
| #12 | F05: comma searches fail | Booking and activity search values are quoted and escaped for PostgREST grammar, including commas, parentheses, quotes and backslashes. Existing ILIKE wildcard behavior is retained. |
| #17 | F06: incomplete histories above 1,000 | Complete order reads use created_at/id cursors. Customer and trip detail summaries include every returned page. Payment, refund and failed-attempt history RPCs are paged for every ID chunk. Lower server response caps do not silently truncate histories. |

The order history cursor includes a secondary ID order and supports nullable legacy timestamps. Search predicates and cursor predicates are composed into one OR expression, because calling the query builder's OR method twice would replace the first expression.

Explicit admin pagination and limited home-page reads preserve their existing response shapes. Financial calculations still use the existing payment/refund rules and authoritative trip weight RPC. Authorization filters and history RPCs remain in place.

The customer payment error screen now includes Retry. It does not render partial totals after a failed history page.

## Verification

The production source was checked with the complete project check command, including existing application/database regression checks, all 20 edge-function builds, photo fallback browser checks, production compilation, SEO checks and PWA cache contracts.

Additional executable checks:

- **14 data checks** run actual application query functions through the installed Supabase query builder with a local fixture transport. Cases include 2,005 orders, tied timestamps, customer scoping, 127-row server caps, inserts/deletes between reads, null timestamps, legitimate empty histories, first/later page failures, quoted searches and timezone boundaries.
- Ledger checks include 1,301 payment rows, 1,201 refund rows, 1,301 failed attempts and 205 order IDs. Failed later pages for each ledger reject the whole history.
- **22 Chrome and 22 WebKit UI checks** mount the actual changed components under React StrictMode with isolated data/auth fixtures and real application styles. They cover stale successes/errors/loading, route changes, unmounts, error/retry recovery, remembered preferences, storage-denied login/onboarding, histories beyond 1,000 and payment totals.
- Phone/tablet layout checks use widths **320, 375, 390 and 768 pixels**. These checks also run with String.prototype.replaceAll unavailable; the new production helpers do not require that API.
- **Four production PWA scenarios** exercise the actual compiled application and service worker: browser and emulated standalone mode in Chrome and WebKit. Each checks denied-storage login rendering, an active worker, all **160 JS/CSS/font assets** cached, reload without the application server and recovery when networking returns.
- Read-only live parser controls on the public trips table return HTTP 200 for escaped search grammar, composed cursor filters and nullable-date cursor branches. They do not access private customer histories or change live data.

Fixture tests block external requests or supply local responses. Live payment, broadcast, email and business-data write tests were not used for this verification.

### Verification environment corrections

Each UI test engine has its own Vite dependency cache to prevent competing test servers from interrupting module loading.

Vite preview adds Vary: Origin by default. That header caused module requests to miss worker precache entries during the first PWA test. The public deployed assets were checked and do not have that header. The PWA test disables preview CORS to reproduce the deployed static host; no production worker change was necessary.

Windows WebKit's Playwright driver reports an internal error when offline navigation is enabled through its driver API. The WebKit PWA scenarios instead refuse actual local server connections, exercising the worker's fetch-failure/cache-recovery path. Chrome uses the normal browser offline setting.

## Practical limits

These passing checks support release of the seven fixes. They cannot prove zero possible bugs or certify every device/browser.

- WebKit automation is not a physical iPhone test, and standalone mode is emulated rather than installed through the iOS home screen. Physical older iPhone testing remains unverified.
- The repository uses Vite 6's default compilation target, whose browser baseline includes Safari 14. This is a syntax target, not a full application compatibility certification. Earlier Safari/iOS support is not established by these changes. See [Vite 6 build options](https://v6.vite.dev/config/build-options).
- When browser storage is unavailable, preferences and the authentication SDK's in-memory session cannot be retained across a complete reload. Sign-in still requires networking and a working authentication service.
- Complete history reads use additional requests and browser memory. The payment screen retains its existing 15-second load deadline and offers Retry when loading fails or times out. Histories are not a transactionally frozen database snapshot while concurrent records change.
- Other findings from the wider system audit are outside these seven fixes. This report is not a certification of the entire system.

## Repeat verification from PowerShell

Run these commands from the repository root. The main check builds the app and includes Chrome UI/PWA checks; WebKit checks are separate.

```powershell
npm run check
npm run test:history-browser:webkit
npm run test:history-pwa:webkit
```

Chrome and the Playwright WebKit browser must be installed for their respective browser commands. The new tests do not require private PAT credentials or live customer logins.

## Credential handling

The local Git remote was changed to a credential-free HTTPS URL after a GitHub credential appeared in its URL output. Authentication for fetch/push uses an ephemeral askpass helper. Private .env credentials and local audit files are excluded from the implementation commit. The exposed GitHub credential should be rotated after this work.

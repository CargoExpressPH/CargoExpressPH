# CargoExpress PH — Customer Service Workflow

**Study & restructure plan**
**Status:** Design only. **No code has been modified.**
**Date:** 4 August 2026
**Data source:** live Supabase project `duigaivxgxlnjmfienhg`, queried 4 August 2026

> ### ⚠ Revision, 4 August 2026 — read before quoting section 4
>
> After this study was written, the project owner confirmed that **chat support is still in its
> testing phase and has not carried real customer traffic.**
>
> That invalidates the *behavioural* readings in [§4.2](#42-response-time--the-core-problem-quantified)
> and [§4.4](#44-timing--admins-reply-when-customers-arent-writing). The 54-hour median, the 47-day
> worst case, the 20% never-answered rate and the "admins reply on Saturday" pattern describe the
> developer and testers exercising the feature at irregular hours — **not customers being kept
> waiting.** They must not be cited as an operational baseline, and the SLA ladder in
> [§6.3](#63-sla-targets--calibrated-to-your-numbers) has been **withdrawn from Phase 1**; targets
> will be set once real traffic exists.
>
> **What is unaffected:** Findings [1](#finding-1--closed-means-two-opposite-things--critical),
> [2](#finding-2--no-timestamps-so-no-measurable-service--high),
> [4](#finding-4--bot-outcomes-are-invisible--medium) and
> [5](#finding-5--assignment-is-one-way--medium) are facts about the *code*, established by reading
> it, and hold with zero customers: a conversation is born `closed`, an admin finishing also writes
> `closed`, and `conversations` carries no service timestamps. The measurements were the motivation
> for the restructure, not its justification — the design stands on the structural argument alone.
>
> Shipping the instrumentation *before* launch is now the stronger reason to proceed: it means the
> first real month of traffic produces a genuine baseline instead of another reconstruction.
>
> Scope also narrowed by decision: **Phase 3's shared queue is cancelled.** `contact_inquiries`
> gets an assignee and a response stamp on its existing page; the Inbox stays exclusively for
> live chat.

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [Method](#2-method)
3. [What exists today](#3-what-exists-today)
4. [What the data says](#4-what-the-data-says)
5. [Findings](#5-findings)
6. [The proposed workflow](#6-the-proposed-workflow)
7. [Database changes](#7-database-changes)
8. [Admin UI restructure](#8-admin-ui-restructure)
9. [Implementation plan](#9-implementation-plan)
10. [Risks](#10-risks)
11. [Decisions I need from you](#11-decisions-i-need-from-you)

---

# 1. Executive summary

I expected to find that CargoExpress has no ticketing model. That is **not** what the code
shows. `conversations` already carries `status` and `assigned_admin_id`, the inbox already
sorts waiting customers to the top, and first admin reply already auto-assigns the
conversation. The scaffolding is there.

The problem is narrower and more specific:

> **`closed` is the state a conversation is *born* in.**
> A brand-new conversation is inserted with `status = 'closed'` so the bot answers first.
> An admin finishing a conversation also sets `status = 'closed'`.
> One value means both *"never needed a human"* and *"a human is done"* — so
> **"nobody has replied to this customer" is not a state the system can represent.**

Everything downstream follows from that. There is no queue of unanswered customers, because
unanswered and finished look identical. The measured consequence, from the live database:

| | |
|---|---|
| Median time to first admin reply | **54 hours** |
| Mean time to first admin reply | **186 hours** (7.8 days) |
| Worst case | **1,124 hours** (47 days) |
| Customer messages that never got a human reply | **13 of 64 (20%)** |
| Conversations sitting in `closed` with the customer's message last | **2**, idle up to **43.6 days** |

Those two `closed`-but-waiting conversations are the finding in miniature. Nothing is broken,
no error was thrown, and the inbox looks tidy — the customers were simply filed away.

The fix is **not** an enterprise ticketing system. At 7 conversations and 64 customer messages
across three months, this is a two-person operation and any workflow with queues, tiers and
routing rules would be abandoned within a week. The recommendation is to **split the overloaded
`closed` state, record two timestamps, and unify the second intake channel** — roughly one
migration and a reworked inbox header.

---

# 2. Method

Every number in section 4 came from querying the live database directly. Every claim about
behaviour in section 3 was traced to a specific file and line. Where the repository's own
documentation contradicted the database, I trusted the database and noted the drift.

Sources read:

| File | Lines | Role |
|---|---|---|
| `src/pages/admin/InboxPage.jsx` | 929 | Admin inbox — 4 realtime channels, filter tabs, reply box |
| `src/pages/customer/SupportChatPage.jsx` | 696 | Customer chat, bot orchestration, escalation triggers |
| `src/lib/supportChatEngine.js` | 474 | Regex intent matcher + escalation patterns |
| `src/pages/admin/ContactInquiriesPage.jsx` | 398 | The *other* intake channel |
| `src/lib/database.js` | §chat | `getOrCreateConversation`, `assignConversation`, `closeConversation`, `setConversationWaitingAdmin` |

---

# 3. What exists today

## 3.1 Two intake channels that never meet

```
Signed-in customer                     Anonymous website visitor
        │                                          │
        ▼                                          ▼
  SupportChatPage                            Contact form
        │                                          │
        ▼                                          ▼
  conversations (7)                        contact_inquiries (8)
  chat_messages (150)                      status: read | resolved
  status: open|closed|waiting_admin        assignee: none
  assigned_admin_id                        realtime: yes
        │                                          │
        ▼                                          ▼
  Admin → Inbox                            Admin → Contact Inquiries
```

They share nothing: not a table, not a queue, not a page, not a status vocabulary. An admin who
works the Inbox to zero has no indication that an inquiry is waiting on the other page, and
vice versa. Roughly **half of all customer contact** (8 inquiries vs 7 conversations) arrives
through the channel with no assignment model at all.

## 3.2 The conversation lifecycle as built

`conversations.status` is constrained to exactly three values:

```sql
CHECK (status = ANY (ARRAY['open', 'closed', 'waiting_admin']))
```

And the transitions, traced from code:

| Trigger | Where | Effect |
|---|---|---|
| Customer opens chat for the first time | `getOrCreateConversation` (`database.js:1275`) | INSERT with **`status = 'closed'`** — "bot is first responder" |
| Bot matches an escalation pattern | `SupportChatPage.jsx:420` | → `waiting_admin` |
| Customer answers "No, not resolved" | `SupportChatPage.jsx:482` | → `waiting_admin` |
| Admin sends first reply while `waiting_admin` | `InboxPage.jsx:403–416` | → `open`, auto-assigns to that admin |
| Admin clicks Close | `closeConversation` | → `closed` |
| Admin starts a conversation with a customer | `InboxPage.jsx:375` | if `closed`, silently → `open` |

The inbox sorts `waiting_admin` to the top (`InboxPage.jsx:58`) and offers three filter tabs —
Waiting / Active / Closed — mapping to the three statuses.

**This is a reasonable design that has one load-bearing flaw**, described in Finding 1.

## 3.3 The bot

`supportChatEngine.js` is a regex matcher — no LLM, no learning. It runs *authenticated* and
queries the signed-in customer's own orders, which is why it can answer "where is my shipment"
concretely. Structure:

1. **~20 escalation patterns** checked first (complaint, damaged, refund, lost, urgent, "talk
   to a human"). A match returns `{ escalate: true, text: null }` and the bot stays silent.
2. **Intent matching** — status, tracking number, payment/balance, booking, timeline, pricing.
3. **Fallback** — a menu plus `askResolved: true`, which shows the customer a Yes/No prompt.
   "No" escalates.

The escalation path is well designed: a customer saying "my package is damaged" never gets a
cheerful automated reply. That deserves to be preserved exactly as-is.

---

# 4. What the data says

*All figures from the live database, 4 August 2026.*

## 4.1 Volume — this is a small operation

| Metric | Value |
|---|---|
| Conversations | 7 |
| Chat messages | 150 |
| — from customers | 64 |
| — from the bot | 67 |
| — from admins | **19** |
| Contact inquiries | 8 |
| Period covered | 4 May – 4 August 2026 (13 weeks) |

Busiest week: 23 customer messages (week of 6 July). Typical week: 3–6. **Admins have sent 19
messages in three months.**

This single fact should discipline every recommendation below. Any workflow that costs more
than a few seconds per conversation will not survive contact with a two-person team.

## 4.2 Response time — the core problem, quantified

Measuring each customer message to the next admin message in the same conversation:

| Metric | Value |
|---|---|
| Customer messages | 64 |
| Eventually got an admin reply | 51 (80%) |
| **Never got a human reply** | **13 (20%)** |
| Median wait | **3,248 min ≈ 54 hours** |
| Mean wait | 11,186 min ≈ 186 hours |
| Worst | 1,124 hours ≈ **47 days** |

The gap between median (54h) and mean (186h) says the delays are not uniform — a few
conversations were forgotten for weeks and dragged the average out.

## 4.3 Bot deflection — genuinely working, but unmeasurable

| Metric | Value |
|---|---|
| Customer messages answered by the bot within 2 minutes | 33 (52%) |
| Bot answered and **no human ever followed up** | 12 |
| No reply from anyone — bot or human | 1 |

Those 12 are ambiguous *by construction*. Either the bot resolved the question (a success worth
celebrating) or the customer gave up (a failure worth fixing). **The current data model cannot
distinguish them**, which is why Finding 4 proposes the cheapest possible signal.

## 4.4 Timing — admins reply when customers aren't writing

Customer messages by hour (Asia/Manila):

| Hour | 10:00 | 11:00 | 12:00 | 13:00 | 17:00 | **19:00** |
|---|---|---|---|---|---|---|
| Messages | 7 | 6 | 4 | 13 | 7 | **15** |

By weekday:

| | Sun | Mon | Tue | **Wed** | Thu | Fri | Sat |
|---|---|---|---|---|---|---|---|
| Customer | 2 | 17 | 7 | **20** | 2 | 9 | 7 |
| Admin | 4 | 1 | 2 | 4 | 0 | 2 | **6** |

Customer demand peaks **Monday and Wednesday**, and in the **evening (19:00)**. Admin replies
peak **Saturday**. The team is answering on the quietest day of the week. A single daily
check at the right time would move the median more than any software change in this document.

## 4.5 Contact inquiries — a slower, parallel backlog

| Status | Count | Mean age | Oldest |
|---|---|---|---|
| `resolved` | 7 | 29.7 days | 64.8 days |
| `read` | 1 | 0.6 days | 0.6 days |

Note `read` is a state that means "an admin opened it and did nothing yet" — the same
ambiguity as `closed`, in the second channel.

## 4.6 Documentation drift found along the way

- `database.js:1259` says *"no unique constraint on customer_id"* and works around it with
  `.limit(1)`. **A unique index does exist** on the live database, and there are **0**
  duplicate conversations. The comment is stale; the defensive code is harmless and can stay.
- `CLAUDE.md`'s claim of one conversation per customer is **correct**.

---

# 5. Findings

### Finding 1 — `closed` means two opposite things — **critical**

A new conversation is born `closed` (bot-first). An admin finishing a conversation also sets
`closed`. Therefore:

- The Closed tab mixes *"bot handled it"*, *"admin resolved it"*, and *"we ignored a human being for 43 days"*.
- **"Awaiting first human reply" is not representable**, so it cannot be counted, filtered, alerted on, or reported.
- 2 conversations are `closed` right now with the customer's message last — idle 2.8 and 43.6 days.

Everything else in this list is downstream of this.

### Finding 2 — no timestamps, so no measurable service — **high**

`conversations` has `created_at` and nothing else. There is no `first_response_at`, no
`last_customer_message_at`, no `resolved_at`. Every number in section 4 had to be reconstructed
by scanning `chat_messages` with window functions. The team cannot see its own response time,
so it cannot manage it.

### Finding 3 — two intake channels, one of them unmanaged — **high**

`contact_inquiries` has no assignee, no link to a customer profile, no shared queue with the
Inbox. It holds 8 of the ~15 total customer contacts. Its `read` status carries the same
"opened but not acted on" ambiguity as `closed`.

### Finding 4 — bot outcomes are invisible — **medium**

12 conversations ended with a bot reply and no human follow-up. Success and abandonment are
indistinguishable. Without a signal, there is no way to know whether the bot is deflecting work
or losing customers — and no way to know which intents to improve.

### Finding 5 — assignment is one-way — **medium**

`assignConversation` sets `assigned_admin_id` on first reply. There is no unassign, no
reassign, no "assigned to someone who is on leave" recovery. With two admins this is survivable;
it becomes a real problem at three.

### Finding 6 — no first-response alerting — **medium**

Nothing notifies an admin that a `waiting_admin` conversation has been waiting. The push
infrastructure (`send-push`, dual FCM + Web Push) already exists and is used for order events.
Given 4.4 — customers write in the evening, admins reply on Saturday — a single nudge would
likely be the highest-leverage change here.

### Finding 7 — no canned replies — **low**

19 admin messages over three months is too few to justify a template library yet. Worth
revisiting past ~50 messages/month.

---

# 6. The proposed workflow

## 6.1 The state machine

Split the overloaded `closed` into what it actually represents. Five states, one flag:

```
                    customer opens chat
                            │
                            ▼
                    ┌───────────────┐   bot answers, customer satisfied
                    │   bot_active  │──────────────────────────────┐
                    └───────┬───────┘                              │
                            │ escalation pattern                   │
                            │ or "No, not resolved"                │
                            ▼                                      │
                    ┌───────────────┐                              │
                    │    waiting    │  ← SLA CLOCK RUNS HERE       │
                    └───────┬───────┘                              │
                            │ admin sends first reply              │
                            │ (auto-assign, stamp first_response)  │
                            ▼                                      │
                    ┌───────────────┐                              │
              ┌────▶│     open      │                              │
              │     └───────┬───────┘                              │
              │             │ admin awaits customer                │
              │             ▼                                      │
              │     ┌───────────────┐                              │
              │     │waiting_customer│                             │
              │     └───────┬───────┘                              │
              │             │ customer replies → open              │
              │             │ 7 days silence  → resolved           │
              │             ▼                                      │
              │     ┌───────────────┐                              │
              └─────│   resolved    │◀─────────────────────────────┘
       customer     └───────────────┘
       writes again
```

**`escalated` is a boolean flag, not a state.** A conversation can be escalated *and* open —
they answer different questions ("how urgent" vs "whose turn is it"). Collapsing them into one
column is what produced Finding 1.

Mapping from today's three values:

| Today | Becomes | Why |
|---|---|---|
| `closed` (new, bot-first) | `bot_active` | Never involved a human; not a backlog item |
| `closed` (admin finished) | `resolved` | A real outcome |
| `waiting_admin` | `waiting` | Same meaning, clearer name |
| `open` | `open` | Unchanged |
| — | `waiting_customer` | New: we replied, ball is in their court |

The migration can separate the two `closed` populations exactly: a `closed` conversation whose
**last message is from an admin** is `resolved`; anything else is `bot_active` — except the two
where a customer is still waiting, which become `waiting` and reappear in the queue. That is
the point.

## 6.2 Priority

Priority should be **derived, not typed**. Asking a two-person team to triage by hand is asking
them to skip it. Derive it:

| Priority | Condition |
|---|---|
| **Urgent** | Escalation pattern matched *and* the customer has an order with an unsettled balance or an active shipment |
| **High** | Escalation pattern matched, or waiting > 24h |
| **Normal** | Everything else in `waiting` |
| **Low** | `bot_active` with no escalation |

Every input already exists — the escalation flag from the bot, and the orders join the inbox
already performs.

## 6.3 SLA targets — calibrated to *your* numbers

Standard support SLAs (1-hour first response) are meaningless here. Against a **54-hour
median**, here is a ladder that is demanding but achievable for two people:

| Target | Now | Phase 1 | Phase 2 |
|---|---|---|---|
| Median first response | 54 h | **8 h** | 4 h |
| 90th percentile | ~187 h | **24 h** | 12 h |
| Never-answered rate | 20% | **0%** | 0% |
| Urgent first response | — | 4 h | 1 h |

**The 0% never-answered target matters more than any latency number.** A customer who waits 8
hours is mildly annoyed; a customer who is never answered is gone. It is also the easiest to
hit — it requires a queue that cannot silently empty, which is exactly what section 6.1 builds.

Operating rule to pair with it, drawn from 4.4: **one queue check each evening (≈19:00, the
demand peak) and one Monday morning.** Two checks a week would have prevented every one of the
13 unanswered messages.

---

# 7. Database changes

## Phase 1 — the state split (one migration)

```sql
-- 1. Widen the CHECK constraint
ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('bot_active','waiting','open','waiting_customer','resolved'));

-- 2. Service columns
ALTER TABLE conversations
  ADD COLUMN escalated                 BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN first_response_at         TIMESTAMPTZ,
  ADD COLUMN last_customer_message_at  TIMESTAMPTZ,
  ADD COLUMN resolved_at               TIMESTAMPTZ,
  ADD COLUMN bot_resolved              BOOLEAN;      -- NULL = unknown, the honest default

-- 3. Backfill (separates the two populations of `closed`)
UPDATE conversations c SET status = CASE
  WHEN c.status = 'open'          THEN 'open'
  WHEN c.status = 'waiting_admin' THEN 'waiting'
  WHEN EXISTS (SELECT 1 FROM chat_messages m
                WHERE m.conversation_id = c.id AND m.sender_role = 'admin')
   AND (SELECT sender_role FROM chat_messages m WHERE m.conversation_id = c.id
         ORDER BY created_at DESC LIMIT 1) = 'admin'
       THEN 'resolved'
  WHEN (SELECT sender_role FROM chat_messages m WHERE m.conversation_id = c.id
         ORDER BY created_at DESC LIMIT 1) IN ('customer','bot')
   AND EXISTS (SELECT 1 FROM chat_messages m
                WHERE m.conversation_id = c.id AND m.sender_role = 'customer')
       THEN 'waiting'        -- the 2 forgotten conversations resurface here
  ELSE 'bot_active'
END;

-- 4. Backfill timestamps from message history
UPDATE conversations c SET
  first_response_at = (SELECT MIN(created_at) FROM chat_messages
                        WHERE conversation_id = c.id AND sender_role = 'admin'),
  last_customer_message_at = (SELECT MAX(created_at) FROM chat_messages
                        WHERE conversation_id = c.id AND sender_role = 'customer');
```

## Phase 1 — keep the timestamps honest with a trigger

Following the codebase's established principle — *derived values are computed server-side, never
written by a client*, exactly like `update_order_payment_totals`:

```sql
CREATE FUNCTION maintain_conversation_service_state() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_role = 'customer' THEN
    UPDATE conversations
       SET last_customer_message_at = NEW.created_at,
           status = CASE WHEN status IN ('resolved','waiting_customer')
                         THEN 'waiting' ELSE status END
     WHERE id = NEW.conversation_id;

  ELSIF NEW.sender_role = 'admin' THEN
    UPDATE conversations
       SET first_response_at = COALESCE(first_response_at, NEW.created_at),
           status = CASE WHEN status IN ('waiting','bot_active')
                         THEN 'open' ELSE status END
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

This makes a resolved conversation **reopen automatically** when the customer writes again —
closing the "filed away while they were still talking" failure mode structurally rather than by
asking admins to remember.

## Phase 2 — unify the second channel

Give `contact_inquiries` the same vocabulary rather than merging the tables (merging would mean
reworking the anonymous-insert RLS policy, which is a security-sensitive surface not worth
disturbing):

```sql
ALTER TABLE contact_inquiries
  ADD COLUMN assigned_admin_id UUID REFERENCES profiles(id),
  ADD COLUMN first_response_at TIMESTAMPTZ,
  ADD COLUMN resolved_at       TIMESTAMPTZ,
  ADD COLUMN linked_conversation_id UUID REFERENCES conversations(id);
```

Then a single admin-gated RPC, `get_service_queue()`, returns both sources in one shape — the
same pattern as `get_sales_summary()`.

## RLS

No policy changes needed in Phase 1. The existing rules already cover the new columns:
participants read their own conversation; admins read all; `guard_chat_message_insert` already
overwrites `sender_id`/`sender_role` from `auth.uid()`, so a customer cannot forge an admin
message to fake a response time. **The new trigger must be `SECURITY DEFINER`** so a customer's
INSERT can update the parent conversation row they do not own.

---

# 8. Admin UI restructure

`InboxPage.jsx` is 929 lines with four realtime subscriptions. The changes are additive.

**Queue header** — replace the three filter tabs with four counts that make the backlog
impossible to miss:

```
┌──────────────────────────────────────────────────────────────┐
│  ⚠ 2 WAITING > 24h    ·    3 Waiting    ·    1 Open    ·  … │
└──────────────────────────────────────────────────────────────┘
```

- **Waiting > 24h** first, in the error colour, and shown even when zero (a visibly empty queue
  is the reassurance; a hidden one is how things get forgotten).
- Age badge per row: "waiting 3h" / "waiting 4 days", coloured past threshold.
- Reuse `useRealtimeOrders`' debounce pattern for the counts.

**Conversation header** — assignee with a reassign control, escalation flag, first-response
stamp, and a **Resolve** button that replaces Close (the word matters: *resolved* is a claim
about the customer, *closed* is a claim about the admin's screen).

**Bot outcome capture** (Finding 4) — after a bot answer with no follow-up, the *customer* sees
"Did that answer your question? 👍 / 👎". One tap writes `bot_resolved`, turning 12 ambiguous
conversations into a deflection metric and a list of intents to improve.

**Service tab in Sales & Reports** — median first response, never-answered count, bot deflection
rate, volume by weekday/hour. It belongs beside the financial reporting for the same reason the
Unsettled list does: it is how the business is actually performing.

---

# 9. Implementation plan

| Phase | Work | Est. | Risk |
|---|---|---|---|
| **1a** | Migration: states, columns, backfill, trigger | 1 session | Low — additive, reversible |
| **1b** | `database.js` state helpers; `InboxPage` queue header + age badges | 1 session | Low |
| **1c** | Resolve/reopen + reassign controls | ½ session | Low |
| **2a** | Push notification on `waiting` > 4h (reuses `send-push`) | ½ session | Medium — notification fatigue if mistuned |
| **2b** | Bot 👍/👎 capture | ½ session | Low |
| **3a** | `contact_inquiries` columns + `get_service_queue()` RPC | 1 session | Medium — touches anon-insert RLS surface |
| **3b** | Unified queue UI + Service reporting tab | 1 session | Low |

Phase 1 alone addresses Findings 1, 2 and 6 — the critical and high items — and is where I
recommend stopping to use the system for two weeks before building anything further.

---

# 10. Risks

| Risk | Mitigation |
|---|---|
| **The backfill mislabels history.** The `closed` split is a heuristic on the last message's sender. | Run the SELECT form first and eyeball all 7 rows — the dataset is small enough to verify by hand, which will not be true later. |
| **Auto-reopen surprises admins.** A resolved conversation jumping back to `waiting` may feel like a bug. | It is the point of the change; state it in the release note and show "reopened" on the row. |
| **Notification fatigue.** A 4h nudge that fires during dinner gets muted, and then order notifications get muted too. | Batch into one digest at 09:00 and 19:00 rather than per-conversation alerts. |
| **The status vocabulary changes under a live inbox.** | The CHECK constraint widens *before* any write uses a new value; deploy the migration first, the UI second. |
| **Phase 3 touches the anonymous-insert policy** on `contact_inquiries`. | Additive columns only; do not alter the INSERT policy. Re-run `supabase db advisors` afterwards. |

---

# 11. Decisions I need from you

1. **Is `bot_active` really a non-queue state?** My assumption: a customer chatting with the bot
   is not a backlog item until they escalate. If you would rather *see* every live conversation,
   `bot_active` should appear in the queue with Low priority instead.

2. **What is a realistic evening check?** The 8-hour median target in 6.3 assumes roughly two
   queue checks per day. If the real answer is "once a day, in the morning", say so and I will
   set the target at 24h — **a target you will hit beats a target that looks good in a report.**

3. **Auto-resolve after silence?** Section 6.1 proposes `waiting_customer` → `resolved` after 7
   days of silence. It keeps the queue clean but can close a conversation the customer thought
   was still open. Auto-reopen on their next message mitigates it. Keep, or resolve only by hand?

4. **Phase 3 at all?** Unifying `contact_inquiries` is the largest chunk and touches a security
   surface we just audited. Given 8 inquiries in three months, adding an assignee and a
   first-response stamp to the existing page may be enough — the shared queue may be
   over-engineering for your volume.

---

## Appendix — reproducing these numbers

```sql
-- Response latency (§4.2)
WITH cust AS (
  SELECT conversation_id, created_at AS asked
    FROM chat_messages WHERE sender_role = 'customer'
), replied AS (
  SELECT c.*, (SELECT MIN(a.created_at) FROM chat_messages a
                WHERE a.conversation_id = c.conversation_id
                  AND a.sender_role = 'admin'
                  AND a.created_at > c.asked) AS answered
    FROM cust c
)
SELECT COUNT(*) AS customer_msgs,
       COUNT(answered) AS got_reply,
       ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (
         ORDER BY EXTRACT(EPOCH FROM (answered - asked))/60))::numeric, 1) AS median_min
  FROM replied;

-- Conversations awaiting a human (§4.2, Finding 1)
WITH last_msg AS (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_role, created_at
    FROM chat_messages ORDER BY conversation_id, created_at DESC
)
SELECT c.status, COUNT(*) AS convs,
       COUNT(*) FILTER (WHERE l.sender_role IN ('customer','bot')) AS awaiting_admin,
       ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - l.created_at))/86400)::numeric, 1) AS oldest_idle_days
  FROM conversations c LEFT JOIN last_msg l ON l.conversation_id = c.id
 GROUP BY c.status;
```

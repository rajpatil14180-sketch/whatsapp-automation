# Lead Response System

Catches Meta lead-ad submissions the instant they arrive, opens a WhatsApp conversation, qualifies the lead with Claude (intent + blocker + extracted fields), replies in real time, follows up with non-repliers, and alerts a counsellor the moment a lead is hot.

Built **multi-tenant** — one row in the `tenants` table per consultancy you serve. Adding a client is a config insert, not a code change.

---

## How it works (the flow)

```
Meta lead-ad submitted
      │
      ▼
POST /webhooks/meta ──► look up tenant by page_id
      │
      ▼
fetch lead field-data from Graph API ──► normalize (libphonenumber) ──► store lead
      │                                        (duplicate active lead? attach, don't re-open)
      ▼
send APPROVED OPENING TEMPLATE  (picked by opener_rules from the form data, else the default;
      │                          its only job: provoke a reply → opens 24h window)
      │        └─ send fails? → delivery_status='failed' + operator alert (never silent)
      │
      ├─ never replies? ──► Track A: at most noreply_max_followups nudge(s) (default 1) — dead-lead cost capped
      ├─ replied then went quiet? ──► Track B: up to stalled_max_followups nudges (default 2), timed from last activity
      ▼
student replies ──► POST /webhooks/whatsapp ──► look up tenant by phone_number_id
      │                 (de-duped by wa_message_id; rapid-fire messages debounced ~4s)
      ▼
runBrain() = Claude call ──► { classification, blocker, extracted, reply, reasoning }
      │
      ├─► reply passes the SAFETY GUARD (no amounts / no guarantees) before sending
      ├─► send reply (free text inside 24h window; RE-ENGAGEMENT TEMPLATE if window closed)
      ├─► update lead status + extracted fields
      ├─► if HOT: counsellor gets the BOOKING (summary + proposed meeting_time) via TEMPLATE;
      │          the AI KEEPS the chat and works to confirm the call time
      └─► if the AI flags needs_human (stuck / frustrated / asked for a person):
                 the LIVE CHAT is handed to a human (human_handoff) + counsellor/operator pinged
```

**Two hard WhatsApp rules the code is built around:**
1. You can only message a **cold** contact with a pre-**approved template**.
2. Once they **reply**, a **24-hour window** opens where you can send free text. After it closes, back to templates.

---

## Architecture

```
src/
  index.ts       Express server: webhook verify + Meta/WhatsApp POST handlers + delivery statuses + /stats
  config.ts      Env loading
  types.ts       Core types (Tenant, Lead, NormalizedLead, BrainResult, QualifyingConfig)
  db.ts          Supabase data access (tenants, leads, messages, system_events, stats)
  meta.ts        Meta Lead Ads adapter: parse webhook, fetch field data, normalize
  whatsapp.ts    WhatsApp Cloud API: send template/text (+retry), parse inbound + statuses, 24h helper
  phone.ts       Robust phone normalization (libphonenumber-js) shared by every intake path
  brain.ts       THE PRODUCT — per-vertical Claude prompt + output safety guard
  engine.ts      Orchestration: new-lead flow, inbound flow (debounce, opt-out, breakers), counsellor alert
  scheduler.ts   Background sweeper: no-reply follow-ups + daily operator digest
  operator.ts    Operator alerting: system_events row + WhatsApp + email stub
  crypto.ts      OPTIONAL AES-256-GCM encryption for stored tokens
scripts/
  add-tenant.ts  CLI to insert a tenant (encrypts tokens when ENCRYPTION_KEY is set)
schema.sql       Supabase tables + append-only migrations (safe to re-run)
```

**The two design decisions that make it scale:**
- **Multi-tenant:** inbound WhatsApp messages carry a `phone_number_id`, Meta leads carry a `page_id` — both map to a tenant in the DB. No per-client code.
- **Normalization layer (`NormalizedLead`):** every lead source is converted to one shape before the engine touches it. Adding website forms later = write one adapter that outputs `NormalizedLead`; nothing downstream changes.

---

## Setup

### 1. Supabase
Create a project, open the SQL editor, paste and run `schema.sql`. It is **append-only / idempotent** — re-running it on an existing database applies only the new migrations. Grab your project URL and the **service role** key.

### 2. Env
Copy `.env.example` to `.env` and fill it in. New since the hardening pass:
- `OPERATOR_WA` — your WhatsApp number (global fallback for system/failure alerts; per-tenant `operator_wa` wins).
- `STATS_TOKEN` — secret for `GET /stats?token=...`. Endpoint is off if unset.
- `ENCRYPTION_KEY` — optional; see **Token encryption** below before setting it.
- `TENANT_DAILY_TEMPLATE_CAP`, `CLAUDE_CALLS_PER_MINUTE` — optional circuit-breaker tuning.

### 3. Install & run
```bash
npm install
npm run dev      # local dev with hot reload
# or
npm run build && npm start
```

### 4. Register your first client
Insert a `tenants` row (see the commented example at the bottom of `schema.sql`), or use the CLI (required once token encryption is on):
```bash
npm run add-tenant -- '{"name": "...", "wa_phone_number_id": "...", "wa_token": "...", "wa_opening_template": "lead_opener", "business_name": "...", ...}'
```
(Load your `.env` into the shell first — the script reads the same env vars as the server.)

Important per-tenant fields:
| Field | What it does | Default |
|---|---|---|
| `default_country_code` | Resolves national-format phones (e.g. `'91'`) | none (recommended: set it) |
| `operator_wa` | Where system/failure alerts go | falls back to `OPERATOR_WA` |
| `noreply_followup_templates` | **Track A**: nudges for leads that NEVER replied | `[]` (no nudges) |
| `noreply_followup_delays_minutes` | Track A delays, from opener/previous contact | `[180]` |
| `noreply_max_followups` | Track A cap — dead-lead cost stops at opener + this | `1` |
| `stalled_followup_templates` | **Track B**: nudges for engaged-then-stalled leads | `[]` (no nudges) |
| `stalled_followup_delays_minutes` | Track B delays, from **last activity** | `[1440, 4320]` |
| `stalled_max_followups` | Track B cap | `2` |
| `opener_rules` | Profile-based opener selection (see below) | `[]` (always default opener) |
| `counsellor_alert_template` | Approved template for hot-lead booking alerts | none (falls back to free text) |
| `reengagement_template` | Approved template to reopen a closed window | none (lead alerts operator instead) |
| `qualifying_config` | Per-vertical brain config (see below) | `{}` = built-in study-abroad |
| `max_messages_per_lead` | RUNAWAY safety net only — never freezes a hot lead | `100` |

An existing tenant with all defaults behaves exactly as before (no follow-ups until templates are configured, free-text counsellor alert, study-abroad brain). Tenants configured with the old flat `followup_templates`/`followup_delays_minutes`/`max_followups` keep working unchanged: those deprecated columns are used as Track A whenever `noreply_followup_templates` is empty.

---

## Templates you must create and get APPROVED in Meta (per tenant)

The system can only reference **approved** template names — approval is Meta bureaucracy the code cannot automate, and it can take days or be rejected. Get these approved **before** enabling the features that use them:

| Template (tenant field) | Purpose | Variables |
|---|---|---|
| `wa_opening_template` | Default opener to a fresh lead | one `{{1}}` body var (first name) |
| each `template` in `opener_rules` | Profile-specific openers (picked from form data) | one `{{1}}` body var (first name) |
| each name in `noreply_followup_templates` | Track A nudges (lead never replied) | one `{{1}}` body var (first name) |
| each name in `stalled_followup_templates` | Track B nudges (engaged then stalled) | one `{{1}}` body var (first name) |
| `reengagement_template` | Reopen a closed 24h window mid-conversation | one `{{1}}` body var (first name) |
| `counsellor_alert_template` | Hot-lead booking alert to the counsellor | `{{1}}` lead name, `{{2}}` country/answer 1, `{{3}}` intake/answer 2, `{{4}}` wa.me link |

**Follow-up cost logic:** every follow-up / re-engagement is a **billable marketing template** (India ≈ ₹0.86 each) because it's sent outside the 24h window. The two tracks exist to point that spend at the right leads: a lead that **never replied** is probably dead, so Track A caps them at **1** nudge (opener + 1 = worst-case dead-lead cost); a lead that **replied and then stalled** showed real intent, so Track B allows **2** nudges, timed from the end of the conversation (the later of their last message / our last message). There's also a per-tenant daily template cap as a backstop.

**Operator alerts limitation:** alerts to `operator_wa` are free text, so they only deliver while *your own* 24h window with that business number is open. **Message each tenant's business number once from your operator phone and reply occasionally to keep the thread alive.** Every alert is also durably written to the `system_events` table (visible via `/stats`) regardless.

---

## Configuring a new vertical (no code change)

The brain's system prompt is composed from a fixed skeleton (role, output schema, **safety rules**) plus the tenant's `qualifying_config` (JSONB). Empty config = the built-in study-abroad default. To onboard e.g. a NEET admissions consultancy, set:

```json
{
  "vertical_description": "a medical-admissions consultancy helping NEET aspirants find MBBS seats",
  "fields_to_extract": [
    "neet_score: their NEET score or expected score",
    "preferred_state: which state/college type they prefer",
    "budget: fee range they can manage",
    "category: reservation category if they volunteer it"
  ],
  "blocker_taxonomy": ["none", "score_pending", "budget_unclear", "undecided_college", "just_researching", "timing", "other"],
  "classification_rules": "A student with a score in hand asking about colleges is HOT — book the counsellor call. ...",
  "allowed_facts": ["We are based in Pune", "Counselling sessions are free"],
  "forbidden_topics": ["fee amounts of specific colleges", "guaranteed seats"],
  "persona_notes": "Formal Hindi-English mix; parents often read these messages."
}
```

`allowed_facts` are the ONLY specifics the bot may assert; `forbidden_topics` are always deflected to the counsellor call. An optional `extracted_schema` string lets a vertical describe the exact JSON shape (types/enums) of `extracted` in the prompt. Missing keys fall back to the study-abroad defaults.

### The default study-abroad brain: the three-question model

The built-in study-abroad config judges every lead by **three questions**, worked out through natural conversation (one thing at a time, never an interrogation):

1. **Have they DECIDED to go abroad?** Not knowing *which country* doesn't count against them.
2. **Are the PARENTS convinced?**
3. **Is the MONEY handled?** Has funds → handled. Money uncertainty → the bot *reactively* (never proactively — pushing loans unprompted feels salesy) floats financing: open to a loan → handled-enough; loan refused → one more probe: needs a **100% scholarship** (weakest lead) vs. **partial scholarship + self-funding** (still serious).

Classification falls out of the answers: **hot** = all three resolved (funds, or loan-open, or partial-scholarship + self-fund) → book the call. **warm** = a fundamental is open (parents not convinced, not yet decided, or financing stance still being explored). **cold** = only-100%-scholarship-no-loan-no-own-money, or not committed to going — still nurtured lightly; *nobody is discarded*.

**A blocked document is not a blocked lead.** "Waiting for 12th results," "about to take IELTS," "no offer letter yet" are the work the consultancy exists to do — they're recorded in `extracted.documents_pending` for follow-up and never lower a hot lead. That pre-IELTS stage is the *normal entry point* of a serious student, not a warning sign.

The brain returns the three answers in `extracted` (`decided_to_go`, `parents_convinced`, `finance_situation`, `loan_openness`, `scholarship_expectation`, plus `target_country`, `intake`, `documents_pending`), and `blocker` holds the single primary reason a lead is *not* hot (`none` when hot): `parents_not_convinced | undecided_to_go | scholarship_100_only | loan_refused_no_self_funding | money_unresolved | other`.

### Entry mode: who messaged first

Every lead carries `initiated_by`, set automatically at creation and fixed thereafter:

- **`'us'`** — we reached out (Meta lead-form → opener template). The AI naturally *leads*: it opens warmly and guides the conversation toward the three questions.
- **`'student'`** — they messaged the business first (plain "hi", a random question, or a **Click-to-WhatsApp ad** tap — those send no leadgen webhook, so their first message lands on the inbound-first path and is tagged automatically). The AI opens **human-first**: it engages with whatever the student actually said, answers light questions (safety rules still apply — no fees, no promises), and lets qualification *emerge* from the conversation instead of firing questions — while keeping a light hand on the wheel so it never degrades into a pure Q&A help-desk.

This is one flag changing one **opening-posture** section of the shared prompt — the three-question judgment, safety rules, and routing are identical in both modes (deliberately: two brains would drift). It's independent of `source` and of `qualifying_config`.

### Hot leads: the AI hands off the BOOKING, not the conversation

A hot classification does **not** freeze the AI. The AI stays in the chat and drives toward one goal: **a confirmed time for the counsellor call** (offering options, converging, recording it in `extracted.meeting_time`). What the counsellor receives is the **booking** — the summary template/message with a `Proposed call:` line — not a live conversation to take over. The old `auto_handoff_on_hot` behavior is removed (the column remains in the DB but is ignored). **Automated calendar booking (real calendar events, live availability, slot offers, no-show loops) is still deferred** — for now "the booking" is the `meeting_time` carried in the counsellor notification.

The counsellor alert is sent **exactly once per lead, ever** (`leads.hot_alerted`), and only once the AI has a **real summary** to hand over: the decided/parents answers must be known plus at least one of country / intake / money stance. A lead flagged hot with a thin summary is not alerted yet — the brain keeps gathering the details and the alert fires on a later turn. The message includes the student's WhatsApp number and wa.me link, with a note to open the chat from the business WhatsApp account.

### Escalation: AI-judged, not message-counted

The *live conversation* is handed to a human (`human_handoff = true`) only when the **AI itself flags `needs_human`** — because it's genuinely stuck/looping, the lead is frustrated or confused, or the lead asked for a person (`needs_human_reason`: `stuck | frustrated | confused | asked_for_human`). The prompt explicitly forbids escalating just because a conversation is long or because a hot lead is taking many messages — a smoothly-progressing hot lead is never escalated. On escalation the counsellor (if their window is open) and the operator get the reason plus the wa.me link.

`max_messages_per_lead` (default now **100**) is only a **runaway safety net** against bugs/spammers: past the cap, a **hot** lead is never frozen (the operator gets a one-time `runaway_check` ping to glance at it and the AI continues); a non-hot lead is frozen via `human_handoff` as a cost/safety stop. Manual handoff (setting the DB flag) still works as before. The global Claude per-minute cap is unchanged.

### Profile-based openers

The opener must be a pre-approved template (cold contact — unchangeable WhatsApp rule), but you can have **several approved openers** and pick per lead. `opener_rules` is an ordered list matched against the lead form's answers; first match wins, otherwise `wa_opening_template`:

```json
[
  { "when_field": "target_country", "equals": "Italy",   "template": "opener_italy" },
  { "when_field": "target_country", "equals": "Ireland", "template": "opener_ireland" }
]
```

Matching is case-insensitive on the form field's value. Every referenced template must be **created and approved in Meta** and take the same single `{{1}}` first-name variable. Follow-up and re-engagement templates are not profile-selected (deliberately simple).

**AI safety (P0-3):** the prompt forbids stating fees/amounts/deadlines/percentages it wasn't given and forbids guaranteeing any outcome. A second-layer output guard scans every reply for currency/amount/percentage/guarantee patterns; flagged replies are replaced with a safe "the counsellor will confirm on a call" deflection and the original is sent to the operator (`reply_flagged`) for review. This **reduces but cannot eliminate** wrong statements — the AI-judged `needs_human` escalation (below) plus the `reply_flagged` review loop are the operational safeguards.

---

## Meta / WhatsApp setup (do this first — it's the real blocker)

This is bureaucracy, not code, and it gates everything.

1. **Meta Business account** (business.facebook.com) — you likely have one from running ads.
2. **WhatsApp Business Account + number** in the Meta app. ⚠️ The number must NOT already be on the normal WhatsApp/WhatsApp Business app. Use a fresh SIM, or fully delete the number from WhatsApp first.
3. **Meta App** (developers.facebook.com) → add the **WhatsApp** product. Grab: `phone_number_id`, an access token, and the **App Secret** (for `META_APP_SECRET`).
4. **Approve your templates** — the opener plus the follow-up / re-engagement / counsellor-alert templates listed above. Opener example:
   > Hi {{1}} 👋 Thanks for your interest in studying abroad with us! Quick question so we can help properly — which intake are you aiming for?
5. **WhatsApp product** → Configuration → set the **Callback URL** to `https://YOUR_APP/webhooks/whatsapp` and the **Verify Token** to your `META_VERIFY_TOKEN`. Subscribe to the `messages` field (this also delivers the **delivery statuses** the system uses to detect failed sends).
6. **For lead ads:** add the **Webhooks** product → subscribe the Page to the `leadgen` field, callback URL `https://YOUR_APP/webhooks/meta`, same verify token.
7. Meta gives you a **test number** and lets you message up to 5 pre-verified recipients immediately — enough to build and test this week. Full business verification (for messaging strangers at volume) runs in the background; **don't wait for it to start testing.**

---

## Deploy (Railway)

The server must be **always on** — it receives webhooks AND runs the follow-up scheduler in-process. ⚠️ **Do NOT deploy on scale-to-zero / serverless hosting** (Vercel functions, Cloud Run min-instances=0, etc.): the sweeper won't run and no-reply follow-ups will silently never send. Railway's always-on service is fine.

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub.
3. Set the env vars from your `.env` in the Railway dashboard.
4. Railway gives you a public URL — use it as the webhook callback URL in the Meta dashboard.
5. Set the start command to `npm run build && npm start` (or add a `postinstall` build step).

Run exactly **one instance** — the debounce and rate counters are in-memory (see residual risks).

---

## Operator visibility

- **`GET /stats?token=STATS_TOKEN`** — per-tenant JSON: leads created / replied / hot / booked / failed sends / opt-outs today, plus the 50 most recent `system_events`. This is deliberately **not** a dashboard; a web UI is a separate frontend project.
- **Daily digest** — once a day (first sweep after 06:00 UTC) each tenant's operator gets a WhatsApp summary. Free text, so it only delivers if your window with that number is open; the numbers are always in `/stats`.
- **`system_events` table** — every failure/notice (`opener_failed`, `delivery_failed`, `followup_failed`, `reply_flagged`, `window_closed_reengaged`, `lead_opted_out`, `circuit_breaker`, …) is durably recorded here even when the WhatsApp alert can't deliver.

---

## Token encryption (OPTIONAL — read this before enabling)

Set `ENCRYPTION_KEY` (64 hex chars = 32 bytes) to encrypt `wa_token` / `meta_page_token` at rest (AES-256-GCM). Existing plaintext rows keep working (decrypt passes them through); new tenants must be inserted via `npm run add-tenant` so tokens are encrypted on the way in.

**⚠️ WARNING: if `ENCRYPTION_KEY` is ever lost, all stored tokens become permanently unreadable and every tenant must be re-provisioned.** Back the key up securely (password manager + offline copy). Because of this operational risk, encryption is optional and can be deferred — plaintext behind the server-only Supabase service key is acceptable for early v1.

---

## Testing without spending on ads

You don't need a live ad campaign to test the whole loop:
- **Test the WhatsApp half:** from your own phone, message the business test number → the `/webhooks/whatsapp` handler fires → the brain replies. This proves intake→brain→reply end to end.
- **Test the Meta half:** use Meta's **Lead Ads Testing Tool** to generate a fake lead for your form → `/webhooks/meta` fires → opener template sends.
- **Test follow-ups:** set a lead's `next_followup_at` to `now()` in Supabase and watch the sweeper (runs every 2 minutes) send the nudge.
- **Watch it work:** every message is stored in `messages`, every classification in `leads`, every failure in `system_events`.

---

## What's built vs. deliberately deferred

**Built (the spine + hardening pass):**
- Meta lead intake → normalize (libphonenumber, per-tenant country code) → store, with attach-not-duplicate for repeat submissions
- Opening template send with retry/backoff, failure alerts, and delivery-status tracking from Meta's status webhooks
- No-reply follow-up sequence (per-tenant templates/delays/cap) via the in-process scheduler
- Inbound reply → de-dup → debounce → Claude qualification → safety-guarded reply → 24h-window-aware send with re-engagement fallback
- Hot-lead counsellor alert via approved template + operator redundancy
- Opt-out handling, AI-judged `needs_human` escalation + runaway safety net, per-tenant & global cost caps, human-takeover switch
- Turn-level reliability: brain output validated/coerced (malformed JSON → safe fallback, never "undefined" to a student), reply sent before state bookkeeping, any mid-turn failure answers the student + alerts the operator (`turn_error`), and a per-lead lock ensures one turn at a time even when fragments outpace the AI's latency
- Hot-lead booking handoff (AI keeps the chat, counsellor gets summary + proposed `meeting_time`)
- Two-track follow-ups (never-replied vs engaged-then-stalled) and profile-based opener selection
- Operator alerting (`system_events` + WhatsApp + email stub), `/stats`, daily digest
- Per-vertical brain config (`qualifying_config`) — new verticals are a tenant row, not a code change
- Optional at-rest token encryption + `add-tenant` CLI

**Deferred — explicitly NOT delivered in this pass:**
- **Real calendar booking** — Google Calendar event creation, live counsellor availability, slot offers, no-show reminder loops. Today "the booking" is the AI-negotiated `meeting_time` carried in the counsellor alert (with the wa.me link); actual automated scheduling is a separate feature build.
- **Website-form lead intake** — the `NormalizedLead` seam is ready for it, but the website adapter itself is a separate small build (depends on each client's site/form tooling).
- **Warm/cold nurture branches**, **full dashboard/analytics UI** — later, if clients ask.

---

## Residual risks & honest limits (what code cannot fully solve)

1. **The AI can still occasionally say something wrong.** Prompt hardening + the output guard + AI-judged escalation sharply reduce it, but no technique guarantees a language model never makes an incorrect or awkward statement. The `reply_flagged` review loop and the `needs_human` handoff are the operational safeguards; a manual `human_handoff` flag is always available per lead.
2. **Single-instance concurrency.** The rapid-fire debounce and the rate counters are in-memory: lost on restart, not shared across instances. Fine for one Railway instance; horizontal scaling needs a real queue (Redis/BullMQ) and distributed locks — a deliberate re-architecture later, not now.
3. **Template approval is a Meta operational dependency.** Every template the system sends must be approved in Meta Business Manager first; approvals can be delayed or rejected. Not automatable here.
4. **WhatsApp quality rating / deliverability.** If recipients block or report the number, Meta throttles sending. Opt-out handling, send caps, and clean templates help, but the rating is ultimately controlled by Meta and real user behavior.
5. **Email alerts are a stub.** `sendEmail()` no-ops with a console log until you wire an SMTP/API provider. Until then, redundancy = `system_events` + WhatsApp.
6. **Dashboard is out of scope.** `/stats` JSON + daily digest only.
7. **Encryption key management (if enabled).** Losing `ENCRYPTION_KEY` permanently locks all tenant tokens — requires disciplined key backup; no code can remove that risk.

---

## First milestone

Don't build the deferred list yet. Get **one** thing green: message the test number from your phone and watch the brain reply and classify you correctly in the `leads` table. That single loop working proves everything hard. Everything after it is assembly.

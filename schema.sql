-- ============================================================
-- Lead Response System — Supabase schema
-- Run this in the Supabase SQL editor once.
-- Multi-tenant: one row in `tenants` per consultancy you serve.
-- ============================================================

-- Each consultancy using the system.
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  -- WhatsApp Cloud API (per client — each has their own number)
  wa_phone_number_id  text unique not null,          -- identifies inbound WA messages -> this tenant
  wa_token            text not null,                 -- token used to SEND from this number
  wa_opening_template text not null,                 -- name of the APPROVED opening template
  wa_template_lang    text not null default 'en',    -- template language code

  -- Meta Lead Ads (per client)
  meta_page_id    text unique,                       -- identifies incoming leads -> this tenant
  meta_page_token text,                              -- page token to FETCH lead field data from Graph API

  -- Domain / persona config
  vertical      text not null default 'study_abroad',
  business_name text not null,                       -- name used when messaging leads
  agent_name    text not null default 'the team',    -- persona the bot signs as

  -- Where to send hot-lead alerts (a WhatsApp number, digits only)
  counsellor_wa text,

  -- Extensible per-tenant settings (qualifying questions, overrides, etc.)
  config jsonb not null default '{}',

  created_at timestamptz not null default now()
);

-- Every lead, from any source.
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),

  source      text not null,                         -- 'meta' | 'website' | 'manual'
  external_id text,                                  -- meta leadgen_id, etc.
  name        text,
  phone       text not null,                         -- E.164 digits only, no '+'
  raw         jsonb not null default '{}',           -- original source payload

  status         text not null default 'new',        -- new|contacted|engaged|hot|warm|cold|booked|closed
  classification text,                                -- hot | warm | cold
  intent_level   text,                                -- high | medium | low
  blocker        text,                                -- primary reason NOT hot: none|parents_not_convinced|undecided_to_go|scholarship_100_only|loan_refused_no_self_funding|money_unresolved|other
  extracted      jsonb not null default '{}',         -- structured qualified fields

  last_inbound_at timestamptz,                        -- drives the WhatsApp 24h window
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists leads_tenant_idx on leads (tenant_id);
create index if not exists leads_phone_idx  on leads (phone);

-- Full conversation transcript (in + out).
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id),
  direction text not null,                            -- 'in' | 'out'
  channel   text not null default 'whatsapp',
  body      text,
  wa_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists messages_lead_idx on messages (lead_id);

-- Booked / proposed counsellor calls (used as the system grows).
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  lead_id   uuid not null references leads(id),
  tenant_id uuid not null references tenants(id),
  scheduled_at timestamptz,
  status text not null default 'proposed',            -- proposed|confirmed|done|no_show|cancelled
  notes  text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- MIGRATION 001 — hardening pass (follow-ups, delivery tracking,
-- operator alerts, per-vertical brain, opt-out, circuit breakers).
-- Append-only: safe to run on an existing database. Every new
-- column has a default so existing tenants keep working unchanged.
-- ============================================================

-- --- tenants ---
alter table tenants add column if not exists default_country_code text;                                   -- e.g. '91'; resolves national-format phone numbers
alter table tenants add column if not exists operator_wa text;                                            -- operator (you) WhatsApp number for system/failure alerts
alter table tenants add column if not exists operator_email text;                                         -- optional fallback alert channel (email sending is a stub until a provider is wired)
alter table tenants add column if not exists followup_templates jsonb not null default '[]';              -- ordered APPROVED template names for no-reply nudges
alter table tenants add column if not exists followup_delays_minutes jsonb not null default '[180, 1440]';-- minutes after previous contact for each nudge (index-aligned)
alter table tenants add column if not exists max_followups int not null default 2;                        -- hard cap on nudges to a non-replier
alter table tenants add column if not exists counsellor_alert_template text;                              -- APPROVED template for hot-lead alerts (works with no open 24h window)
alter table tenants add column if not exists reengagement_template text;                                  -- APPROVED template to reopen a closed 24h window mid-conversation
alter table tenants add column if not exists qualifying_config jsonb not null default '{}';               -- per-vertical brain config; empty = built-in study-abroad default
alter table tenants add column if not exists max_messages_per_lead int not null default 30;               -- per-lead circuit breaker
alter table tenants add column if not exists auto_handoff_on_hot boolean not null default false;          -- stop auto-replying once hot; human takes over

-- --- leads ---
alter table leads add column if not exists last_contact_at timestamptz;                                   -- when WE last sent this lead anything (drives follow-up timing)
alter table leads add column if not exists followups_sent int not null default 0;
alter table leads add column if not exists next_followup_at timestamptz;                                  -- next nudge due; NULL = none pending (engaged/closed/exhausted)
alter table leads add column if not exists delivery_status text;                                          -- pending | sent | delivered | read | failed
alter table leads add column if not exists opted_out boolean not null default false;
alter table leads add column if not exists human_handoff boolean not null default false;
alter table leads add column if not exists closed_reason text;                                            -- booked | opted_out | exhausted | not_interested | error | other
alter table leads add column if not exists processing_until timestamptz;                                  -- lightweight sweeper claim to avoid double-processing

create index if not exists leads_followup_due_idx on leads (next_followup_at) where next_followup_at is not null;

-- --- messages: inbound de-duplication (WhatsApp can redeliver) ---
create unique index if not exists messages_wa_message_id_uidx
  on messages (wa_message_id) where wa_message_id is not null;

-- --- operator-visible failures/notices ---
create table if not exists system_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  lead_id uuid,
  level text not null default 'info',                 -- info | warn | error
  kind text not null,                                 -- e.g. opener_failed | delivery_failed | reply_flagged | window_closed_reengaged
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists system_events_created_idx on system_events (created_at desc);

-- ============================================================
-- MIGRATION 002 — conversation entry mode.
-- Append-only: safe to run on an existing database.
-- ============================================================

-- Who sent the FIRST message of this conversation:
--   'us'      = we reached out (lead-form / outbound) — the AI leads.
--   'student' = they messaged first (inbound / Click-to-WhatsApp) — the AI
--               responds human-first and lets qualification emerge.
-- Default 'us' so existing rows keep their current behavior.
alter table leads add column if not exists initiated_by text not null default 'us';

-- ============================================================
-- MIGRATION 003 — smarter handoff, escalation, follow-ups, openers.
-- Append-only: safe to run on an existing database.
-- ============================================================

-- CHANGE 1/2 — hot leads no longer freeze the AI; escalation is AI-judged.
--   * tenants.auto_handoff_on_hot is DEPRECATED (column left in place, ignored
--     by code). The AI now keeps hot conversations and hands the counsellor a
--     BOOKING (summary + proposed meeting time), not a live chat.
--   * max_messages_per_lead is re-purposed: no longer the normal escalation
--     path, only a high runaway safety net against bugs/spammers.
alter table tenants alter column max_messages_per_lead set default 100;
update tenants set max_messages_per_lead = 100 where max_messages_per_lead = 30; -- lift old default rows to the new runaway intent

-- CHANGE 3 — two follow-up tracks (replaces the flat followup_* fields, which
-- are DEPRECATED but left in place; code falls back to them if the new
-- noreply_* fields are unconfigured, so existing tenants keep working).
-- Track A: lead NEVER replied — cheap, default 1 nudge, timed from opener.
alter table tenants add column if not exists noreply_followup_templates jsonb not null default '[]';
alter table tenants add column if not exists noreply_followup_delays_minutes jsonb not null default '[180]';
alter table tenants add column if not exists noreply_max_followups int not null default 1;
-- Track B: lead ENGAGED then stalled — worth more, default 2 nudges, timed
-- from the last activity (later of last inbound / last outbound).
alter table tenants add column if not exists stalled_followup_templates jsonb not null default '[]';
alter table tenants add column if not exists stalled_followup_delays_minutes jsonb not null default '[1440, 4320]';
alter table tenants add column if not exists stalled_max_followups int not null default 2;

alter table leads add column if not exists stalled_followups_sent int not null default 0; -- Track B counter, independent of followups_sent (Track A)

-- CHANGE 4 — profile-based opener selection. Ordered rules matched against the
-- lead form's field data; first match wins, else wa_opening_template. Example:
--   '[{"when_field":"target_country","equals":"Italy","template":"opener_italy"},
--     {"when_field":"target_country","equals":"Ireland","template":"opener_ireland"}]'
-- Every template referenced here must be APPROVED in Meta like any other.
alter table tenants add column if not exists opener_rules jsonb not null default '[]';

-- ------------------------------------------------------------
-- Example: register your first client. Fill in the real values.
-- ------------------------------------------------------------
-- insert into tenants (
--   name, wa_phone_number_id, wa_token, wa_opening_template, wa_template_lang,
--   meta_page_id, meta_page_token, business_name, agent_name, counsellor_wa,
--   default_country_code, operator_wa,
--   noreply_followup_templates, noreply_followup_delays_minutes,
--   stalled_followup_templates, stalled_followup_delays_minutes,
--   counsellor_alert_template, reengagement_template, opener_rules
-- ) values (
--   'Vivendo Overseas',
--   '1234567890',                 -- WhatsApp phone_number_id
--   'EAA...page-or-system-token', -- token to send WhatsApp messages
--   'lead_opener',                -- default APPROVED opener (one {{1}} body var for first name)
--   'en',
--   '9876543210',                 -- Facebook Page ID running the lead ads
--   'EAA...page-access-token',    -- page token to fetch lead data
--   'Vivendo Overseas',
--   'Rahul',
--   '919999999999',               -- counsellor WhatsApp for hot-lead alerts
--   '91',                         -- default country code for normalizing national-format phones
--   '918888888888',               -- operator (you) WhatsApp for system/failure alerts
--   '["lead_nudge_1"]',           -- Track A: nudge for never-repliers (one {{1}} first-name var); default cap 1
--   '[180]',                      -- Track A: 3h after the opener
--   '["lead_revive_1","lead_revive_2"]', -- Track B: nudges for engaged-then-stalled leads (one {{1}} var each)
--   '[1440, 4320]',               -- Track B: 1 day, then 3 days, from last activity
--   'hot_lead_alert',             -- APPROVED counsellor alert template ({{1}} name, {{2}} country, {{3}} intake, {{4}} wa.me link)
--   'lead_reengage',              -- APPROVED re-engagement template (one {{1}} first-name var)
--   '[{"when_field":"target_country","equals":"Italy","template":"opener_italy"}]' -- optional per-profile openers (each APPROVED)
-- );

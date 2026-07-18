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

-- ------------------------------------------------------------
-- Example: register your first client. Fill in the real values.
-- ------------------------------------------------------------
-- insert into tenants (
--   name, wa_phone_number_id, wa_token, wa_opening_template, wa_template_lang,
--   meta_page_id, meta_page_token, business_name, agent_name, counsellor_wa,
--   default_country_code, operator_wa,
--   followup_templates, followup_delays_minutes,
--   counsellor_alert_template, reengagement_template
-- ) values (
--   'Vivendo Overseas',
--   '1234567890',                 -- WhatsApp phone_number_id
--   'EAA...page-or-system-token', -- token to send WhatsApp messages
--   'lead_opener',                -- your approved template name (needs one {{1}} body var for first name)
--   'en',
--   '9876543210',                 -- Facebook Page ID running the lead ads
--   'EAA...page-access-token',    -- page token to fetch lead data
--   'Vivendo Overseas',
--   'Rahul',
--   '919999999999',               -- counsellor WhatsApp for hot-lead alerts
--   '91',                         -- default country code for normalizing national-format phones
--   '918888888888',               -- operator (you) WhatsApp for system/failure alerts
--   '["lead_followup_1","lead_followup_2"]',  -- APPROVED follow-up templates (each needs one {{1}} first-name var)
--   '[180, 1440]',                -- send nudge 1 after 3h, nudge 2 after 24h more
--   'hot_lead_alert',             -- APPROVED counsellor alert template ({{1}} name, {{2}} country, {{3}} intake, {{4}} wa.me link)
--   'lead_reengage'               -- APPROVED re-engagement template (one {{1}} first-name var)
-- );

export type LeadSource = 'meta' | 'website' | 'manual';

export interface Tenant {
  id: string;
  name: string;
  wa_phone_number_id: string;
  wa_token: string;
  wa_opening_template: string;
  wa_template_lang: string;
  meta_page_id: string | null;
  meta_page_token: string | null;
  vertical: string;
  business_name: string;
  agent_name: string;
  counsellor_wa: string | null;
  config: Record<string, unknown>;

  // Hardening pass (migration 001) — all defaulted so existing tenants keep working.
  default_country_code: string | null;      // e.g. '91'; resolves national-format phones
  operator_wa: string | null;               // operator WhatsApp for system/failure alerts
  operator_email: string | null;            // optional email fallback (stubbed until provider wired)
  counsellor_alert_template: string | null; // APPROVED template for hot-lead alerts
  reengagement_template: string | null;     // APPROVED template to reopen a closed 24h window
  qualifying_config: Partial<QualifyingConfig>; // per-vertical brain config; {} = study-abroad default
  max_messages_per_lead: number;            // RUNAWAY safety net only (default 100) — never the normal escalation path

  // Migration 003 — two follow-up tracks. The old flat followup_* columns are
  // deprecated; db.ts falls back to them when Track A is unconfigured.
  noreply_followup_templates: string[];     // Track A: nudges for leads that NEVER replied (timed from opener)
  noreply_followup_delays_minutes: number[];
  noreply_max_followups: number;            // default 1 — caps dead-lead cost at opener + 1
  stalled_followup_templates: string[];     // Track B: nudges for engaged-then-stalled leads (timed from last activity)
  stalled_followup_delays_minutes: number[];
  stalled_max_followups: number;            // default 2

  // Migration 003 — profile-based opener selection; first matching rule wins,
  // else wa_opening_template. Every referenced template must be Meta-approved.
  opener_rules: OpenerRule[];
}

export interface OpenerRule {
  when_field: string; // lead-form field name, e.g. "target_country"
  equals: string;     // value to match (case-insensitive)
  template: string;   // APPROVED opener template to use
}

export interface Lead {
  id: string;
  tenant_id: string;
  source: LeadSource;
  external_id: string | null;
  name: string | null;
  phone: string;
  raw: Record<string, unknown>;
  status: string;
  // Who sent the first message: 'us' (we reached out) or 'student' (they
  // messaged first, incl. Click-to-WhatsApp). Fixed at creation; drives only
  // the brain's opening posture, never the judgment itself.
  initiated_by: 'us' | 'student';
  classification: string | null;
  intent_level: string | null;
  blocker: string | null;
  extracted: Record<string, unknown>;
  last_inbound_at: string | null;

  // Hardening pass (migration 001)
  last_contact_at: string | null;   // when WE last sent this lead anything
  followups_sent: number;           // Track A (never-replied) nudges sent
  stalled_followups_sent: number;   // Track B (engaged-then-stalled) nudges sent
  next_followup_at: string | null;  // next nudge/stall-check for EITHER track; NULL = none pending
  delivery_status: string | null;   // pending | sent | delivered | read | failed
  opted_out: boolean;
  human_handoff: boolean;
  hot_alerted: boolean;             // the once-ever counsellor booking alert has been sent
  closed_reason: string | null;     // booked | opted_out | exhausted | not_interested | error | other
  processing_until: string | null;  // lightweight sweeper claim
}

// The single shape every lead source is converted into before it enters the engine.
// Add a new source? Write an adapter that produces this — nothing downstream changes.
export interface NormalizedLead {
  source: LeadSource;
  external_id: string | null;
  name: string | null;
  phone: string; // digits only, E.164 without '+'
  raw: Record<string, unknown>;
}

export interface StoredMessage {
  direction: 'in' | 'out';
  body: string | null;
}

// Per-vertical brain configuration (P1-14). Stored in tenants.qualifying_config.
// When the tenant's config is empty, brain.ts falls back to the built-in
// study-abroad default that reproduces the original behavior exactly.
export interface QualifyingConfig {
  vertical_description: string;   // "an education consultancy that helps Indian students study abroad"
  fields_to_extract: string[];    // e.g. "decided_to_go: have they decided to go abroad?"
  blocker_taxonomy: string[];     // primary reason a lead is NOT hot; "none" when hot
  classification_rules: string;   // domain judgment rules for hot/warm/cold
  allowed_facts: string[];        // facts the assistant MAY state
  forbidden_topics: string[];     // topics the assistant must deflect to the counsellor
  persona_notes?: string;         // optional tone/persona guidance
  extracted_schema?: string;      // optional exact JSON shape of "extracted" shown in the output
                                  // schema (types/enums); falls back to fields_to_extract names
}

// What the brain returns for every inbound message. This is the product's core.
// The extracted shape below is the study-abroad three-question model
// (decided? / parents? / money?); other verticals use the index signature.
export interface BrainResult {
  classification: 'hot' | 'warm' | 'cold';
  intent_level: 'high' | 'medium' | 'low';
  // The single primary reason the lead is NOT hot; "none" when hot.
  // Study-abroad taxonomy: none | parents_not_convinced | undecided_to_go |
  // scholarship_100_only | loan_refused_no_self_funding | money_unresolved | other
  blocker: string;
  extracted: {
    decided_to_go?: 'yes' | 'no' | 'unclear';
    target_country?: string | null;          // undecided is fine — null if not chosen
    parents_convinced?: 'yes' | 'no' | 'unclear';
    finance_situation?: 'has_funds' | 'needs_financing' | 'unclear';
    loan_openness?: 'open' | 'refused' | 'not_discussed';               // when needs_financing
    scholarship_expectation?: 'full_required' | 'partial_ok' | 'not_discussed'; // when loan refused
    intake?: string | null;
    documents_pending?: string[];            // informational ONLY; never lowers a hot lead
    meeting_time?: string | null;            // proposed/agreed counsellor-call time (the "booking")
    [k: string]: unknown;
  };
  recommended_action: 'book_call' | 'nurture' | 'chase_document' | 'close';
  reply: string;
  reasoning: string;
  opt_out?: boolean;               // lead asked to stop being contacted
  conversation_complete?: boolean; // nothing left to do (e.g. call booked)
  // AI-judged escalation: true ONLY when the AI is stuck, the lead is
  // frustrated/confused, or the lead asked for a human. This — not any message
  // count — is what hands the live conversation to a person.
  needs_human?: boolean;
  needs_human_reason?: 'stuck' | 'frustrated' | 'confused' | 'asked_for_human' | '';
}

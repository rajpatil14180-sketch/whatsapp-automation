import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { Tenant, Lead, NormalizedLead, StoredMessage, BrainResult } from './types';
import { decrypt } from './crypto';

const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: false },
});

// Tokens may be stored encrypted (P2-12); decrypt is a no-op passthrough for plaintext.
function hydrateTenant(row: any): Tenant {
  const t = row as Tenant;
  t.wa_token = decrypt(t.wa_token);
  if (t.meta_page_token) t.meta_page_token = decrypt(t.meta_page_token);
  // Columns can be null/absent on rows created before the defaults existed.
  t.qualifying_config = t.qualifying_config ?? {};
  t.max_messages_per_lead = t.max_messages_per_lead ?? 100; // runaway safety net

  // Track A (never replied). Legacy fallback: tenants configured before
  // migration 003 keep their old flat followup_* behavior untouched.
  const legacyTemplates = (row.followup_templates as string[] | null) ?? [];
  if (!(row.noreply_followup_templates?.length) && legacyTemplates.length) {
    t.noreply_followup_templates = legacyTemplates;
    t.noreply_followup_delays_minutes = (row.followup_delays_minutes as number[] | null) ?? [180, 1440];
    t.noreply_max_followups = (row.max_followups as number | null) ?? 2;
  } else {
    t.noreply_followup_templates = (row.noreply_followup_templates as string[] | null) ?? [];
    t.noreply_followup_delays_minutes = (row.noreply_followup_delays_minutes as number[] | null) ?? [180];
    t.noreply_max_followups = row.noreply_max_followups ?? 1;
  }

  // Track B (engaged then stalled).
  t.stalled_followup_templates = (row.stalled_followup_templates as string[] | null) ?? [];
  t.stalled_followup_delays_minutes = (row.stalled_followup_delays_minutes as number[] | null) ?? [1440, 4320];
  t.stalled_max_followups = row.stalled_max_followups ?? 2;

  t.opener_rules = (row.opener_rules as Tenant['opener_rules'] | null) ?? [];
  return t;
}

// --- Tenant lookup (this is how multi-tenancy is resolved) ---

export async function getTenantByPhoneNumberId(id: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants').select('*').eq('wa_phone_number_id', id).maybeSingle();
  if (error) { console.error('[db] getTenantByPhoneNumberId', error.message); return null; }
  return data ? hydrateTenant(data) : null;
}

export async function getTenantByPageId(pageId: string): Promise<Tenant | null> {
  const { data, error } = await supabase
    .from('tenants').select('*').eq('meta_page_id', pageId).maybeSingle();
  if (error) { console.error('[db] getTenantByPageId', error.message); return null; }
  return data ? hydrateTenant(data) : null;
}

export async function listTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase.from('tenants').select('*');
  if (error) { console.error('[db] listTenants', error.message); return []; }
  return (data ?? []).map(hydrateTenant);
}

// --- Leads ---

export async function findLeadByPhone(tenantId: string, phone: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from('leads').select('*')
    .eq('tenant_id', tenantId).eq('phone', phone)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error('[db] findLeadByPhone', error.message); return null; }
  return data as Lead | null;
}

export async function getLeadById(id: string): Promise<Lead | null> {
  const { data, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
  if (error) { console.error('[db] getLeadById', error.message); return null; }
  return data as Lead | null;
}

// `initiatedBy` records who sent the first message ('us' = we reached out,
// 'student' = they messaged first). Fixed at creation — attachToLead never touches it.
export async function createLead(
  tenantId: string,
  n: NormalizedLead,
  initiatedBy: 'us' | 'student' = 'us'
): Promise<Lead | null> {
  const { data, error } = await supabase.from('leads').insert({
    tenant_id: tenantId, source: n.source, external_id: n.external_id,
    name: n.name, phone: n.phone, raw: n.raw, status: 'new', initiated_by: initiatedBy,
  }).select('*').single();
  if (error) { console.error('[db] createLead', error.message); return null; }
  return data as Lead;
}

// P1-7: a second form-fill (or form + DM) for an active lead ATTACHES to it
// instead of creating a duplicate — merge the raw payload, fill a missing name.
export async function attachToLead(lead: Lead, n: NormalizedLead): Promise<void> {
  const mergedRaw = { ...(lead.raw ?? {}), [`resubmission_${Date.now()}`]: n.raw };
  const { error } = await supabase.from('leads').update({
    raw: mergedRaw,
    name: lead.name ?? n.name,
    external_id: lead.external_id ?? n.external_id,
    updated_at: new Date().toISOString(),
  }).eq('id', lead.id);
  if (error) console.error('[db] attachToLead', error.message);
}

// Opener sent successfully: schedule the first no-reply nudge (P0-2).
export async function markContacted(leadId: string, nextFollowupAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({
      status: 'contacted',
      delivery_status: 'sent',
      last_contact_at: now,
      next_followup_at: nextFollowupAt,
      updated_at: now,
    })
    .eq('id', leadId);
  if (error) console.error('[db] markContacted', error.message);
}

export async function setDeliveryStatus(leadId: string, status: string): Promise<void> {
  const { error } = await supabase.from('leads')
    .update({ delivery_status: status, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[db] setDeliveryStatus', error.message);
}

// Opens / refreshes the 24h WhatsApp window and marks the lead as engaged.
// A reply cancels Track A (never-replied) nudges, resets the Track B counter
// (a NEW stall episode gets the full stalled sequence), and restarts the stall
// clock: `stallCheckAt` is when the first stalled nudge would fire if the
// conversation goes quiet from this moment (null = Track B unconfigured).
export async function markInbound(leadId: string, stallCheckAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({
      last_inbound_at: now, status: 'engaged',
      stalled_followups_sent: 0, next_followup_at: stallCheckAt,
      updated_at: now,
    })
    .eq('id', leadId);
  if (error) console.error('[db] markInbound', error.message);
}

// We sent the lead something (free text or template). Our own message is
// activity too, so it pushes the stall clock out when `stallCheckAt` is given.
export async function markOutboundContact(leadId: string, stallCheckAt?: string | null): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { last_contact_at: now, updated_at: now };
  if (stallCheckAt !== undefined) update.next_followup_at = stallCheckAt;
  const { error } = await supabase.from('leads').update(update).eq('id', leadId);
  if (error) console.error('[db] markOutboundContact', error.message);
}

export async function markOptedOut(leadId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({
      opted_out: true, status: 'closed', closed_reason: 'opted_out',
      next_followup_at: null, updated_at: now,
    })
    .eq('id', leadId);
  if (error) console.error('[db] markOptedOut', error.message);
}

export async function closeLead(leadId: string, status: 'booked' | 'closed', reason: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({ status, closed_reason: reason, next_followup_at: null, updated_at: now })
    .eq('id', leadId);
  if (error) console.error('[db] closeLead', error.message);
}

// The counsellor booking alert is once-per-lead, ever (Fix 5). Set BEFORE the
// send so no later turn can fire a second alert for the same lead.
export async function markHotAlerted(leadId: string): Promise<void> {
  const { error } = await supabase.from('leads')
    .update({ hot_alerted: true, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[db] markHotAlerted', error.message);
}

export async function setHumanHandoff(leadId: string, value: boolean): Promise<void> {
  const { error } = await supabase.from('leads')
    .update({ human_handoff: value, next_followup_at: value ? null : undefined, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[db] setHumanHandoff', error.message);
}

export async function applyBrainResult(lead: Lead, r: BrainResult): Promise<void> {
  const mergedExtracted = { ...(lead.extracted ?? {}), ...r.extracted };
  const status = r.classification; // hot | warm | cold
  const { error } = await supabase.from('leads').update({
    classification: r.classification,
    intent_level: r.intent_level,
    blocker: r.blocker,
    extracted: mergedExtracted,
    status,
    updated_at: new Date().toISOString(),
  }).eq('id', lead.id);
  if (error) console.error('[db] applyBrainResult', error.message);
}

// --- Follow-up sweeper support (P0-2 / two tracks) ---

export type FollowupTrack = 'noreply' | 'stalled';

export interface DueLead extends Lead {
  tenant: Tenant;
  track: FollowupTrack;
}

// Due leads from BOTH tracks. `next_followup_at` is the single "next nudge or
// stall-check" pointer for either track; which track applies falls out of the
// status: 'contacted' = never replied (Track A), anything else still-open and
// once-replied = engaged-then-stalled (Track B).
export async function getDueFollowupLeads(): Promise<DueLead[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('leads')
    .select('*, tenant:tenants(*)')
    .in('status', ['contacted', 'engaged', 'hot', 'warm', 'cold'])
    .eq('opted_out', false)
    .eq('human_handoff', false)
    .not('next_followup_at', 'is', null)
    .lte('next_followup_at', now)
    .limit(100);
  if (error) { console.error('[db] getDueFollowupLeads', error.message); return []; }
  return (data ?? [])
    .filter((row: any) => row.tenant)
    .map((row: any) => {
      const { tenant, ...lead } = row;
      const track: FollowupTrack = lead.status === 'contacted' && !lead.last_inbound_at ? 'noreply' : 'stalled';
      return { ...(lead as Lead), tenant: hydrateTenant(tenant), track };
    });
}

// Lightweight claim so a slow sweep never double-sends (P0-2).
// Returns true only if THIS caller won the claim.
export async function claimLead(leadId: string, minutes = 2): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('leads')
    .update({ processing_until: until })
    .eq('id', leadId)
    .or(`processing_until.is.null,processing_until.lt.${now.toISOString()}`)
    .select('id');
  if (error) { console.error('[db] claimLead', error.message); return false; }
  return (data ?? []).length > 0;
}

export async function releaseLead(leadId: string): Promise<void> {
  const { error } = await supabase.from('leads')
    .update({ processing_until: null }).eq('id', leadId);
  if (error) console.error('[db] releaseLead', error.message);
}

// Track A nudge recorded (never-replied lead).
export async function recordFollowupSent(leadId: string, followupsSent: number, nextFollowupAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({
      followups_sent: followupsSent,
      last_contact_at: now,
      next_followup_at: nextFollowupAt,
      delivery_status: 'sent',
      updated_at: now,
    })
    .eq('id', leadId);
  if (error) console.error('[db] recordFollowupSent', error.message);
}

// Track B nudge recorded (engaged-then-stalled lead) — independent counter.
export async function recordStalledFollowupSent(leadId: string, stalledSent: number, nextFollowupAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from('leads')
    .update({
      stalled_followups_sent: stalledSent,
      last_contact_at: now,
      next_followup_at: nextFollowupAt,
      delivery_status: 'sent',
      updated_at: now,
    })
    .eq('id', leadId);
  if (error) console.error('[db] recordStalledFollowupSent', error.message);
}

export async function setNextFollowupAt(leadId: string, nextFollowupAt: string | null): Promise<void> {
  const { error } = await supabase.from('leads')
    .update({ next_followup_at: nextFollowupAt, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) console.error('[db] setNextFollowupAt', error.message);
}

// --- Messages (conversation transcript) ---

export async function appendMessage(leadId: string, m: StoredMessage, waMessageId?: string): Promise<void> {
  const { error } = await supabase.from('messages').insert({
    lead_id: leadId, direction: m.direction, body: m.body, wa_message_id: waMessageId ?? null,
  });
  if (error) console.error('[db] appendMessage', error.message);
}

// P1-5: inbound insert that detects WhatsApp redeliveries via the partial
// unique index on wa_message_id. 'duplicate' → skip processing entirely.
export async function insertInboundMessage(
  leadId: string,
  body: string,
  waMessageId: string
): Promise<'inserted' | 'duplicate' | 'error'> {
  const { error } = await supabase.from('messages').insert({
    lead_id: leadId, direction: 'in', body, wa_message_id: waMessageId,
  });
  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate'; // unique_violation
  console.error('[db] insertInboundMessage', error.message);
  return 'error';
}

export async function getConversation(leadId: string): Promise<StoredMessage[]> {
  const { data, error } = await supabase
    .from('messages').select('direction, body')
    .eq('lead_id', leadId).order('created_at', { ascending: true });
  if (error) { console.error('[db] getConversation', error.message); return []; }
  return (data ?? []) as StoredMessage[];
}

export async function countMessages(leadId: string): Promise<number> {
  const { count, error } = await supabase
    .from('messages').select('id', { count: 'exact', head: true }).eq('lead_id', leadId);
  if (error) { console.error('[db] countMessages', error.message); return 0; }
  return count ?? 0;
}

// P0-1: a delivery-status webhook referenced this wa_message_id — find whose it is.
export async function findLeadByWaMessageId(waMessageId: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from('messages').select('lead_id').eq('wa_message_id', waMessageId).maybeSingle();
  if (error) { console.error('[db] findLeadByWaMessageId', error.message); return null; }
  if (!data?.lead_id) return null;
  return getLeadById(data.lead_id);
}

// --- system_events (operator-visible failures/notices) ---

export async function insertSystemEvent(
  tenantId: string | null,
  leadId: string | null,
  level: 'info' | 'warn' | 'error',
  kind: string,
  detail: string
): Promise<void> {
  const { error } = await supabase.from('system_events').insert({
    tenant_id: tenantId, lead_id: leadId, level, kind, detail,
  });
  if (error) console.error('[db] insertSystemEvent', error.message);
}

export async function recentSystemEvents(limit = 50): Promise<any[]> {
  const { data, error } = await supabase
    .from('system_events').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('[db] recentSystemEvents', error.message); return []; }
  return data ?? [];
}

// --- Stats (P2-13). "Today" = since UTC midnight. ---

export interface TenantStats {
  tenant: string;
  leads_today: number;
  replied_today: number;
  hot_today: number;
  booked_today: number;
  failed_today: number;
  opted_out_today: number;
}

export async function statsForTenant(tenant: Tenant): Promise<TenantStats> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select('status, classification, delivery_status, opted_out, last_inbound_at, created_at, updated_at')
    .eq('tenant_id', tenant.id)
    .gte('updated_at', sinceIso);
  if (error) console.error('[db] statsForTenant', error.message);

  const rows = data ?? [];
  const createdToday = rows.filter((r) => r.created_at >= sinceIso);
  return {
    tenant: tenant.name,
    leads_today: createdToday.length,
    replied_today: rows.filter((r) => r.last_inbound_at && r.last_inbound_at >= sinceIso).length,
    hot_today: rows.filter((r) => r.classification === 'hot').length,
    booked_today: rows.filter((r) => r.status === 'booked').length,
    failed_today: rows.filter((r) => r.delivery_status === 'failed').length,
    opted_out_today: rows.filter((r) => r.opted_out).length,
  };
}

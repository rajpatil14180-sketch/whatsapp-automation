import { Tenant, Lead, NormalizedLead, BrainResult } from './types';
import { config } from './config';
import * as db from './db';
import * as wa from './whatsapp';
import { runBrain, sanitizeReply } from './brain';
import { alertOperator } from './operator';
import { normalizePhone } from './phone';

// ============================================================
// Circuit breakers (P2-10). In-memory and single-instance — see
// README residual risks. Reset naturally on restart.
// ============================================================

// Per tenant/day template cap (protects cost + WhatsApp quality rating).
const templateCounters = new Map<string, { day: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function tenantTemplateBudgetOk(tenant: Tenant): boolean {
  const c = templateCounters.get(tenant.id);
  return !c || c.day !== today() || c.count < config.tenantDailyTemplateCap;
}

export function noteTemplateSent(tenant: Tenant): void {
  const d = today();
  const c = templateCounters.get(tenant.id);
  if (!c || c.day !== d) templateCounters.set(tenant.id, { day: d, count: 1 });
  else c.count++;
}

// Global per-minute cap on Claude calls.
let claudeWindowStart = 0;
let claudeCallsThisWindow = 0;

function claudeBudgetOk(): boolean {
  const now = Date.now();
  if (now - claudeWindowStart > 60_000) {
    claudeWindowStart = now;
    claudeCallsThisWindow = 0;
  }
  if (claudeCallsThisWindow >= config.claudeCallsPerMinute) return false;
  claudeCallsThisWindow++;
  return true;
}

// When is the next no-reply nudge due, after `sentSoFar` follow-ups? (P0-2)
export function computeNextFollowupAt(tenant: Tenant, sentSoFar: number): string | null {
  const templates = tenant.followup_templates ?? [];
  const remaining = Math.min(templates.length, tenant.max_followups);
  if (sentSoFar >= remaining) return null;
  const delays = tenant.followup_delays_minutes ?? [];
  const minutes = delays[sentSoFar] ?? delays[delays.length - 1] ?? 1440;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'there';
}

// ============================================================
// A fresh lead arrived (from any source): store it, fire the opener.
// ============================================================
export async function handleNewLead(tenant: Tenant, normalized: NormalizedLead): Promise<void> {
  const existing = await db.findLeadByPhone(tenant.id, normalized.phone);

  // Opted out means opted out — never contact again, whatever they submit (P2-9).
  if (existing?.opted_out) {
    await db.attachToLead(existing, normalized);
    console.log(`[engine] ${normalized.phone} re-submitted but is opted out; attached, not contacting`);
    return;
  }

  // P1-7: an active lead already exists (second form-fill, or form after a DM).
  // Attach to it — merge raw, do NOT create a duplicate, do NOT re-send the opener.
  if (existing && existing.status !== 'closed' && existing.status !== 'cold') {
    await db.attachToLead(existing, normalized);
    console.log(`[engine] ${normalized.phone} already active (status=${existing.status}); attached, skipping opener`);
    return;
  }

  const lead = await db.createLead(tenant.id, normalized, 'us');
  if (!lead) {
    await alertOperator(tenant, 'lead_create_failed', `could not store lead for ${normalized.phone}`);
    return;
  }

  if (!tenantTemplateBudgetOk(tenant)) {
    await db.setDeliveryStatus(lead.id, 'pending');
    await alertOperator(tenant, 'template_cap_reached',
      `daily template cap (${config.tenantDailyTemplateCap}) hit — opener NOT sent to ${normalized.phone}`, lead.id);
    return;
  }

  // Opener MUST be a template (cold contact, no 24h window yet).
  // Template needs one {{1}} body variable for the first name.
  const r = await wa.sendTemplate(tenant, normalized.phone, [firstName(normalized.name)]);
  if (r.id) {
    noteTemplateSent(tenant);
    await db.appendMessage(lead.id, { direction: 'out', body: `[template:${tenant.wa_opening_template}]` }, r.id);
    // Success also schedules the first no-reply nudge (P0-2).
    await db.markContacted(lead.id, computeNextFollowupAt(tenant, 0));
    console.log(`[engine] opener sent to ${normalized.phone}`);
  } else {
    // P0-1: a failed opener is exactly the failure this product exists to prevent.
    await db.setDeliveryStatus(lead.id, 'failed');
    await alertOperator(tenant, 'opener_failed',
      `opener to ${normalized.phone} failed: [${r.error?.code ?? '?'}] ${r.error?.message ?? 'unknown'}`, lead.id);
  }
}

// ============================================================
// Inbound WhatsApp message: de-dup, debounce, then run the brain.
// ============================================================

// P1-5: rapid-fire messages ("hi" / "you there?" / "hello?") coalesce into ONE
// brain run per quiet period. In-memory + single-instance — see README.
const DEBOUNCE_MS = 4000;
const pendingTurns = new Map<string, { timer: NodeJS.Timeout; texts: string[] }>();

const OPT_OUT_RE = /\b(stop|unsubscribe|not\s+interested|don'?t\s+(message|contact)|do\s+not\s+(message|contact)|remove\s+me)\b/i;

export async function handleInboundMessage(
  tenant: Tenant,
  from: string,
  text: string,
  waMessageId: string,
  name: string | null
): Promise<void> {
  const phone = normalizePhone(from, tenant.default_country_code);
  let lead = await db.findLeadByPhone(tenant.id, phone);

  // They messaged us without a prior lead record — student-initiated (this is
  // also where Click-to-WhatsApp ad taps land: no leadgen webhook, just their
  // first message). The brain opens human-first for these.
  if (!lead) {
    lead = await db.createLead(tenant.id, { source: 'manual', external_id: null, name, phone, raw: {} }, 'student');
    if (!lead) {
      await alertOperator(tenant, 'lead_create_failed', `could not store inbound-first lead ${phone}`);
      return;
    }
  }

  // P1-5: WhatsApp redeliveries hit the unique index and stop here.
  const inserted = await db.insertInboundMessage(lead.id, text, waMessageId);
  if (inserted === 'duplicate') {
    console.log(`[engine] duplicate wa_message_id ${waMessageId}; skipping`);
    return;
  }

  // Opted-out leads are stored (for the record) but never processed or replied to.
  if (lead.opted_out) return;

  // P2-9: explicit stop intent closes the lead immediately, before any AI runs.
  if (OPT_OUT_RE.test(text)) {
    await db.markOptedOut(lead.id);
    await alertOperator(tenant, 'lead_opted_out', `${lead.name ?? phone} opted out ("${text}")`, lead.id, 'info');
    return;
  }

  await db.markInbound(lead.id); // opens/refreshes the 24h window, cancels pending nudges

  // P2-11: human owns this conversation — store + forward, never auto-reply.
  if (lead.human_handoff) {
    await alertOperator(tenant, 'handoff_inbound',
      `message from ${lead.name ?? phone} (human handoff active): "${text}"`, lead.id, 'info');
    return;
  }

  // Debounce: (re)start the quiet-period timer for this lead.
  const entry = pendingTurns.get(lead.id) ?? { timer: setTimeout(() => {}, 0), texts: [] };
  clearTimeout(entry.timer);
  entry.texts.push(text);
  entry.timer = setTimeout(() => {
    processLeadTurn(tenant, lead!.id).catch((e) => console.error('[engine] turn error', e));
  }, DEBOUNCE_MS);
  pendingTurns.set(lead.id, entry);
}

// Runs once per quiet period, on everything the lead sent since the last run.
async function processLeadTurn(tenant: Tenant, leadId: string): Promise<void> {
  const entry = pendingTurns.get(leadId);
  pendingTurns.delete(leadId);
  if (!entry || !entry.texts.length) return;

  const lead = await db.getLeadById(leadId);
  if (!lead || lead.opted_out || lead.human_handoff) return;

  // P2-10: per-lead circuit breaker — a runaway conversation goes to a human.
  const msgCount = await db.countMessages(lead.id);
  if (msgCount > tenant.max_messages_per_lead) {
    await db.setHumanHandoff(lead.id, true);
    await alertOperator(tenant, 'circuit_breaker',
      `lead ${lead.name ?? lead.phone} exceeded ${tenant.max_messages_per_lead} messages — auto-reply stopped, human handoff`, lead.id, 'warn');
    return;
  }

  // P2-10: global Claude rate cap — skip this turn rather than blow the budget.
  if (!claudeBudgetOk()) {
    console.warn(`[engine] Claude per-minute cap (${config.claudeCallsPerMinute}) hit — skipping turn for ${lead.phone}`);
    await db.insertSystemEvent(tenant.id, lead.id, 'warn', 'claude_rate_capped', 'brain call skipped this turn');
    return;
  }

  const combined = entry.texts.join('\n');
  const history = await db.getConversation(lead.id);
  const prior = history.slice(0, Math.max(0, history.length - entry.texts.length));

  const result = await runBrain(tenant, lead, prior, combined);

  if (!result) {
    // Safety net: never ghost a lead if the brain fails.
    await sendReply(tenant, lead, 'Thanks for your message! One of our counsellors will get back to you shortly. 🙏');
    await alertOperator(tenant, 'brain_failed', `brain returned nothing for ${lead.phone}; sent fallback`, lead.id, 'warn');
    return;
  }

  // P2-9: the brain detected stop intent the keyword filter missed.
  if (result.opt_out) {
    await db.markOptedOut(lead.id);
    await alertOperator(tenant, 'lead_opted_out', `${lead.name ?? lead.phone} opted out (brain-detected)`, lead.id, 'info');
    return;
  }

  // P0-3: output guard — never let amounts/guarantees reach the lead.
  const { safe, flagged } = sanitizeReply(result.reply);
  if (flagged) {
    await alertOperator(tenant, 'reply_flagged', `guard replaced risky reply: "${result.reply}"`, lead.id, 'warn');
  }

  await db.applyBrainResult(lead, result);
  await sendReply(tenant, lead, safe);

  // P2-9: conversation completion.
  if (result.recommended_action === 'close') {
    await db.closeLead(lead.id, 'closed', 'not_interested');
  } else if (result.conversation_complete) {
    await db.closeLead(lead.id, 'booked', 'booked');
  }

  // Route hot leads: alert the counsellor immediately.
  if (result.classification === 'hot') {
    await notifyCounsellor(tenant, lead, result);
    if (tenant.auto_handoff_on_hot) {
      await db.setHumanHandoff(lead.id, true);
      await alertOperator(tenant, 'auto_handoff', `hot lead ${lead.name ?? lead.phone} handed to human (auto_handoff_on_hot)`, lead.id, 'info');
    }
  }
}

// ============================================================
// P0-4: window-aware reply. Free text inside the 24h window; if the
// window closed (or Meta rejects with a re-engagement error), fall
// back to the approved re-engagement template to reopen it.
// ============================================================
export async function sendReply(tenant: Tenant, lead: Lead, text: string): Promise<void> {
  if (lead.opted_out) return;

  if (wa.canSendFreeText(lead.last_inbound_at)) {
    const r = await wa.sendText(tenant, lead.phone, text);
    if (r.id) {
      await db.appendMessage(lead.id, { direction: 'out', body: text }, r.id);
      await db.markOutboundContact(lead.id);
      return;
    }
    if (!wa.isWindowClosedError(r.error)) {
      await alertOperator(tenant, 'reply_send_failed',
        `free-text reply to ${lead.phone} failed: [${r.error?.code ?? '?'}] ${r.error?.message ?? 'unknown'}`, lead.id);
      return;
    }
    // Window-closed error → fall through to the re-engagement template.
  }

  if (!tenant.reengagement_template) {
    await alertOperator(tenant, 'window_closed_no_template',
      `24h window closed for ${lead.phone} and no reengagement_template configured — lead left hanging`, lead.id);
    return;
  }
  if (!tenantTemplateBudgetOk(tenant)) {
    await alertOperator(tenant, 'template_cap_reached', `cap hit — re-engagement NOT sent to ${lead.phone}`, lead.id);
    return;
  }

  const r = await wa.sendTemplate(tenant, lead.phone, [firstName(lead.name)], tenant.reengagement_template);
  if (r.id) {
    noteTemplateSent(tenant);
    await db.appendMessage(lead.id, { direction: 'out', body: `[template:${tenant.reengagement_template}]` }, r.id);
    await db.markOutboundContact(lead.id);
    await alertOperator(tenant, 'window_closed_reengaged',
      `window closed for ${lead.phone}; sent re-engagement template instead of free text`, lead.id, 'warn');
  } else {
    await alertOperator(tenant, 'reengagement_failed',
      `re-engagement template to ${lead.phone} failed: [${r.error?.code ?? '?'}] ${r.error?.message ?? 'unknown'}`, lead.id);
  }
}

// ============================================================
// P1-6: hot-lead alert that actually arrives. Template first (works
// regardless of the counsellor's 24h window), free text only when
// their window is open, operator alert as redundancy either way.
// ============================================================
async function notifyCounsellor(tenant: Tenant, lead: Lead, r: BrainResult): Promise<void> {
  const e = r.extracted;
  // Money line follows the Q3 sub-tree: loan stance only matters when financing
  // is needed; scholarship expectation only when a loan was refused.
  let money = e.finance_situation ?? '?';
  if (e.finance_situation === 'needs_financing' && e.loan_openness && e.loan_openness !== 'not_discussed') {
    money += ` (loan: ${e.loan_openness}`;
    if (e.loan_openness === 'refused' && e.scholarship_expectation && e.scholarship_expectation !== 'not_discussed') {
      money += `, scholarship: ${e.scholarship_expectation}`;
    }
    money += ')';
  }
  const docs = e.documents_pending?.length ? e.documents_pending.join(', ') : 'none noted';
  const summary =
    `🔥 HOT LEAD — ${lead.name ?? lead.phone}\n` +
    `Country: ${e.target_country ?? 'undecided'} | Intake: ${e.intake ?? '?'}\n` +
    `Decided to go: ${e.decided_to_go ?? '?'} | Parents: ${e.parents_convinced ?? '?'} | Money: ${money}\n` +
    `Docs to chase (not blockers): ${docs}\n` +
    `Blocker: ${r.blocker}\n` +
    `Why: ${r.reasoning}\n` +
    `Chat: https://wa.me/${lead.phone}`;

  // Redundancy first: a hot lead must never be lost to a single failed channel.
  await alertOperator(tenant, 'hot_lead', summary, lead.id, 'info');

  if (!tenant.counsellor_wa) return;

  // Is the counsellor's own 24h window open? (They show up as a lead row if
  // they've ever messaged the business number.)
  const counsellorLead = await db.findLeadByPhone(tenant.id, tenant.counsellor_wa);
  const windowOpen = wa.canSendFreeText(counsellorLead?.last_inbound_at ?? null);

  if (tenant.counsellor_alert_template) {
    // Template vars: {{1}} name, {{2}} country, {{3}} intake, {{4}} wa.me link.
    const params = [
      lead.name ?? lead.phone,
      String(e.target_country ?? 'undecided'),
      String(e.intake ?? '-'),
      `https://wa.me/${lead.phone}`,
    ];
    const t = await wa.sendTemplate(tenant, tenant.counsellor_wa, params, tenant.counsellor_alert_template);
    if (t.id) { noteTemplateSent(tenant); return; }
    console.error('[engine] counsellor alert template failed', t.error);
    // Fall through: try free text if the window allows.
  }

  if (windowOpen || !tenant.counsellor_alert_template) {
    const t = await wa.sendText(tenant, tenant.counsellor_wa, summary);
    if (t.id) return;
    console.error('[engine] counsellor free-text alert failed', t.error);
  }

  await alertOperator(tenant, 'counsellor_alert_failed',
    `could not reach counsellor ${tenant.counsellor_wa} for hot lead ${lead.name ?? lead.phone} — chase them manually`, lead.id);
}

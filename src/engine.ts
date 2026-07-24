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

// Track A: next nudge for a lead that NEVER replied, after `sentSoFar` nudges.
// Timed from the previous contact (opener or prior nudge). Default cap 1 —
// dead leads get at most opener + 1 template.
export function computeNoreplyFollowupAt(tenant: Tenant, sentSoFar: number): string | null {
  const templates = tenant.noreply_followup_templates ?? [];
  const remaining = Math.min(templates.length, tenant.noreply_max_followups);
  if (sentSoFar >= remaining) return null;
  const delays = tenant.noreply_followup_delays_minutes ?? [];
  const minutes = delays[sentSoFar] ?? delays[delays.length - 1] ?? 180;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

// Track B: next stall-check for a lead that ENGAGED then went quiet. Timed
// from the last activity (callers invoke this whenever activity happens, so
// "now" IS the last-activity moment). Null = track exhausted/unconfigured.
export function computeStalledFollowupAt(tenant: Tenant, sentSoFar: number): string | null {
  const templates = tenant.stalled_followup_templates ?? [];
  const remaining = Math.min(templates.length, tenant.stalled_max_followups);
  if (sentSoFar >= remaining) return null;
  const delays = tenant.stalled_followup_delays_minutes ?? [];
  const minutes = delays[sentSoFar] ?? delays[delays.length - 1] ?? 1440;
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function firstName(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] || 'there';
}

// CHANGE 4: profile-based opener. Match the lead form's answers against the
// tenant's ordered opener_rules; first match wins, else the default opener.
// The opener still MUST be an approved template — rules only pick WHICH one.
export function pickOpenerTemplate(tenant: Tenant, normalized: NormalizedLead): string {
  const rules = tenant.opener_rules ?? [];
  if (!rules.length) return tenant.wa_opening_template;

  // Meta lead-form answers arrive as raw.field_data: [{ name, values: [...] }].
  const fields: Record<string, string> = {};
  const fieldData = (normalized.raw as { field_data?: unknown })?.field_data;
  if (Array.isArray(fieldData)) {
    for (const f of fieldData) {
      if (f?.name) fields[String(f.name).toLowerCase()] = String((f.values ?? [])[0] ?? '');
    }
  }

  for (const rule of rules) {
    if (!rule?.when_field || !rule.template) continue;
    const value = fields[rule.when_field.toLowerCase()];
    if (value !== undefined && value.trim().toLowerCase() === String(rule.equals ?? '').trim().toLowerCase()) {
      return rule.template;
    }
  }
  return tenant.wa_opening_template;
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

  // Opener MUST be a template (cold contact, no 24h window yet). Which one is
  // picked by the tenant's opener_rules against the form data (CHANGE 4).
  // Every opener template needs one {{1}} body variable for the first name.
  const opener = pickOpenerTemplate(tenant, normalized);
  const r = await wa.sendTemplate(tenant, normalized.phone, [firstName(normalized.name)], opener);
  if (r.id) {
    noteTemplateSent(tenant);
    await db.appendMessage(lead.id, { direction: 'out', body: `[template:${opener}]` }, r.id);
    // Success also schedules the first never-replied nudge (Track A).
    await db.markContacted(lead.id, computeNoreplyFollowupAt(tenant, 0));
    console.log(`[engine] opener "${opener}" sent to ${normalized.phone}`);
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
//
// ADAPTIVE DEBOUNCE (Part 7): a single fixed wait treats a complete question
// and a one-word fragment the same. WhatsApp delivers no typing-indicator
// webhook, so this can only be driven by message CONTENT and ARRIVAL, never
// typing state. debounceForText() picks the quiet period per message:
//   SHORT  — reads as a complete question/thought: reply almost immediately.
//   LONG   — reads as a fragment (still typing): give them room to continue.
//   NORMAL — everything else.
// Every new message re-clears and restarts the timer using ITS OWN
// classification, so the wait is always recomputed from the LATEST message —
// deliberately NO time ceiling: if the lead keeps typing, keep waiting, since
// someone still typing does not want an answer yet. MAX_PENDING_MESSAGES is
// the only cap, and it exists purely as a volume safety valve against a
// spammer or broken client, not against normal typing.
export const DEBOUNCE_SHORT_MS = 2500;
export const DEBOUNCE_LONG_MS = 14000;
export const DEBOUNCE_NORMAL_MS = 7000;
const MAX_PENDING_MESSAGES = 12;

const INTERROGATIVE_WORDS = new Set([
  'what', 'how', 'which', 'when', 'where', 'why', 'who',
  'can', 'could', 'do', 'does', 'is', 'are', 'should', 'will',
]);

// Returns the quiet period to use for a just-arrived message.
export function debounceForText(text: string): number {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const firstWord = (words[0] ?? '').toLowerCase().replace(/[^a-z']/g, '');

  const endsInQuestionMark = trimmed.endsWith('?');
  const interrogativeOpener = INTERROGATIVE_WORDS.has(firstWord) && wordCount >= 4;
  const isLong = wordCount >= 25;
  if (endsInQuestionMark || interrogativeOpener || isLong) return DEBOUNCE_SHORT_MS;

  const endsWithTerminalPunctuation = /[.!?]$/.test(trimmed);
  if (wordCount <= 3 && !endsWithTerminalPunctuation) return DEBOUNCE_LONG_MS;

  return DEBOUNCE_NORMAL_MS;
}

interface PendingEntry {
  timer: NodeJS.Timeout;
  texts: string[];
}
const pendingTurns = new Map<string, PendingEntry>();

// Reschedules entry.timer — the single place that applies the adaptive delay
// and the volume safety valve, used both when a new fragment arrives and when
// a completed turn re-debounces leftover texts. Delay is always computed from
// the LAST (most recent) text in the batch.
function scheduleTurn(tenant: Tenant, leadId: string, entry: PendingEntry): void {
  clearTimeout(entry.timer);

  if (entry.texts.length >= MAX_PENDING_MESSAGES) {
    console.warn(`[engine] pending batch for ${leadId} reached MAX_PENDING_MESSAGES (${MAX_PENDING_MESSAGES}); firing turn immediately`);
    entry.timer = setTimeout(() => {
      maybeRunTurn(tenant, leadId).catch((e) => console.error('[engine] turn error', e));
    }, 0);
    return;
  }

  const delay = debounceForText(entry.texts[entry.texts.length - 1] ?? '');
  entry.timer = setTimeout(() => {
    maybeRunTurn(tenant, leadId).catch((e) => console.error('[engine] turn error', e));
  }, delay);
}

// ============================================================
// QUIET HOURS (Part 9e): holds back PROACTIVE messages only (the
// in-conversation stall nudge below, and scheduler.ts follow-ups) — never
// affects replying to an inbound message. Wraps midnight when
// quiet_hours_start > quiet_hours_end (default 21 -> 9, i.e. 9pm-9am).
// ============================================================
export function isQuietHours(tenant: Tenant, at: Date = new Date()): boolean {
  const tz = tenant.timezone || 'Asia/Kolkata';
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
    hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  } catch (e) {
    console.warn(`[engine] invalid tenant timezone "${tz}"; quiet-hours check skipped`, e);
    return false;
  }
  const start = tenant.quiet_hours_start ?? 21;
  const end = tenant.quiet_hours_end ?? 9;
  if (start === end) return false; // zero-width window disables quiet hours
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

// Fix 3: per-lead turn lock. WhatsApp users type in fragments and brain
// latency (2–5s) can exceed the debounce, so a fragment can land while a turn
// is mid-flight. The lock guarantees ONE turn at a time per lead; fragments
// that arrive during a turn wait and get answered in the NEXT single turn.
const activeTurns = new Set<string>();

// Stale-turn guard: activeTurns stops a PARALLEL turn, but not a stale
// SEQUENTIAL one — a fragment can land while the brain call (8-15s with the
// current model) is already in flight, after entry.texts was captured. Without
// this, the in-flight reply gets sent anyway (answering content the lead has
// since added to), immediately followed by a second turn/reply for the new
// message. Counts consecutive discards per lead so a lead typing continuously
// still gets answered rather than being discarded forever.
const staleReruns = new Map<string, number>();
const MAX_STALE_RERUNS = 2;

// How many recent inbound messages count as "already in play" for the amount
// guard (sanitizeReply) — enough to cover a figure the lead mentioned a
// couple of turns ago without scanning the whole conversation.
const RECENT_INBOUND_FOR_GUARD = 5;

const FALLBACK_REPLY = 'Thanks for your message! One of our counsellors will get back to you shortly. 🙏';

// ============================================================
// QUIET MID-CONVERSATION NUDGE (Part 9). In-process setTimeout, same
// in-memory/single-instance pattern as pendingTurns/activeTurns above —
// deliberately NOT in scheduler.ts or the DB (see README residual risks).
// This is distinct from the Track B stalled-follow-up template: that's a
// long-horizon (hours/days) paid template for a lead that never resumed
// after the window closed; this is a same-conversation, free-text, one-shot
// check-in fired 2 minutes after OUR message if they go quiet mid-chat.
// ============================================================
const STALL_NUDGE_MS = 120000;
const stallTimers = new Map<string, NodeJS.Timeout>();
// One nudge per lead, ever (in-memory only — resets on restart, an accepted
// limitation of the in-process approach specified for this feature).
const stallNudgeSent = new Set<string>();

function clearStallTimer(leadId: string): void {
  const t = stallTimers.get(leadId);
  if (t) {
    clearTimeout(t);
    stallTimers.delete(leadId);
  }
}

// Start/restart the stall timer — called after a reply is successfully sent.
function startOrRestartStallTimer(tenant: Tenant, lead: Lead): void {
  clearStallTimer(lead.id);
  const timer = setTimeout(() => {
    maybeFireStallNudge(tenant, lead.id).catch((e) => console.error('[engine] stall nudge error', e));
  }, STALL_NUDGE_MS);
  stallTimers.set(lead.id, timer);
}

// The lead's last message signalled they'll act on their own and come back —
// nudging here would read as impatient, not helpful.
const AWAY_INTENT_RE =
  /\b(i'?ll\s+(ask|check|think|talk|see|discuss)|let\s+me\s+(think|check|see|ask)|will\s+get\s+back|get\s+back\s+to\s+you|talk\s+(to\s+you\s+)?later|call\s+(you\s+)?(back|later)|will\s+(think|check|ask)|need\s+to\s+(think|check|ask|discuss))\b/i;

// One runaway_check ping per lead per process — a hot lead past the runaway
// cap keeps being served; the operator just gets told once to glance at it.
const runawayAlerted = new Set<string>();

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

  // Part 9b: any genuine inbound message means the lead is not "gone quiet" —
  // cancel any pending stall nudge, whatever the message says.
  clearStallTimer(lead.id);

  // Opted-out leads are stored (for the record) but never processed or replied to.
  if (lead.opted_out) return;

  // P2-9: explicit stop intent closes the lead immediately, before any AI runs.
  if (OPT_OUT_RE.test(text)) {
    await db.markOptedOut(lead.id);
    await alertOperator(tenant, 'lead_opted_out', `${lead.name ?? phone} opted out ("${text}")`, lead.id, 'info');
    return;
  }

  // Opens/refreshes the 24h window, cancels Track A nudges, resets and
  // restarts the Track B stall clock from this moment of activity.
  await db.markInbound(lead.id, computeStalledFollowupAt(tenant, 0));

  // P2-11: human owns this conversation — store + forward, never auto-reply.
  if (lead.human_handoff) {
    await alertOperator(tenant, 'handoff_inbound',
      `message from ${lead.name ?? phone} (human handoff active): "${text}"`, lead.id, 'info');
    return;
  }

  // Debounce: (re)start the quiet-period timer for this lead.
  const entry = pendingTurns.get(lead.id) ?? { timer: setTimeout(() => {}, 0), texts: [] };
  entry.texts.push(text);
  scheduleTurn(tenant, lead.id, entry);
  pendingTurns.set(lead.id, entry);
}

// Fix 3: the lock covers the WHOLE turn (brain call + sends + writes). If the
// timer fires while a turn is in flight, we simply return — the pending texts
// stay queued, and the finally-block re-debounces them once the turn releases,
// so mid-flight fragments are answered in one follow-up turn, never a parallel
// one. In-memory + single-instance, like the debounce (see README).
async function maybeRunTurn(tenant: Tenant, leadId: string): Promise<void> {
  if (activeTurns.has(leadId)) return; // fragments re-scheduled on release below
  activeTurns.add(leadId);
  try {
    await processLeadTurn(tenant, leadId);
  } finally {
    activeTurns.delete(leadId);
    // Fragments that arrived mid-turn: give them a fresh quiet period, then run.
    const entry = pendingTurns.get(leadId);
    if (entry && entry.texts.length) {
      scheduleTurn(tenant, leadId, entry);
    }
  }
}

// Runs once per quiet period, on everything the lead sent since the last run.
// Fix 2: the whole body is error-contained — any mid-turn throw (e.g. a DB
// timeout) still ends with the student answered and the operator alerted; a
// lead's turn can never fail silently. The reply is sent BEFORE the state
// bookkeeping, so a late failure can't un-answer the student.
async function processLeadTurn(tenant: Tenant, leadId: string): Promise<void> {
  const entry = pendingTurns.get(leadId);
  pendingTurns.delete(leadId);
  if (!entry || !entry.texts.length) return;

  const lead = await db.getLeadById(leadId);
  if (!lead || lead.opted_out || lead.human_handoff) return;

  let replied = false;
  try {
    // RUNAWAY SAFETY NET (last resort against bugs/spammers, ~100 msgs — NOT
    // the normal escalation path; that is the AI's needs_human judgment below).
    // A hot lead is never frozen by this: long hot conversations are usually
    // the lead being serious, so a human just gets pinged to glance at it.
    const msgCount = await db.countMessages(lead.id);
    if (msgCount > tenant.max_messages_per_lead) {
      if (lead.classification === 'hot') {
        if (!runawayAlerted.has(lead.id)) {
          runawayAlerted.add(lead.id);
          await alertOperator(tenant, 'runaway_check',
            `hot lead ${lead.name ?? lead.phone} passed ${tenant.max_messages_per_lead} messages — AI continuing (hot leads are never frozen); please glance at the chat: https://wa.me/${lead.phone}`,
            lead.id, 'warn');
        }
      } else {
        await db.setHumanHandoff(lead.id, true);
        clearStallTimer(lead.id);
        await alertOperator(tenant, 'runaway_stop',
          `lead ${lead.name ?? lead.phone} passed ${tenant.max_messages_per_lead} messages without becoming hot — auto-reply stopped as a cost/safety stop, human handoff`,
          lead.id, 'warn');
        return;
      }
    }

    // P2-10: global Claude rate cap — skip this turn rather than blow the budget.
    if (!claudeBudgetOk()) {
      console.warn(`[engine] Claude per-minute cap (${config.claudeCallsPerMinute}) hit — skipping turn for ${lead.phone}`);
      await db.insertSystemEvent(tenant.id, lead.id, 'warn', 'claude_rate_capped', 'brain call skipped this turn');
      return;
    }

    const history = await db.getConversation(lead.id);
    const prior = history.slice(0, Math.max(0, history.length - entry.texts.length));

    // Fix 3: pass the individual fragments, not a joined string — runBrain
    // frames >1 message explicitly as "N messages, answer all of them" so a
    // quick burst gets one reply that addresses everything, not just the first.
    const result = await runBrain(tenant, lead, prior, entry.texts);

    // Opt-out / handoff can land while the brain call was in flight —
    // handleInboundMessage handles those and returns before ever touching
    // pendingTurns, so the stale-turn check below can't see them. Re-fetch and
    // abort outright (never send/write) rather than re-run: unlike a stray
    // fragment, this lead should not be auto-replied to at all right now.
    const fresh = await db.getLeadById(leadId);
    if (!fresh || fresh.opted_out || fresh.human_handoff) {
      staleReruns.delete(leadId);
      clearStallTimer(leadId);
      console.log(`[engine] lead ${leadId} opted out or handed off mid-turn; discarding reply`);
      return;
    }

    // Stale-turn check: did new inbound text arrive while the brain call was
    // in flight? If so this reply would answer content the lead has already
    // added to — discard it (never send, never write) and let the next turn
    // answer everything together instead of sending twice.
    const arrivedDuringTurn = pendingTurns.get(leadId)?.texts.length ?? 0;
    if (arrivedDuringTurn > 0) {
      const reruns = staleReruns.get(leadId) ?? 0;
      if (reruns < MAX_STALE_RERUNS) {
        staleReruns.set(leadId, reruns + 1);
        // Restore full chronological order: this turn's texts, then whatever
        // arrived during it. maybeRunTurn's finally-block re-debounces and
        // re-runs the turn on the combined set once this one releases.
        pendingTurns.get(leadId)!.texts.unshift(...entry.texts);
        console.log(`[engine] stale turn for ${leadId}, re-running with ${arrivedDuringTurn} queued message(s)`);
        return;
      }
      // A lead typing continuously must still get an answer — stop discarding.
      staleReruns.delete(leadId);
    }

    if (!result) {
      // Safety net: never ghost a lead if the brain fails or returns garbage.
      await sendReply(tenant, lead, FALLBACK_REPLY);
      replied = true;
      staleReruns.delete(leadId);
      await alertOperator(tenant, 'brain_failed', `brain returned nothing usable for ${lead.phone}; sent fallback`, lead.id, 'warn');
      return;
    }

    // P2-9: the brain detected stop intent the keyword filter missed.
    if (result.opt_out) {
      await db.markOptedOut(lead.id);
      clearStallTimer(leadId);
      await alertOperator(tenant, 'lead_opted_out', `${lead.name ?? lead.phone} opted out (brain-detected)`, lead.id, 'info');
      return;
    }

    // P0-3: output guard — never let INVENTED amounts/guarantees reach the
    // lead. Amounts already "in play" are exempt from the amount check (but
    // never the promise check): this turn's own messages, a few recent
    // inbound messages, and the tenant's curated knowledge base.
    const recentInbound = prior.filter((m) => m.direction === 'in').slice(-RECENT_INBOUND_FOR_GUARD).map((m) => m.body ?? '');
    const allowedSources = [...entry.texts, ...recentInbound, ...(tenant.knowledge_base ? [tenant.knowledge_base] : [])];
    const { safe, flagged } = sanitizeReply(result.reply, allowedSources);

    // Answer the student FIRST; everything below is bookkeeping that must
    // never stand between the lead and a reply.
    await sendReply(tenant, lead, safe);
    replied = true;
    staleReruns.delete(leadId);
    // Part 9b: this reply may ask something — start the 2-minute quiet-mid-
    // conversation check. (If we're about to close the lead below, that path
    // clears it again immediately after — harmless, keeps this ordering simple.)
    startOrRestartStallTimer(tenant, lead);

    if (flagged) {
      await alertOperator(tenant, 'reply_flagged', `guard replaced risky reply: "${result.reply}"`, lead.id, 'warn');
    }

    await db.applyBrainResult(lead, result);

    // P2-9: conversation completion.
    if (result.recommended_action === 'close') {
      await db.closeLead(lead.id, 'closed', 'not_interested');
      clearStallTimer(leadId);
    } else if (result.conversation_complete) {
      await db.closeLead(lead.id, 'booked', 'booked');
      clearStallTimer(leadId);
    }

    // Route hot leads: the counsellor gets the BOOKING (summary + proposed
    // meeting time) — once per lead, once the summary is real (Fix 5). The AI
    // keeps the conversation and works to lock the time (CHANGE 1).
    if (result.classification === 'hot') {
      await notifyCounsellor(tenant, lead, result);
    }

    // AI-judged escalation (CHANGE 2): the ONE case where the live conversation
    // is handed to a human — the AI is stuck, the lead is frustrated/confused,
    // or the lead asked for a person. The handover reply above already went out.
    // Never for a hot lead: a hot lead asking for a human is the strongest
    // buying signal, and the counsellor call being booked above IS that human —
    // so the booking flow handles it and the AI stays active.
    if (result.needs_human && result.classification !== 'hot') {
      const reason = result.needs_human_reason || 'unspecified';
      await db.setHumanHandoff(lead.id, true);
      clearStallTimer(leadId);
      await alertOperator(tenant, 'needs_human',
        `AI escalated ${lead.name ?? lead.phone} (reason: ${reason}) — take over the chat: https://wa.me/${lead.phone}`,
        lead.id, 'warn');
      if (tenant.counsellor_wa) {
        const counsellorLead = await db.findLeadByPhone(tenant.id, tenant.counsellor_wa);
        if (wa.canSendFreeText(counsellorLead?.last_inbound_at ?? null)) {
          await wa.sendText(tenant, tenant.counsellor_wa,
            `🙋 Human needed (${reason}) — ${lead.name ?? lead.phone}\nTake over the chat: https://wa.me/${lead.phone}`);
        }
      }
    }
  } catch (e) {
    // Fix 2: a mid-turn failure must never silently ghost the lead.
    console.error('[engine] turn failed for', lead.phone, e);
    if (!replied) {
      try { await sendReply(tenant, lead, FALLBACK_REPLY); } catch (e2) { console.error('[engine] fallback send also failed', e2); }
    }
    try {
      await alertOperator(tenant, 'turn_error',
        `turn for ${lead.name ?? lead.phone} threw ${replied ? 'AFTER the reply was sent (state writes may be incomplete)' : 'before any reply (fallback attempted)'}: ${e instanceof Error ? e.message : String(e)}`,
        lead.id, 'error');
    } catch (e3) { console.error('[engine] turn_error alert failed', e3); }
  }
}

// Part 9c: fires ~2 minutes after our last reply if the lead has gone quiet.
// Every gate below must hold, or the nudge is skipped entirely (never
// deferred — a 2-minute check-in delivered late defeats its own purpose).
async function maybeFireStallNudge(tenant: Tenant, leadId: string): Promise<void> {
  stallTimers.delete(leadId); // this timer has fired; it's spent either way

  const fresh = await db.getLeadById(leadId);
  if (!fresh || fresh.opted_out || fresh.human_handoff) return;
  if (fresh.status === 'booked' || fresh.status === 'closed') return;
  if (stallNudgeSent.has(leadId)) return;
  if (!wa.canSendFreeText(fresh.last_inbound_at)) return; // free text only, never a template
  if (isQuietHours(tenant)) return; // dropped entirely, not deferred

  const history = await db.getConversation(leadId);
  if (!history.length) return;
  const lastOutbound = [...history].reverse().find((m) => m.direction === 'out');
  const lastInbound = [...history].reverse().find((m) => m.direction === 'in');

  // Gate: our last message must have actually asked something — nothing to
  // chase otherwise.
  if (!lastOutbound?.body || !lastOutbound.body.includes('?')) return;

  // Gate: the lead's last message must not have signalled they'll act and
  // come back on their own ("I'll ask my parents", "let me think"...).
  if (lastInbound?.body && AWAY_INTENT_RE.test(lastInbound.body)) return;

  const result = await runBrain(tenant, fresh, history, [], 'nudge');
  if (!result) return; // no nudge this time is fine — they already have our last message, unlike a ghosted reply

  const recentInbound = history.filter((m) => m.direction === 'in').slice(-RECENT_INBOUND_FOR_GUARD).map((m) => m.body ?? '');
  const allowedSources = [...recentInbound, ...(tenant.knowledge_base ? [tenant.knowledge_base] : [])];
  const { safe } = sanitizeReply(result.reply, allowedSources);

  const r = await wa.sendText(tenant, fresh.phone, safe);
  if (r.id) {
    stallNudgeSent.add(leadId);
    await db.appendMessage(leadId, { direction: 'out', body: safe }, r.id);
    await db.markOutboundContact(leadId, computeStalledFollowupAt(tenant, fresh.stalled_followups_sent ?? 0));
    console.log(`[engine] stall nudge sent to ${fresh.phone}`);
  } else {
    console.warn(`[engine] stall nudge send failed for ${fresh.phone}: [${r.error?.code ?? '?'}] ${r.error?.message ?? 'unknown'}`);
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
      // Our reply is activity — restart the Track B stall clock from now.
      await db.markOutboundContact(lead.id, computeStalledFollowupAt(tenant, lead.stalled_followups_sent ?? 0));
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
    await db.markOutboundContact(lead.id, computeStalledFollowupAt(tenant, lead.stalled_followups_sent ?? 0));
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
  // Fix 5: this alert fires exactly ONCE per lead, ever.
  if (lead.hot_alerted) return;

  // Use everything known about the lead, not just this turn's increment.
  const e = { ...(lead.extracted ?? {}), ...r.extracted } as BrainResult['extracted'];

  // Fix 5: don't hand over a bare "hot" with no substance — wait until the AI
  // has a real summary (core signals + at least one concrete detail). A later
  // turn will alert once the detail exists; the brain is instructed to keep
  // gathering it.
  const known = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== 'unclear';
  const coreKnown = known(e.decided_to_go) && known(e.parents_convinced);
  const detailKnown = known(e.target_country) || known(e.intake) || known(e.finance_situation);
  if (!coreKnown || !detailKnown) {
    console.log(`[engine] ${lead.phone} is hot but the summary is still thin — deferring the counsellor alert`);
    return;
  }

  // Claim the one-shot BEFORE sending so no later turn can double-alert.
  await db.markHotAlerted(lead.id);

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
  // This is a BOOKING notification, not a conversation handoff — the AI keeps
  // the chat and keeps working toward/confirming the call time.
  const summary =
    `🔥 HOT LEAD — ${lead.name ?? lead.phone}\n` +
    `Proposed call: ${e.meeting_time ?? 'to be confirmed'}\n` +
    `Country: ${e.target_country ?? 'undecided'} | Intake: ${e.intake ?? '?'}\n` +
    `Decided to go: ${e.decided_to_go ?? '?'} | Parents: ${e.parents_convinced ?? '?'} | Money: ${money}\n` +
    `Docs to chase (not blockers): ${docs}\n` +
    `Blocker: ${r.blocker}\n` +
    `Why: ${r.reasoning}\n` +
    `Student WhatsApp: +${lead.phone}\n` +
    `Chat: https://wa.me/${lead.phone}\n` +
    `Open this chat from the business WhatsApp account to view the full conversation.`;

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

import * as db from './db';
import * as wa from './whatsapp';
import { alertOperator } from './operator';
import { computeNoreplyFollowupAt, computeStalledFollowupAt, tenantTemplateBudgetOk, noteTemplateSent, isQuietHours } from './engine';
import { config } from './config';

// ============================================================
// Background scheduler (P0-2). Runs inside the always-on server
// process — this does NOT work on scale-to-zero/serverless hosting
// (Railway keeps the process alive; see README).
//
// Every ~2 minutes: sweep leads whose no-reply nudge is due and send
// the next follow-up TEMPLATE (they never replied → window closed →
// template is the only legal message).
// ============================================================

const SWEEP_INTERVAL_MS = 2 * 60 * 1000;
const DIGEST_UTC_HOUR = 6; // daily digest sends on the first sweep after 06:00 UTC

let lastDigestDay = '';

export function startScheduler(): void {
  setInterval(() => {
    sweepFollowups().catch((e) => console.error('[scheduler] sweep error', e));
    maybeSendDailyDigest().catch((e) => console.error('[scheduler] digest error', e));
  }, SWEEP_INTERVAL_MS);
  console.log(`[scheduler] started (sweep every ${SWEEP_INTERVAL_MS / 1000}s)`);
}

// Two tracks (CHANGE 3), both driven by leads.next_followup_at:
//   Track A "noreply" — never replied. Cheap: default 1 nudge, timed from the
//   opener/previous contact. Caps dead-lead spend at opener + 1 template.
//   Track B "stalled" — replied at least once, then went quiet without booking
//   or closing. Worth more: default 2 nudges, timed from the last activity
//   (markInbound/markOutboundContact restart that clock on every message).
export async function sweepFollowups(): Promise<void> {
  const due = await db.getDueFollowupLeads();
  if (!due.length) return;
  console.log(`[scheduler] ${due.length} follow-up(s) due`);

  for (const lead of due) {
    const tenant = lead.tenant;

    // Quiet hours (9e): unlike the in-conversation stall nudge, a follow-up
    // template is not time-critical the same way — defer rather than drop.
    // Leave next_followup_at untouched so this lead is simply picked up again
    // on the next sweep (2 min later), retrying until quiet hours end.
    if (isQuietHours(tenant)) {
      console.log(`[scheduler] quiet hours for ${tenant.name} — deferring ${lead.track} follow-up to ${lead.phone}`);
      continue;
    }

    const isStalled = lead.track === 'stalled';

    // Pick the track's template list / counter / cap.
    const sentSoFar = isStalled ? (lead.stalled_followups_sent ?? 0) : lead.followups_sent;
    const cap = isStalled ? tenant.stalled_max_followups : tenant.noreply_max_followups;
    const templates = isStalled ? tenant.stalled_followup_templates : tenant.noreply_followup_templates;
    const templateName = (templates ?? [])[sentSoFar];

    // Belt and braces: the query filters most of this, but tenant config is per-row.
    if (sentSoFar >= cap || !templateName) {
      await db.setNextFollowupAt(lead.id, null); // exhausted/unconfigured for this track
      continue;
    }
    if (!tenantTemplateBudgetOk(tenant)) {
      await alertOperator(tenant, 'template_cap_reached',
        `daily template cap hit — ${lead.track} follow-up ${sentSoFar + 1} to ${lead.phone} deferred`, lead.id, 'warn');
      await db.setNextFollowupAt(lead.id, new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString());
      continue;
    }

    // Claim the lead so a slow/overlapping sweep never double-sends (P0-2).
    if (!(await db.claimLead(lead.id))) continue;

    try {
      const first = lead.name?.trim().split(/\s+/)[0] || 'there';
      const r = await wa.sendTemplate(tenant, lead.phone, [first], templateName);
      if (r.id) {
        noteTemplateSent(tenant);
        const sent = sentSoFar + 1;
        await db.appendMessage(lead.id, { direction: 'out', body: `[template:${templateName}]` }, r.id);
        if (isStalled) {
          // The nudge itself is the latest activity — next stall check counts from it.
          await db.recordStalledFollowupSent(lead.id, sent, computeStalledFollowupAt(tenant, sent));
        } else {
          await db.recordFollowupSent(lead.id, sent, computeNoreplyFollowupAt(tenant, sent));
        }
        console.log(`[scheduler] ${lead.track} follow-up ${sent} sent to ${lead.phone} (${templateName})`);
      } else {
        // Push the retry out 6h so a persistent failure doesn't hot-loop every sweep.
        await db.setNextFollowupAt(lead.id, new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString());
        await alertOperator(tenant, 'followup_failed',
          `${lead.track} follow-up "${templateName}" to ${lead.phone} failed: [${r.error?.code ?? '?'}] ${r.error?.message ?? 'unknown'}`, lead.id);
      }
    } finally {
      await db.releaseLead(lead.id);
    }
  }
}

// ============================================================
// Daily digest (P2-13): a short per-tenant summary to the operator.
// WhatsApp free text — only delivers if the operator's own 24h window
// is open (they messaged the business number); otherwise the email
// stub logs and the numbers remain available via GET /stats.
// ============================================================
async function maybeSendDailyDigest(): Promise<void> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (day === lastDigestDay || now.getUTCHours() < DIGEST_UTC_HOUR) return;
  lastDigestDay = day;

  for (const tenant of await db.listTenants()) {
    const s = await db.statsForTenant(tenant);
    const text =
      `📊 ${tenant.name} — daily digest\n` +
      `New leads: ${s.leads_today} | Replied: ${s.replied_today} | Hot: ${s.hot_today}\n` +
      `Booked: ${s.booked_today} | Failed sends: ${s.failed_today} | Opt-outs: ${s.opted_out_today}`;

    const to = tenant.operator_wa || config.operatorWa;
    if (!to) continue;
    const r = await wa.sendText(tenant, to, text);
    if (!r.id) console.log(`[scheduler] digest to ${to} not delivered (window likely closed) — see /stats`);
  }
}

import { config } from './config';
import { Tenant } from './types';
import * as db from './db';
import * as wa from './whatsapp';

// ============================================================
// Operator alerting (fail safe, never silent).
// Any failure that could drop a lead flows through here:
//   1. Always persisted to system_events (survives even if WA fails).
//   2. WhatsApp message to the operator. LIMITATION: this is free text,
//      so it only delivers if the operator has messaged the business
//      number within 24h. Have the operator message each tenant number
//      once and keep the thread alive — documented in README.
//   3. Optional email fallback — a no-op stub until a provider is wired.
// ============================================================

export async function alertOperator(
  tenant: Tenant,
  kind: string,
  detail: string,
  leadId?: string,
  level: 'info' | 'warn' | 'error' = 'error'
): Promise<void> {
  console.error(`[operator] [${level}] ${kind}: ${detail}`);

  // 1. Durable record first — this must never be skipped.
  await db.insertSystemEvent(tenant.id, leadId ?? null, level, kind, detail);

  // 2. WhatsApp to the operator.
  const to = tenant.operator_wa || config.operatorWa;
  if (to) {
    const text = `⚠️ [${tenant.name}] ${kind}\n${detail}`.slice(0, 3500);
    const r = await wa.sendText(tenant, to, text);
    if (!r.id) {
      console.error(`[operator] WhatsApp alert to ${to} failed (likely no open 24h window):`, r.error?.message);
    }
  } else {
    console.error('[operator] no operator_wa / OPERATOR_WA configured — alert only in system_events');
  }

  // 3. Email fallback (stub).
  if (tenant.operator_email) {
    await sendEmail(tenant.operator_email, `[${tenant.name}] ${kind}`, detail);
  }
}

// STUB: no email provider is wired in. Deliberately a no-op (console log only)
// so we don't invent a dependency. To make this real, plug in your SMTP/API
// provider here — the call sites don't need to change.
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  console.log(`[operator] sendEmail stub (no provider configured): to=${to} subject="${subject}" body="${body.slice(0, 200)}"`);
}

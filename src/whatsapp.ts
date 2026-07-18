import { config } from './config';
import { Tenant } from './types';

const GRAPH = `https://graph.facebook.com/${config.graphVersion}`;

// ============================================================
// SENDING
// The WhatsApp rule that shapes everything:
//   - To a COLD contact (no reply yet) you may ONLY send an approved TEMPLATE.
//   - Once the contact REPLIES, a 24-hour window opens and you may send free text.
//   - When the window closes, you're back to templates.
// ============================================================

// Rich send result (P0-1): callers must be able to tell WHY a send failed
// (bad template vs closed window vs network) and alert the operator.
export interface SendResult {
  id: string | null;
  error?: { code?: number; message?: string };
}

// Meta error code 131047 = "re-engagement message" — free text outside the 24h window.
export function isWindowClosedError(error?: { code?: number; message?: string }): boolean {
  if (!error) return false;
  if (error.code === 131047) return true;
  return /re-?engagement|24[\s-]?hour|outside.*window/i.test(error.message ?? '');
}

// Send an approved template by name. Defaults to the tenant's opening template
// so existing callers keep their behavior; follow-ups / counsellor alerts /
// re-engagement pass their own template name.
export async function sendTemplate(
  tenant: Tenant,
  to: string,
  bodyParams: string[] = [],
  templateName?: string
): Promise<SendResult> {
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: t })) }]
    : undefined;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName || tenant.wa_opening_template,
      language: { code: tenant.wa_template_lang },
      ...(components ? { components } : {}),
    },
  };
  return send(tenant, payload);
}

// Free-form text — ONLY valid inside the 24h window (after the lead has messaged us).
export async function sendText(tenant: Tenant, to: string, text: string): Promise<SendResult> {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };
  return send(tenant, payload);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries on network errors and HTTP 5xx (1s then 3s). 4xx client errors
// (bad template, bad number, closed window) are returned immediately — they
// will not succeed on retry.
async function send(tenant: Tenant, payload: unknown): Promise<SendResult> {
  const delays = [1000, 3000];
  let last: SendResult = { id: null, error: { message: 'not attempted' } };

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(`${GRAPH}/${tenant.wa_phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.wa_token}` },
        body: JSON.stringify(payload),
      });
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) return { id: json?.messages?.[0]?.id ?? null };

      const error = {
        code: json?.error?.code as number | undefined,
        message: (json?.error?.message as string | undefined) ?? `HTTP ${res.status}`,
      };
      console.error('[wa] send failed', JSON.stringify(json?.error ?? json));
      last = { id: null, error };
      if (res.status < 500) return last; // 4xx: don't retry
    } catch (e) {
      console.error('[wa] send network error', e);
      last = { id: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return last;
}

// True if the lead messaged us within the last 24h (free text allowed).
export function canSendFreeText(lastInboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  return Date.now() - new Date(lastInboundAt).getTime() < 24 * 60 * 60 * 1000;
}

// ============================================================
// RECEIVING
// ============================================================

export interface InboundMessage {
  phoneNumberId: string; // identifies which tenant this belongs to
  from: string;          // lead's WhatsApp number (digits)
  name: string | null;   // WhatsApp profile name
  text: string;
  waMessageId: string;
}

// Parse a WhatsApp Cloud API inbound webhook. Returns [] for status-only callbacks.
export function parseInboundWhatsApp(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      const contactName = value?.contacts?.[0]?.profile?.name ?? null;
      for (const msg of value?.messages ?? []) {
        if (msg.type !== 'text') continue; // v1: text only (media/interactive later)
        out.push({
          phoneNumberId,
          from: msg.from,
          name: contactName,
          text: msg.text?.body ?? '',
          waMessageId: msg.id,
        });
      }
    }
  }
  return out;
}

// Delivery status callbacks (P0-1). Meta reports what happened to a message
// AFTER the send API accepted it: sent | delivered | read | failed.
export interface StatusEvent {
  phoneNumberId: string;
  waMessageId: string;               // the id returned when we sent the message
  status: string;                    // sent | delivered | read | failed
  recipientId: string | null;
  errors: { code?: number; title?: string; message?: string }[];
}

export function parseStatuses(payload: any): StatusEvent[] {
  const out: StatusEvent[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      for (const s of value?.statuses ?? []) {
        out.push({
          phoneNumberId,
          waMessageId: s.id,
          status: s.status,
          recipientId: s.recipient_id ?? null,
          errors: (s.errors ?? []).map((e: any) => ({
            code: e?.code,
            title: e?.title,
            message: e?.message ?? e?.error_data?.details,
          })),
        });
      }
    }
  }
  return out;
}

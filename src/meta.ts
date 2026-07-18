import { config } from './config';
import { Tenant, NormalizedLead } from './types';
import { normalizePhone } from './phone';

const GRAPH = `https://graph.facebook.com/${config.graphVersion}`;

export interface LeadgenEvent {
  pageId: string;
  leadgenId: string;
  formId: string;
}

// Parse the Meta Lead Ads webhook.
// IMPORTANT: this payload contains only IDs — NOT the field data.
// The actual name/phone/answers must be fetched separately (fetchAndNormalizeLead).
export function parseLeadgenWebhook(payload: any): LeadgenEvent[] {
  const out: LeadgenEvent[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value;
      out.push({ pageId: v.page_id, leadgenId: v.leadgen_id, formId: v.form_id });
    }
  }
  return out;
}

// Fetch the lead's real field data from the Graph API, then normalize to NormalizedLead.
export async function fetchAndNormalizeLead(tenant: Tenant, leadgenId: string): Promise<NormalizedLead | null> {
  if (!tenant.meta_page_token) { console.error('[meta] tenant missing meta_page_token'); return null; }
  try {
    const res = await fetch(`${GRAPH}/${leadgenId}?access_token=${tenant.meta_page_token}`);
    const json: any = await res.json();
    if (!res.ok) { console.error('[meta] fetch lead failed', JSON.stringify(json)); return null; }

    // field_data is [{ name, values: [...] }, ...]
    const fields: Record<string, string> = {};
    for (const f of json.field_data ?? []) fields[f.name] = (f.values ?? [])[0] ?? '';

    const phone = normalizePhone(fields.phone_number || fields.phone || '', tenant.default_country_code);
    if (!phone) { console.error('[meta] lead has no phone', leadgenId); return null; }

    const name =
      fields.full_name ||
      [fields.first_name, fields.last_name].filter(Boolean).join(' ') ||
      null;

    return {
      source: 'meta',
      external_id: leadgenId,
      name,
      phone,
      raw: { field_data: json.field_data, form_id: json.form_id, created_time: json.created_time },
    };
  } catch (e) {
    console.error('[meta] fetch error', e);
    return null;
  }
}

// Phone normalization moved to src/phone.ts (shared with the WhatsApp inbound
// path so Meta leads and replies always resolve to the same lead record).

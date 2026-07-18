/**
 * Add a tenant with tokens encrypted at rest (P2-12).
 *
 * Once ENCRYPTION_KEY is set you can no longer paste plaintext tokens via raw
 * SQL — this CLI encrypts wa_token / meta_page_token before inserting.
 * With ENCRYPTION_KEY unset it inserts plaintext (same as raw SQL).
 *
 * Usage (values as JSON on the command line):
 *   npx tsx scripts/add-tenant.ts '{
 *     "name": "Vivendo Overseas",
 *     "wa_phone_number_id": "1234567890",
 *     "wa_token": "EAA...",
 *     "wa_opening_template": "lead_opener",
 *     "wa_template_lang": "en",
 *     "meta_page_id": "9876543210",
 *     "meta_page_token": "EAA...",
 *     "business_name": "Vivendo Overseas",
 *     "agent_name": "Rahul",
 *     "counsellor_wa": "919999999999",
 *     "default_country_code": "91",
 *     "operator_wa": "918888888888",
 *     "followup_templates": ["lead_followup_1", "lead_followup_2"],
 *     "followup_delays_minutes": [180, 1440],
 *     "counsellor_alert_template": "hot_lead_alert",
 *     "reengagement_template": "lead_reengage"
 *   }'
 *
 * Run with the same .env the server uses (SUPABASE_URL, SUPABASE_SERVICE_KEY,
 * and ENCRYPTION_KEY if enabled), e.g.:  npx tsx --env-file=.env scripts/add-tenant.ts '...'
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config';
import { encrypt, encryptionEnabled } from '../src/crypto';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/add-tenant.ts \'{"name": "...", "wa_phone_number_id": "...", ...}\'');
    process.exit(1);
  }
  if (!config.supabaseUrl || !config.supabaseKey) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set — run with your .env loaded.');
    process.exit(1);
  }

  const row = JSON.parse(arg) as Record<string, unknown>;
  for (const required of ['name', 'wa_phone_number_id', 'wa_token', 'wa_opening_template', 'business_name']) {
    if (!row[required]) {
      console.error(`Missing required field: ${required}`);
      process.exit(1);
    }
  }

  console.log(encryptionEnabled()
    ? '[add-tenant] ENCRYPTION_KEY set — tokens will be encrypted at rest'
    : '[add-tenant] ENCRYPTION_KEY not set — tokens stored plaintext');

  row.wa_token = encrypt(String(row.wa_token));
  if (row.meta_page_token) row.meta_page_token = encrypt(String(row.meta_page_token));

  const supabase = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.from('tenants').insert(row).select('id, name').single();
  if (error) {
    console.error('[add-tenant] insert failed:', error.message);
    process.exit(1);
  }
  console.log(`[add-tenant] created tenant "${data.name}" (${data.id})`);
}

main().catch((e) => { console.error(e); process.exit(1); });

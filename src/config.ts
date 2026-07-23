export const config = {
  port: parseInt(process.env.PORT || '3000', 10),

  // Shared Meta webhook verify token (you choose this string; set it in the Meta dashboard too).
  verifyToken: process.env.META_VERIFY_TOKEN || '',
  // App secret for verifying webhook signatures. If empty, signature checks are skipped (dev only).
  metaAppSecret: process.env.META_APP_SECRET || '',
  graphVersion: process.env.GRAPH_VERSION || 'v21.0',

  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_SERVICE_KEY || '',

  groqKey: process.env.GROQ_API_KEY || '',
  // Free, fast default; swap to llama-3.3-70b-versatile for higher reply quality.
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  // Reasoning-model budget (e.g. openai/gpt-oss-120b): kept low by default since
  // this is a latency-sensitive instant-response product. Validated in brain.ts.
  groqReasoningEffort: process.env.GROQ_REASONING_EFFORT || 'low',

  // Global fallback operator WhatsApp number, used when a tenant has no operator_wa.
  operatorWa: process.env.OPERATOR_WA || '',
  // Secret required to hit GET /stats (?token=...). Endpoint is disabled if unset.
  statsToken: process.env.STATS_TOKEN || '',
  // 32-byte key (64 hex chars or base64) for AES-256-GCM token encryption. If unset, tokens stay plaintext.
  encryptionKey: process.env.ENCRYPTION_KEY || '',

  // Circuit breakers (P2-10). Generous defaults; tune per real volume.
  tenantDailyTemplateCap: parseInt(process.env.TENANT_DAILY_TEMPLATE_CAP || '250', 10),
  claudeCallsPerMinute: parseInt(process.env.CLAUDE_CALLS_PER_MINUTE || '30', 10),
};

export function assertConfig(): void {
  const required: [string, string][] = [
    ['META_VERIFY_TOKEN', config.verifyToken],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_KEY', config.supabaseKey],
    ['GROQ_API_KEY', config.groqKey],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.warn(
      `[config] Missing env vars: ${missing.join(', ')} — server will start but those paths will fail until set.`
    );
  }
  if (!config.operatorWa) {
    console.warn('[config] OPERATOR_WA not set — operator alerts fall back to per-tenant operator_wa only.');
  }
}

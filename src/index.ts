import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { config, assertConfig } from './config';
import * as db from './db';
import { parseLeadgenWebhook, fetchAndNormalizeLead } from './meta';
import { parseInboundWhatsApp, parseStatuses } from './whatsapp';
import { handleNewLead, handleInboundMessage } from './engine';
import { alertOperator } from './operator';
import { startScheduler } from './scheduler';

assertConfig();

const app = express();

// Keep the raw body so we can verify Meta's webhook signature.
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Verify X-Hub-Signature-256. Skipped if META_APP_SECRET is unset (dev only).
function verifySignature(req: Request & { rawBody?: Buffer }): boolean {
  if (!config.metaAppSecret) return true;
  const sig = req.header('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.metaAppSecret).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Webhook verification handshake (GET), shared by both subscriptions ---
function handleVerify(req: Request, res: Response) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

app.get('/webhooks/meta', handleVerify);
app.get('/webhooks/whatsapp', handleVerify);

// --- Meta Lead Ads (POST) ---
app.post('/webhooks/meta', async (req: Request & { rawBody?: Buffer }, res: Response) => {
  res.sendStatus(200); // ack immediately; Meta retries on non-200
  if (!verifySignature(req)) { console.error('[meta] bad signature'); return; }
  try {
    for (const ev of parseLeadgenWebhook(req.body)) {
      const tenant = await db.getTenantByPageId(ev.pageId);
      if (!tenant) { console.error('[meta] no tenant for page', ev.pageId); continue; }
      const normalized = await fetchAndNormalizeLead(tenant, ev.leadgenId);
      if (normalized) {
        await handleNewLead(tenant, normalized);
      } else {
        // Fail safe, never silent: a lead we couldn't fetch is a lead we'd drop.
        await alertOperator(tenant, 'lead_fetch_failed',
          `could not fetch/normalize leadgen ${ev.leadgenId} from Graph API — recover it manually in Ads Manager`);
      }
    }
  } catch (e) {
    console.error('[meta] handler error', e);
  }
});

// --- WhatsApp inbound (POST): messages + delivery statuses ---
app.post('/webhooks/whatsapp', async (req: Request & { rawBody?: Buffer }, res: Response) => {
  res.sendStatus(200);
  if (!verifySignature(req)) { console.error('[wa] bad signature'); return; }
  try {
    for (const m of parseInboundWhatsApp(req.body)) {
      const tenant = await db.getTenantByPhoneNumberId(m.phoneNumberId);
      if (!tenant) { console.error('[wa] no tenant for phone_number_id', m.phoneNumberId); continue; }
      await handleInboundMessage(tenant, m.from, m.text, m.waMessageId, m.name);
    }

    // P0-1: delivery statuses — catches sends the API accepted but Meta later failed.
    for (const s of parseStatuses(req.body)) {
      const lead = await db.findLeadByWaMessageId(s.waMessageId);
      if (!lead) continue; // status for a message we didn't track (e.g. operator alert)
      await db.setDeliveryStatus(lead.id, s.status);
      if (s.status === 'failed') {
        const tenant = await db.getTenantByPhoneNumberId(s.phoneNumberId);
        if (tenant) {
          const detail = s.errors.map((e) => `[${e.code ?? '?'}] ${e.title ?? ''} ${e.message ?? ''}`.trim()).join('; ');
          await alertOperator(tenant, 'delivery_failed',
            `message to ${lead.phone} failed after send: ${detail || 'no error detail'}`, lead.id);
        }
      }
    }
  } catch (e) {
    console.error('[wa] handler error', e);
  }
});

// --- Operator visibility (P2-13). Protected by STATS_TOKEN; not a dashboard. ---
app.get('/stats', async (req: Request, res: Response) => {
  if (!config.statsToken || req.query.token !== config.statsToken) return res.sendStatus(403);
  const tenants = await db.listTenants();
  const stats = await Promise.all(tenants.map((t) => db.statsForTenant(t)));
  const events = await db.recentSystemEvents(50);
  return res.json({ generated_at: new Date().toISOString(), tenants: stats, recent_events: events });
});

app.get('/health', (_req: Request, res: Response) => res.send('ok'));

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  startScheduler(); // P0-2: no-reply follow-ups need the process to stay alive
});

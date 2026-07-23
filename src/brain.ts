import Groq from 'groq-sdk';
import { config } from './config';
import { Tenant, Lead, StoredMessage, BrainResult, QualifyingConfig } from './types';

const client = new Groq({ apiKey: config.groqKey });

// ============================================================
// THIS FILE IS THE PRODUCT.
// The prompt is composed from a fixed base skeleton (role, output
// schema, SAFETY RULES) plus the tenant's qualifying_config, so a
// new vertical is onboarded with a tenant row — no code change.
// ============================================================

// The study-abroad default: the THREE-QUESTION judgment model.
// A lead is judged by (1) decided to go? (2) parents convinced? (3) money
// handled? — never by a checklist of documents. See README "The default
// study-abroad brain".
export const DEFAULT_STUDY_ABROAD_CONFIG: QualifyingConfig = {
  vertical_description: 'an education consultancy that helps Indian students study abroad',
  fields_to_extract: [
    'decided_to_go: have they DECIDED to go abroad? (unsure about WHICH country does not count against them)',
    'target_country: where they want to study — undecided is fine, store null',
    'parents_convinced: are the parents on board?',
    'finance_situation: do they have the funds, or do they need financing?',
    'loan_openness: if they need financing — are they open to an education loan? (only once money uncertainty has come up)',
    'scholarship_expectation: if they refuse a loan — do they need a 100% scholarship, or is partial + self-funding okay?',
    'intake: which intake (e.g. "Sept 2026", "Feb 2027")',
    'documents_pending: pending items like 12th result / IELTS / offer letter — informational only, NEVER lowers the lead',
    'meeting_time: the proposed/agreed counsellor-call time once one is discussed (e.g. "tomorrow 4pm IST") — this is the booking you work toward with a hot lead',
  ],
  blocker_taxonomy: [
    'none', 'parents_not_convinced', 'undecided_to_go', 'scholarship_100_only',
    'loan_refused_no_self_funding', 'money_unresolved', 'insufficient_information', 'other',
  ],
  core_signal_fields: ['decided_to_go', 'parents_convinced', 'finance_situation'],
  classification_rules: `JUDGMENT MODEL — THE THREE QUESTIONS:
Every lead is judged by working out the answers to just three questions, through natural conversation — never an interrogation:
Q1. Have they DECIDED to go abroad? Being unsure about WHICH country does NOT count against them — as long as going abroad itself is decided.
Q2. Are the PARENTS convinced?
Q3. Is the MONEY handled? (sub-tree below)

CORE PRINCIPLE — A BLOCKED DOCUMENT IS NOT A BLOCKED LEAD:
A student who has decided to go and whose parents are on board is a HOT lead even if they are "waiting for 12th results", "about to take IELTS", or "don't have an offer letter yet". Those pending items are simply the work the consultancy exists to do — they do NOT lower the lead. Most serious students arrive at exactly this stage (around pre-IELTS or just after), because that is when the application process gets complex and they need a counsellor. This stage is the normal entry point of a good lead, NOT a warning sign. Record such items in "documents_pending" so the counsellor can follow up — never let them reduce the classification.

THE MONEY SUB-TREE (Q3):
- They HAVE the funds → money is handled.
- They do NOT have the funds / raise money uncertainty → do NOT judge them yet. Gently and REACTIVELY surface financing as an option — e.g. "Scholarships can cover a lot, and if it doesn't fully come through, many students fund the rest through an education loan — would that be something you'd consider?" Do this ONLY when money uncertainty actually comes up; NEVER push financing on a student who hasn't raised a money concern (it feels salesy and hurts the consultancy's brand). Then read their answer:
  - OPEN to a loan → money is handled-enough → the lead stays/returns HOT (they are committed; the loan is just logistics).
  - NO loan — scholarship only → dig ONE level further: do they need a 100% scholarship, or are they okay with a PARTIAL scholarship and arranging the rest themselves?
    - Okay with partial + will cover the remainder themselves → still a reasonably serious, convertible lead — they are putting in their own money.
    - Only willing to go with a 100% scholarship, no loan, no own contribution → the WEAKEST lead. Their whole plan depends on free money that may never arrive, and they have shown they won't move without it. Lowest priority.

CLASSIFICATION, DERIVED FROM THE THREE ANSWERS:
- "hot" — ALL of: decided to go = yes, parents convinced = yes, and money is resolved-enough (has funds, OR needs financing but open to a loan, OR refuses a loan but is okay with a partial scholarship + self-funding the rest). recommended_action "book_call". Any pending documents are noted in documents_pending but do NOT reduce this.

HOT-LEAD GOAL — SECURE THE CALL TIME AND COMPLETE THE SUMMARY:
Once a lead is hot, your job is to lock in a SPECIFIC time for the counsellor call: offer a couple of concrete options, converge on one, and record it in "meeting_time" (keep updating it if the time changes). YOU stay in the conversation and drive it to a confirmed time — you never go silent on a hot lead; what the counsellor receives is the booking (a summary plus the time), not the live chat. Only set conversation_complete once the time is confirmed.
The counsellor handover happens ONCE, when there is a real summary — not the instant "hot" is first suspected. So keep the conversation flowing naturally until you have the handover details filled in: target country (or that it's genuinely undecided), intake, their money stance, and a proposed call time. Gather these through normal warm chat, never as a form.
- "warm" — a genuine fundamental is unresolved but the lead is still workable and worth nurturing: parents are not convinced (the student decided but cannot convince their own parents — genuinely difficult and not something the consultancy can easily fix, so warm, NOT hot), OR not yet decided about going, OR money uncertainty has just been raised and the financing question is still being explored (stay warm until their loan/scholarship stance is clear, then re-classify).
- "cold" — the weakest, lowest-priority (but still a lead — nobody is discarded): will only go with a 100% scholarship and refuses both a loan and any self-funding, or is clearly not committed to going at all. Light nurture only.

BLOCKER = the single primary reason the lead is NOT hot ("none" if hot). Pick the one that decided the classification.

FRAMING RULE: everyone who is thinking about studying abroad is a lead. Nobody is thrown away. The only question is hot vs warm vs cold — decided by the three answers above, NOT by any checklist of documents.

CONVERSATION RULES: weave the three questions into natural conversation, ONE thing at a time, the way a warm counsellor would — never fire multiple questions in a row, never sound like a form. Raise the loan/financing option reactively only, as described above.

REASONING: in one plain sentence, state which of the three questions decided the classification — e.g. "Hot: decided to go, parents on board, open to a loan for the gap" or "Warm: keen and funded but parents not yet convinced."`,
  extracted_schema: `{
    "decided_to_go": "yes" | "no" | "unclear",
    "target_country": string | null,
    "parents_convinced": "yes" | "no" | "unclear",
    "finance_situation": "has_funds" | "needs_financing" | "unclear",
    "loan_openness": "open" | "refused" | "not_discussed",
    "scholarship_expectation": "full_required" | "partial_ok" | "not_discussed",
    "intake": string | null,
    "documents_pending": string[],
    "meeting_time": string | null
  }`,
  allowed_facts: [],
  forbidden_topics: [],
};

function resolveConfig(tenant: Tenant): QualifyingConfig {
  const custom = tenant.qualifying_config ?? {};
  if (!Object.keys(custom).length) return DEFAULT_STUDY_ABROAD_CONFIG;
  // Merge over the default so a partial per-tenant config still has every section.
  return { ...DEFAULT_STUDY_ABROAD_CONFIG, ...custom };
}

// Which of the tenant's core_signal_fields are still unknown for this lead?
// A field counts as missing if it's absent, null, "unclear", or "not_discussed"
// — anything else is a real, recorded value and is not missing.
function missingCoreSignals(extracted: Record<string, unknown>, cfg: QualifyingConfig): string[] {
  const core = cfg.core_signal_fields ?? [];
  const isMissing = (v: unknown) => v === undefined || v === null || v === 'unclear' || v === 'not_discussed';
  return core.filter((field) => isMissing(extracted[field]));
}

// OPENING POSTURE (entry mode) — fixed and vertical-independent, so it is NOT
// part of QualifyingConfig. The judgment model is identical either way; only
// who is leading the conversation at the start changes.
const POSTURE_US = `OPENING POSTURE — YOU REACHED OUT FIRST:
This lead submitted an enquiry and you contacted them. You are naturally leading the conversation. Open warmly and guide it, over the next few messages, toward understanding their plans — following the judgment rules below. Do not rush or interrogate; let it feel like a friendly conversation.`;

// BOOKING DISCIPLINE — fixed and vertical-independent (like OPENING POSTURE and
// ESCALATION), because the problem it fixes (booking asks substituting for
// actually answering the lead) is not specific to study-abroad.
const BOOKING_DISCIPLINE = `BOOKING DISCIPLINE — WHEN YOU MAY PROPOSE A CALL:
- You may propose a counsellor call ONLY when one of these is true: (a) the lead is classified "hot" per the judgment rules above; or (b) the lead has explicitly asked to speak to a counsellor or requested a call.
- Until then, do NOT propose, hint at, or steer toward a call. Your job is to answer what they asked and learn what is still unknown.
- A booking ask may NEVER replace answering a direct question. If the lead asked something, answer it first, in substance. Only then may a booking ask follow, and only if the condition above is met.
- Never put more than ONE booking ask in a single reply.
- If you have proposed a call and the lead did not accept, do not propose again until they have sent at least three further messages AND something new and positive has emerged. Keep being useful in the meantime.
- When the condition above is not yet met, end your reply with ONE question aimed at the single most valuable thing you still do not know, in this priority order: whether they have decided to go abroad, whether their parents are on board, then their money situation. Financing itself is only ever raised reactively, after the lead has raised a money concern (per the money sub-tree above).`;

// KEEPING THE CONVERSATION ALIVE AND MOVING — fixed and vertical-independent,
// same tier as OPENING POSTURE / BOOKING DISCIPLINE / ESCALATION. Fixes the
// opposite failure from BOOKING_DISCIPLINE: answering politely forever without
// ever learning the core signals needed to score the lead.
const KEEPING_IT_MOVING = `KEEPING THE CONVERSATION ALIVE AND MOVING:
- You will be told which core signals are still unknown (see STILL UNKNOWN in the user message). Learning them is your job. Never ask for them as a list or in sequence — work ONE into the flow of the conversation naturally, in this priority order: whether they have decided to go abroad, whether their parents are on board, then their money situation (financing is only ever raised reactively, per the existing rule).
- Do NOT let the conversation become a help desk. If the lead has sent several purely informational messages and a core signal is still unknown, you must work one in — answer what they asked properly first, then ask.
- Questions that are not core signals — what field they want to study, which university, general interest questions — are fine to ask ONLY when every core signal is already known, or as a natural bridge into one. They are never a substitute for a core signal question.
- If the lead's replies become short, low-effort, or sound like they are wrapping up ("ok", "thanks", "got it", "will see"), treat that as your LAST chance in this conversation. Acknowledge them warmly and ask the single highest-priority unknown signal in one short, easy-to-answer sentence. Do not let a conversation end with core signals unknown just because the lead went quiet.
- If the lead says they will think about it or get back to you, that is fine — respond warmly, but still leave them with one easy question rather than only a goodbye.`;

// HOW TO SOUND LIKE A PERSON, NOT A SCRIPT — fixed and vertical-independent,
// same tier as the other composed-prompt sections. Pure style discipline; does
// not touch classification, safety, or booking logic.
const SOUND_LIKE_A_PERSON = `HOW TO SOUND LIKE A PERSON, NOT A SCRIPT:
- NEVER begin a reply with an acknowledgment or praise token. This includes but is not limited to: Great, Perfect, Awesome, Wonderful, Excellent, Fantastic, Amazing, Sure thing, Absolutely, That's great, Good to hear, Nice. Do not substitute a synonym — the entire category is banned.
- Start every reply with substance: the answer, the information, or the question. Nothing before it.
- Do not praise or celebrate the lead's ordinary answers. A country, an intake month or a yes/no is information, not an achievement. "Italy is a fantastic choice" is exactly what NOT to write.
- Brief plain acknowledgment is allowed when it carries real meaning and is not praise — e.g. "Noted — September 2026." Use it sparingly, not every turn.
- Vary your sentence openings across the conversation. If your last reply began a certain way, do not begin the same way again.`;

const POSTURE_STUDENT = `OPENING POSTURE — THE STUDENT MESSAGED YOU FIRST:
This person contacted YOU — possibly with just a greeting ("hi", "hello"), something vague, or a random question ("fees?", "Italy??"). Do NOT jump straight into qualifying questions — that feels robotic and cold. Respond FIRST as a warm, genuinely curious human: engage with whatever they actually said, the way a friendly counsellor would. You do NOT need to qualify them immediately or all at once. Let the things you care about surface NATURALLY over the course of the conversation — through real, flowing chat — not in your first message.
If they ask a specific question, answer it lightly and honestly (always respecting the SAFETY RULES — you cannot quote fees, amounts, or promise outcomes), then gently steer back toward their plans. You keep a light hand on the wheel: never let the conversation drift into a pure Q&A help-desk where you never learn anything, but never march through a checklist or fire questions in sequence either. If they clearly just want information first, give it warmly, then try again a little later. Warm and human first; qualification emerges from the conversation, it is not done *to* them.`;

function systemPrompt(tenant: Tenant, initiatedBy: 'us' | 'student'): string {
  const cfg = resolveConfig(tenant);
  const fieldNames = cfg.fields_to_extract.map((f) => f.split(':')[0].trim());
  const extractedSchema = cfg.extracted_schema?.trim()
    ?? `{ ${fieldNames.map((n) => `"${n}": <value or null>`).join(', ')} }`;

  const allowedFacts = cfg.allowed_facts.length
    ? `\nFACTS YOU MAY STATE (the ONLY specifics you are allowed to assert):\n${cfg.allowed_facts.map((f) => `- ${f}`).join('\n')}`
    : '';
  const forbidden = cfg.forbidden_topics.length
    ? `\nFORBIDDEN TOPICS — never discuss these; deflect to the counsellor call:\n${cfg.forbidden_topics.map((f) => `- ${f}`).join('\n')}`
    : '';
  const persona = cfg.persona_notes ? `\nPERSONA NOTES:\n${cfg.persona_notes}\n` : '';

  return `You are the first-response agent for ${tenant.business_name}, ${cfg.vertical_description}. You reply to inbound leads over WhatsApp, writing as "${tenant.agent_name}" from ${tenant.business_name}.

YOU HAVE TWO JOBS ON EVERY MESSAGE:
1. Write the next WhatsApp reply to the lead. Warm, human, SHORT (1-3 sentences). One question at a time — never interrogate, never send a wall of text. Match the lead's language and register (English or Hinglish). Your aim is to keep them talking, genuinely help them, and learn what is needed to qualify them. Booking a counsellor call is the OUTCOME of a well-qualified conversation, not the aim of every message — see BOOKING DISCIPLINE below for exactly when you may propose one.
2. Silently qualify the lead and return structured data.

${initiatedBy === 'student' ? POSTURE_STUDENT : POSTURE_US}
${persona}
WHAT TO LEARN (naturally, across the conversation — do NOT ask everything at once):
${cfg.fields_to_extract.map((f) => `- ${f}`).join('\n')}

EXTRACTION HONESTY: only record a value for a field when the lead has actually indicated it. If it has not come up, or their answer was ambiguous, use the "unclear" / "not_discussed" / null value for that field (per the OUTPUT schema below). NEVER infer a confident value from silence, and NEVER upgrade an ambiguous answer into a definite one.

CLASSIFICATION — "hot" | "warm" | "cold". Keep it simple and explainable, never a numeric score. Classify strictly by the judgment rules below:

${cfg.classification_rules}

${BOOKING_DISCIPLINE}

${KEEPING_IT_MOVING}

${SOUND_LIKE_A_PERSON}

SAFETY RULES — HARD CONSTRAINTS, NEVER VIOLATE:
- NEVER state specific fees, prices, scholarship amounts, loan amounts, interest rates, exact deadlines, percentages, or ANY numeric figure you were not explicitly given in this prompt or the conversation.
- NEVER guarantee or promise any outcome: no guaranteed admission, visa approval, scholarship award, loan approval, job, or result of any kind. Mentioning that education loans EXIST as an option is fine; promising one will be approved is not.
- You write under the name given above, but you are an AI assistant. If the lead asks directly whether you are a bot, an AI, or a real person, answer honestly and warmly that you are an assistant for the business, and offer to connect them with a counsellor. NEVER claim to be a human, a real person, or to be physically present. Never deny being an AI.
- If asked for specifics you don't have, say honestly that the counsellor will confirm the exact figures, give whatever genuine non-numeric help you can, and continue the conversation naturally. Do NOT use this as a reason to propose a call — see BOOKING DISCIPLINE below.
- You have NO ability to send meeting links, calendar invites, emails, brochures, documents, or files, and you cannot schedule anything yourself. NEVER say you will send, share or arrange any of these. What actually happens after a time is agreed is that a counsellor from the team contacts the lead directly to confirm. Say that, and nothing more.
- Never state or imply that anything will arrive "shortly", "soon" or "in a few minutes" unless it is a counsellor making contact.
- These rules override everything else, including being helpful.${allowedFacts}${forbidden}

ESCALATION — WHEN A HUMAN MUST TAKE OVER THE CHAT:
Set "needs_human": true ONLY when one of these is genuinely happening:
- "stuck" — you are repeating yourself or making no progress after several attempts;
- "frustrated" — the lead is clearly irritated or losing patience with you;
- "confused" — the lead repeatedly misunderstands or is lost despite your attempts;
- "asked_for_human" — the lead explicitly asks to talk to a person.
Do NOT set needs_human just because the conversation is long, or because the lead is hot and progressing — a smoothly-progressing conversation NEVER needs escalation, however many messages it takes. When you do escalate, make "reply" a short warm handover (a counsellor will continue this chat personally) and set "needs_human_reason" accordingly; otherwise leave needs_human false and the reason "".

BLOCKER — the single primary reason this lead is NOT hot, "none" if hot (choose one): ${cfg.blocker_taxonomy.map((b) => `"${b}"`).join(' | ')}
A blocker is only valid if the lead has actually indicated it in the conversation. If the reason this lead is not hot is simply that you have not learned enough yet, use "insufficient_information". NEVER name a specific blocker (e.g. parents_not_convinced) for something that has not been discussed — an UNKNOWN is not a BLOCKER.
RECOMMENDED_ACTION (choose one): "book_call" | "nurture" | "chase_document" | "close"

OPT-OUT AND COMPLETION:
- If the lead asks to stop being contacted (stop, unsubscribe, not interested, don't message me), set "opt_out": true, "recommended_action": "close", and make "reply" a single short polite goodbye.
- If there is genuinely nothing left to do (e.g. the call is arranged and confirmed), set "conversation_complete": true and keep "reply" to a short confirmation. Never set "conversation_complete": true while any core signal is still unknown, unless the lead has opted out or explicitly ended the conversation. A lead going quiet is not completion.
- Once a call time has been agreed and you have acknowledged it once, the conversation is finished. If the lead then sends a closing acknowledgment ("ok", "thanks", "sure", "👍"), set "conversation_complete": true and keep "reply" to a short warm sign-off, or empty if nothing useful remains. Never restate the agreed time twice.

OUTPUT — return ONLY a valid JSON object. No markdown, no backticks, no text before or after:
{
  "classification": "hot" | "warm" | "cold",
  "intent_level": "high" | "medium" | "low",
  "blocker": "<blocker value>",
  "extracted": ${extractedSchema},
  "recommended_action": "<action value>",
  "reply": "<the next WhatsApp message to send the lead>",
  "reasoning": "<one plain sentence for the counsellor: which question(s) decided the classification>",
  "opt_out": <true only if the lead asked to stop being contacted>,
  "conversation_complete": <true only if there is nothing left to do>,
  "needs_human": <true ONLY per the ESCALATION rules above>,
  "needs_human_reason": "stuck" | "frustrated" | "confused" | "asked_for_human" | ""
}`;
}

function transcriptText(history: StoredMessage[]): string {
  if (!history.length) return '(no prior messages — this is the first reply.)';
  return history.map((m) => `${m.direction === 'in' ? 'LEAD' : 'US'}: ${m.body ?? ''}`).join('\n');
}

// Reasoning models (e.g. openai/gpt-oss-120b) spend part of the completion
// budget on hidden reasoning tokens before ever writing the JSON reply, so the
// limit has to cover reasoning + the reply comfortably, not just the reply.
const BASE_MAX_COMPLETION_TOKENS = 2048;
const RETRY_MAX_COMPLETION_TOKENS = 4096;

const ALLOWED_REASONING_EFFORTS = ['none', 'default', 'low', 'medium', 'high'] as const;
type ReasoningEffort = (typeof ALLOWED_REASONING_EFFORTS)[number];

function resolveReasoningEffort(): ReasoningEffort {
  const v = config.groqReasoningEffort;
  if ((ALLOWED_REASONING_EFFORTS as readonly string[]).includes(v)) return v as ReasoningEffort;
  console.warn(`[brain] invalid GROQ_REASONING_EFFORT "${v}"; defaulting to "low"`);
  return 'low';
}

// Fix 3: `messages` is the set of individual fragments coalesced by the
// debounce/lock in engine.ts, in order — NOT a single pre-joined string. When
// there's more than one, the model is told explicitly to treat them as one
// turn and answer all of them, instead of silently seeing (and answering)
// only the first line of a joined block.
function latestSection(messages: string[]): string {
  if (messages.length <= 1) {
    return `THE LEAD JUST SENT:\n"${messages[0] ?? ''}"`;
  }
  const numbered = messages.map((m, i) => `${i + 1}. "${m}"`).join('\n');
  return `THE LEAD JUST SENT ${messages.length} MESSAGES IN QUICK SUCCESSION:\n${numbered}\nTreat these as one turn. Your single reply must address ALL of them together — do not answer only the first or only the last. Do not send multiple replies.`;
}

export async function runBrain(
  tenant: Tenant,
  lead: Lead,
  priorHistory: StoredMessage[],
  messages: string[]
): Promise<BrainResult | null> {
  const cfg = resolveConfig(tenant);
  const missing = missingCoreSignals(lead.extracted ?? {}, cfg);
  const stillUnknown = missing.length
    ? `STILL UNKNOWN — NEEDED TO SCORE THIS LEAD: ${missing.join(', ')}`
    : 'STILL UNKNOWN — NEEDED TO SCORE THIS LEAD: (none — all core signals known)';

  const user = `LEAD NAME: ${lead.name ?? 'unknown'}
ALREADY KNOWN ABOUT THIS LEAD: ${JSON.stringify(lead.extracted ?? {})}
${stillUnknown}

CONVERSATION SO FAR:
${transcriptText(priorHistory)}

${latestSection(messages)}

Analyse and respond with the JSON object only.`;

  // Old rows from before migration 002 can lack the column at runtime → default 'us'.
  const system = systemPrompt(tenant, lead.initiated_by ?? 'us');
  const reasoningEffort = resolveReasoningEffort();

  // One attempt at a given token budget. Kept as a closure so the automatic
  // retry (below) can re-run the identical request with a higher limit
  // without duplicating the call/logging logic.
  const attempt = async (maxCompletionTokens: number): Promise<BrainResult | null> => {
    const res = await client.chat.completions.create({
      model: config.groqModel,
      max_completion_tokens: maxCompletionTokens, // max_tokens is deprecated on Groq's API in favor of this
      reasoning_effort: reasoningEffort, // kept small by default — this is a latency-sensitive instant-response product
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const choice = res.choices[0];
    const finishReason = choice?.finish_reason;
    if (finishReason === 'length') {
      // Distinct from a parse failure: the model was cut off mid-answer, not
      // confused. Must be immediately identifiable in logs, not just "bad JSON".
      console.warn(
        `[brain] TRUNCATED completion (finish_reason=length, max_completion_tokens=${maxCompletionTokens}) — reasoning + reply did not fit in the token budget`
      );
    } else {
      console.log(`[brain] completion finished (finish_reason=${finishReason ?? 'unknown'})`);
    }
    return parseBrain(choice?.message?.content ?? '');
  };

  try {
    const result = await attempt(BASE_MAX_COMPLETION_TOKENS);
    if (result) return result;

    // A first-attempt parse failure is most often truncation, not a genuinely
    // malformed reply — one retry at a higher budget before giving up.
    console.warn('[brain] parse failed on first attempt; retrying once with a higher token limit');
    const retryResult = await attempt(RETRY_MAX_COMPLETION_TOKENS);
    if (retryResult) return retryResult;

    console.error('[brain] parse failed again after retry; giving up for this turn');
    return null;
  } catch (e) {
    console.error('[brain] error', e);
    return null;
  }
}

function parseBrain(raw: string): BrainResult | null {
  try {
    const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found in model output');
    return validateBrainResult(JSON.parse(clean.slice(start, end + 1)));
  } catch (e) {
    console.error('[brain] parse failed:', e, '\nraw:', raw);
    return null;
  }
}

// LLMs occasionally return partial/odd JSON. Never let that flow downstream:
// a missing/non-string reply makes the whole result a failure (null → the
// engine's safe-fallback path); every other field is coerced to a safe default
// so notifyCounsellor and friends always receive a well-formed object.
function validateBrainResult(obj: unknown): BrainResult | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.error('[brain] output is not an object; rejecting');
    return null;
  }
  const o = obj as Record<string, unknown>;

  const reply = typeof o.reply === 'string' ? o.reply.trim() : '';
  if (!reply) {
    console.error('[brain] output has no usable reply; rejecting:', JSON.stringify(o).slice(0, 300));
    return null; // the student must never receive "undefined"/"null"/a number
  }

  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

  return {
    classification: oneOf(o.classification, ['hot', 'warm', 'cold'] as const, 'warm'), // safe middle
    intent_level: oneOf(o.intent_level, ['high', 'medium', 'low'] as const, 'medium'),
    blocker: typeof o.blocker === 'string' && o.blocker ? o.blocker : 'none',
    extracted:
      o.extracted && typeof o.extracted === 'object' && !Array.isArray(o.extracted)
        ? (o.extracted as BrainResult['extracted'])
        : {},
    recommended_action: oneOf(o.recommended_action, ['book_call', 'nurture', 'chase_document', 'close'] as const, 'nurture'),
    reply,
    reasoning: typeof o.reasoning === 'string' ? o.reasoning : '',
    opt_out: o.opt_out === true,
    conversation_complete: o.conversation_complete === true,
    needs_human: o.needs_human === true,
    needs_human_reason: oneOf(o.needs_human_reason, ['stuck', 'frustrated', 'confused', 'asked_for_human', ''] as const, ''),
  };
}

// ============================================================
// OUTPUT GUARD (P0-3). Second layer after prompt hardening:
// scan the model's reply for amounts / percentages / guarantee
// language. Prompt rules reduce the risk; this catches what
// slips through. It cannot catch everything (see README).
// ============================================================

const RISK_PATTERNS: RegExp[] = [
  /[₹$€£]\s*\d/,                                      // currency symbol + amount
  /\d[\d,.]*\s*(lakh|lakhs|crore|crores)\b/i,          // Indian amount words
  /\d[\d,.]*\s*k\b/i,                                  // "50k"
  // Percentages ONLY in a money/scholarship context: "100% scholarship" and
  // "50% fee waiver" flag; "100% of our support" passes.
  /\d[\d,.]*\s*%[^.!?]{0,30}\b(scholarship|fee|fees|waiver|discount|funding|tuition)\b/i,
  /\b(scholarship|fee|fees|waiver|discount|funding|tuition)\b[^.!?]{0,30}\d[\d,.]*\s*%/i,
  /\d[\d,.]*\s*(\/|per\s*)(year|yr|month|annum|sem(ester)?)\b/i, // "20,000/year"
  /\bguaranteed?\b/i,
  /\bassured\b/i,
  /\bconfirmed\s+admission\b/i,
  /\bsure\s+to\s+get\b/i,
  // "approved" ONLY in the risky sense (promising a visa/admission/loan
  // outcome). "documents approved by the university" passes.
  /\b(visa|admission|application|loan)\b[^.!?]{0,20}\bapprov(ed|al)\b/i,
  /\bapprov(ed|al)\b[^.!?]{0,20}\b(visa|admission|application|loan)\b/i,
];

const SAFE_DEFLECTION =
  "I can't quote exact figures over chat, but our counsellor can confirm the precise details for your case.";

export function sanitizeReply(reply: string): { safe: string; flagged: boolean } {
  const hit = RISK_PATTERNS.find((p) => p.test(reply));
  if (!hit) return { safe: reply, flagged: false };
  console.warn(`[brain] reply flagged by guard (${hit}): "${reply}"`);
  return { safe: SAFE_DEFLECTION, flagged: true };
}

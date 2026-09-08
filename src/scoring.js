import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

const nlp = winkNLP(model);
const its = nlp.its;

// Ordered longest first so the longer phrase is credited when both match,
// rather than the shorter one being counted inside it.
const FILLER = [
  'i was wondering if you could', 'the reason i am asking is that',
  'i hope you are doing well', 'i would really appreciate',
  "i'd really appreciate it if", 'do you think you could',
  'would it be possible to', 'could you please help me',
  'can you please help me', 'i really appreciate it',
  'i would like you to', 'i hope you can help',
  "if you don't mind", 'just wanted to ask',
  'could you please', 'can you please', 'would you please',
  'please provide me', 'please give me', 'please could you',
  'thanks in advance', 'i am wondering', 'i was hoping'
];

const SAFE_ANYWHERE = [
  'please', 'basically', 'actually', 'really', 'just', 'kind of',
  'sort of', 'you know', 'i mean', 'literally', 'simply', 'somehow',
  'perhaps', 'maybe', 'possibly'
];

const POLITE = [
  'i would really appreciate', 'please', 'thank you', 'thanks', 'i hope',
  "if you don't mind", 'i was wondering', 'i was hoping', 'kindly'
];

// Words meaning roughly the same thing. Two from one group inside a single
// and/or run is padding, not specification.
const SYNONYM_GROUPS = [
  ['options', 'alternatives', 'choices', 'possibilities'],
  ['thoughts', 'ideas', 'suggestions', 'opinions', 'views', 'input'],
  ['plan', 'strategy', 'approach', 'roadmap', 'method'],
  ['guidance', 'advice', 'direction', 'pointers', 'tips'],
  ['issues', 'problems', 'concerns', 'difficulties', 'challenges'],
  ['various', 'different', 'several', 'multiple', 'assorted'],
  ['assistance', 'help', 'support'],
  ['detailed', 'thorough', 'comprehensive', 'exhaustive'],
  ['quick', 'fast', 'rapid', 'speedy'],
  ['important', 'significant', 'crucial', 'critical'],
  ['improve', 'enhance', 'optimise', 'optimize'],
  ['create', 'build', 'construct', 'generate'],
  ['explain', 'describe', 'clarify', 'elaborate'],
  ['understand', 'grasp', 'comprehend'],
  ['summary', 'overview', 'synopsis'],
  ['errors', 'mistakes', 'bugs', 'faults', 'defects'],
  ['benefits', 'advantages', 'upsides'],
  ['drawbacks', 'disadvantages', 'downsides'],
  ['examples', 'samples', 'instances', 'illustrations'],
  ['steps', 'stages', 'phases']
];

const SYN_INDEX = new Map();
SYNONYM_GROUPS.forEach((group, i) => {
  for (const w of group) SYN_INDEX.set(w, i);
});

// Declared before CONSTRAINT_RE so the two cannot drift apart
const EXPANSION_RE = /\b(in depth|in detail|comprehensive|exhaustive|thorough|elaborate|detailed)\b/i;

const CONSTRAINT_RE = [
  /\b\d+\s*(words?|sentences?|paragraphs?|bullets?|points?|items?|lines?|pages?)\b/i,
  /\b(under|max|maximum|no more than|at most|within|about|around|roughly)\s+\d+/i,
  /\b(keep it|make it)\s+(short|brief|concise|detailed|thorough)\b/i,
  EXPANSION_RE,
  /\b(as|in|use|using|format(ted)?\s+as|give me|provide|return|present|answer\s+(in|as|with))\s+(an?\s+)?(table|bullet|list|json|csv|markdown|yaml|outline)\b/i,
  /\b(bullet points?|step by step|numbered list|point form)\b/i,
  /\b(briefly|concisely|summarise|summarize|tl;dr)\b/i,
  /\b(keep|make)\s+(it|this|your answer)\s+(short|brief|concise)\b/i,
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|single|a few|several)\s+(sentences?|paragraphs?|lines?|words?|bullets?|points?)\b/i
];

const SPEC_MARKERS = [
  'max ', 'no more than', 'within', 'exactly', 'at least', 'format',
  'cover', 'include', 'assume', 'ordered by', 'each', 'per ',
  'with ', 'using', 'based on'
];

// Tasks where a numbered structure bounds output better than a word count.
// Measured: "four bullet points" gave -68% on a planning prompt, the best
// single result in that comparison.
const ENUMERATIVE_RE = /\b(plan|planning|roadmap|steps?|stages?|phases?|order|sequence|checklist|options?|ideas?|ways?|approaches?|recommendations?|tips?)\b/i;

// 30 was too high — "explain cloud computing" is six tokens and produced a
// 1,015-word answer unbounded, which is exactly the case worth catching.
// 12 catches short conceptual prompts without scoring fragments mid-typing.
const MIN_TOKENS = 12;
const FILLER_W = 2.2;
const FORMAT_PEN = 18;
const DENSITY_SOFT = 6.0;
const DENSITY_HARD = 18.0;
const DENSITY_CAP = 22;
const SYN_W = 4;
const SYN_CAP = 12;

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Requires the and/or pattern, so a word repeated across separate sentences
// never fires. Requires two words from one group, so a list of distinct
// criteria never fires.
function synonymRuns(text) {
  const runs = text.toLowerCase().match(/\b[a-z]{4,}(?:\s+(?:and|or)\s+[a-z]{4,})+/g) || [];
  const found = [];

  for (const run of runs) {
    const words = run.split(/\s+(?:and|or)\s+/);
    const seen = new Map();
    for (const w of words) {
      const g = SYN_INDEX.get(w);
      if (g === undefined) continue;
      if (seen.has(g)) { found.push(`${seen.get(g)}/${w}`); break; }
      seen.set(g, w);
    }
  }
  return found;
}

// Counts each region of filler once. Without this, "could you please help me"
// would be counted twice, since "could you please" also matches inside it.
function fillerCharsIn(lower) {
  const claimed = [];
  let total = 0;

  for (const phrase of FILLER) {
    let from = 0;
    for (; ;) {
      const at = lower.indexOf(phrase, from);
      if (at === -1) break;
      const end = at + phrase.length;
      const overlaps = claimed.some(([s, e]) => at < e && end > s);
      if (!overlaps) {
        claimed.push([at, end]);
        total += phrase.length;
      }
      from = at + 1;
    }
  }
  return total;
}

export function scorePrompt(text, divisor = 4.25) {
  const raw = (text || '').replace(/\s+/g, ' ').trim();
  const tokens = Math.ceil(raw.length / divisor);
  if (tokens < MIN_TOKENS) return { tokens, scored: false };

  const lower = raw.toLowerCase();
  const issues = [];
  let penalty = 0;

  // 1. Filler phrases
  const fillerChars = fillerCharsIn(lower);
  if (fillerChars > 0) {
    penalty += Math.ceil(fillerChars / divisor) * FILLER_W;
    issues.push('Filler phrases');
  }

  // 2. Politeness density
  const politeCount = POLITE.reduce((n, p) => n + (lower.split(p).length - 1), 0);
  if (politeCount >= 3) {
    penalty += Math.min(15, (politeCount - 2) * 1.5);
    issues.push('Over-polite');
  }

  // 3. Output constraint — measured as the driver of response length
  const hasFormat = CONSTRAINT_RE.some(re => re.test(raw));
  if (!hasFormat) {
    penalty += FORMAT_PEN;
    issues.push('No output constraint');
  }

  // 4. Intent density — grammatical signals via wink, inputs capped so
  //    padding cannot inflate apparent intent
  const doc = nlp.readDoc(raw);
  const pos = doc.tokens().out(its.pos);

  let verbObj = 0;
  for (let i = 0; i < pos.length - 1; i++) {
    if (pos[i] === 'VERB' && (pos[i + 1] === 'NOUN' || pos[i + 1] === 'PROPN' || pos[i + 1] === 'DET')) {
      verbObj++;
    }
  }
  const taskVerbs = Math.min(6, verbObj);

  let interrogative = 0;
  doc.sentences().each((s) => {
    const st = s.out().toLowerCase();
    if (/\?/.test(st) || /\b(what|which|how|why|whether|should|could|would|is it|can you|do you)\b/.test(st)) {
      interrogative++;
    }
  });

  const spec = Math.min(6, SPEC_MARKERS.filter(m => lower.includes(m)).length);
  const commas = Math.min(6, (raw.match(/[,;]/g) || []).length);

  const intent = taskVerbs * 1.5 + interrogative * 1.5 + spec
    + commas * 0.4 + (hasFormat ? 1.5 : 0);

  const density = tokens / Math.max(1, intent);

  if (density > DENSITY_SOFT) {
    const frac = Math.min(1, (density - DENSITY_SOFT) / (DENSITY_HARD - DENSITY_SOFT));
    let dp = DENSITY_CAP * frac;
    if (density > 24) dp += Math.min(18, (density - 24) * 0.7);
    penalty += dp;
    if (frac > 0.45) issues.push('Verbose for the ask');
  }

  // 5. Redundant synonyms
  const redundant = synonymRuns(raw);
  if (redundant.length > 0) {
    penalty += Math.min(SYN_CAP, redundant.length * SYN_W);
    issues.push('Redundant synonyms');
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  return {
    tokens, scored: true, score, issues, hasFormat, redundant,
    intent: Math.round(intent * 10) / 10,
    density: Math.round(density * 10) / 10
  };
}

export function localRewrite(text, divisor = 4.25) {
  let out = (text || '').replace(/\s+/g, ' ').trim();
  const removed = [];

  // Sentence-initial filler phrases only. Mid-sentence removal would leave
  // broken grammar, so those cases are left alone.
  for (const phrase of FILLER) {
    const re = new RegExp('(^|[.!?]\\s+)' + esc(phrase) + '\\s*', 'gi');
    if (re.test(out)) {
      out = out.replace(re, '$1');
      removed.push(phrase);
    }
  }

  // Words with no grammatical role. Replace with a space, not nothing,
  // or adjacent words fuse together.
  for (const w of SAFE_ANYWHERE) {
    const re = new RegExp('(^|\\s+)' + esc(w) + '\\b', 'gi');
    if (re.test(out)) {
      out = out.replace(re, ' ');
      removed.push(w);
    }
  }

  out = out.replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  out = out.charAt(0).toUpperCase() + out.slice(1);

  const before = Math.ceil((text || '').trim().length / divisor);
  const after = Math.ceil(out.length / divisor);

  return { text: out, removed, before, after, changed: out !== (text || '').trim() };
}

// Measured: a bare word bound cut total consumption 32-58% across five
// prompts, mean -46%. A fixed 300 was too small for a heavily specified
// prompt and impossible for a creative brief, so the bound scales with
// the intent the engine computes.
export function suggestConstraint(text, divisor = 4.25, intent = null) {
  const raw = (text || '').replace(/\s+/g, ' ').trim();

  if (CONSTRAINT_RE.some(re => re.test(raw))) {
    return { applicable: false, reason: 'Constraint already present' };
  }

  // Depth explicitly requested — bound generously rather than not at all,
  // since an unbounded response is where consumption runs away
  if (EXPANSION_RE.test(raw)) {
    const suffix = ' Keep the response under 1500 words.';
    return {
      applicable: true, text: raw + suffix, added: suffix.trim(),
      basis: 'depth requested', costTokens: Math.ceil(suffix.length / divisor)
    };
  }

  const i = intent === null ? 5 : intent;

  // Planning and enumeration bound better with a count than a word limit
  if (ENUMERATIVE_RE.test(raw)) {
    const n = i < 4 ? 4 : i < 10 ? 5 : 6;
    const suffix = ` Answer as ${n} bullet points.`;
    return {
      applicable: true, text: raw + suffix, added: suffix.trim(),
      basis: 'enumerative task', costTokens: Math.ceil(suffix.length / divisor)
    };
  }

  const bound = i < 4 ? 250 : i < 8 ? 400 : i < 14 ? 700 : 1200;
  const suffix = ` Answer in under ${bound} words.`;
  return {
    applicable: true, text: raw + suffix, added: suffix.trim(),
    basis: 'scaled word bound', costTokens: Math.ceil(suffix.length / divisor)
  };
}

export function optimise(text, divisor = 4.25) {
  const original = (text || '').replace(/\s+/g, ' ').trim();
  const actions = [];

  const r = localRewrite(original, divisor);
  let out = r.text;
  if (r.changed) {
    const phrases = r.removed.filter(x => x.includes(' ')).length;
    const words = r.removed.length - phrases;
    if (phrases) actions.push(`removed ${phrases} filler phrase${phrases > 1 ? 's' : ''}`);
    if (words) actions.push(`removed ${words} padding word${words > 1 ? 's' : ''}`);
  }

  const scored = scorePrompt(out, divisor);
  const c = suggestConstraint(out, divisor, scored.scored ? scored.intent : null);
  if (c.applicable) {
    out = c.text;
    actions.push(`added "${c.added}"`);
  }

  const before = Math.ceil(original.length / divisor);
  const after = Math.ceil(out.length / divisor);

  return {
    text: out, actions, before, after,
    changed: out !== original,
    constraintAdded: c.applicable,
    basis: c.basis || null,
    skipReason: c.applicable ? null : c.reason
  };
}

/* ---------------------------------------------------------------------------
   Model routing

   Measured: the same six-token prompt cost 480 tokens on a full model
   (mean of four runs, 467 of them thinking) and 13 tokens on a lite model,
   which reported no thinking at all. A 37x difference for an identical
   visible answer.

   Two principles, both learned from testing:

   1. Length does not indicate difficulty. "Explain cloud computing" is six
      tokens and needs a substantive answer. An earlier version routed on
      token count and misrouted five of ten conceptual prompts.

   2. Default up, downgrade only on positive evidence of triviality. A hard
      prompt sent to the cheap model produces a poor answer and the user
      re-prompts, costing more than was saved. An easy prompt sent to the
      full model merely wastes some thinking. The errors are not symmetric.
--------------------------------------------------------------------------- */

// Used only if the model list is empty or the fetch failed. Routing normally
// selects from whatever the publisher endpoint returned, so a retired model
// disappears without a code change.
const FALLBACK_LITE = { name: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' };
const FALLBACK_FULL = { name: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' };

// Positive evidence of a lookup, transform, greeting or short generative task
const ROUTE_LITE_RE = new RegExp(
  '^\\s*(say|greet|translate|rephrase|paraphrase|reword|correct|fix|spell|' +
  'capitalis|capitaliz|format|convert)\\b' +
  '|^\\s*(hi|hey|hello|thanks|thank you|good (morning|afternoon|evening))\\b' +
  '|^\\s*how (are|is) (you|it going|things)\\b' +
  '|\\b(what|who|when|where) (is|are|was|were) the\\b' +
  '|\\bwho (wrote|directed|invented|founded|discovered)\\b' +
  '|\\b(capital|population|currency|synonym|antonym|definition) of\\b' +
  '|\\b(haiku|limerick|joke|rhyme|acronym)\\b', 'i'
);

// Anything asking for mechanism, judgement, or comparison
const ROUTE_CONCEPTUAL_RE = /\b(explain|describe|compare|contrast|analyse|analyze|assess|evaluate|critique|justify|why|how does|how do|how can|how would|what causes|what happens|difference|differences|trade-?offs?|pros and cons|advantages|implications?|consequences?|should i|best way|recommend|overview)\b/i;

const ROUTE_NUMERIC_RE = /\d+\s*(mph|kmh|km|miles?|kg|lbs?|%|percent|degrees?|minutes?|hours?|days?|weeks?|years?|dollars?|usd|eur|gbp|inr)\b/i;

const ROUTE_MULTISTEP_RE = /\b(and then|after that|given that|assuming|calculate|how (long|many|much|far|fast))\b/i;

const ROUTE_CODE_RE = /```|[{};]\s*$|\b(def|function|class|return|import|const|let|var|public|void|regex|sql|select|insert|update|delete|endpoint|git|bash|docker|npm|async|await)\b/i;

export function routeModel(text, availableModels = []) {
  const raw = (text || '').trim();

  // Pick by tier from whatever is currently available, not by version.
  // The list arrives sorted newest first, so this selects the newest model
  // of each tier and survives any single version being retired.
  const flash = availableModels.filter(m => /flash/i.test(m.name));
  const lite = flash.find(m => /lite/i.test(m.name)) || FALLBACK_LITE;
  const full = flash.find(m => !/lite/i.test(m.name)) || FALLBACK_FULL;

  const pick = (m, tier, reason) => ({
    tier, modelName: m.name, displayName: m.displayName, reason
  });

  if (!raw) return pick(lite, 'lite', 'Empty prompt');

  const tokens = Math.ceil(raw.length / 4.25);

  // Difficulty first — a short prompt can still need reasoning
  if (ROUTE_NUMERIC_RE.test(raw) || ROUTE_MULTISTEP_RE.test(raw)) {
    return pick(full, 'reasoning', 'Quantitative or multi-step');
  }
  if (ROUTE_CODE_RE.test(raw)) {
    return pick(full, 'reasoning', 'Code or technical');
  }
  if (ROUTE_CONCEPTUAL_RE.test(raw)) {
    return pick(full, 'reasoning', 'Conceptual or comparative');
  }
  if (tokens > 60) {
    return pick(full, 'reasoning', 'Extended context');
  }

  // Only then fall through to the cheap tier
  if (ROUTE_LITE_RE.test(raw)) {
    return pick(lite, 'lite', 'Lookup or transform');
  }

  return pick(full, 'reasoning', 'No trivial signal, defaulting up');
}
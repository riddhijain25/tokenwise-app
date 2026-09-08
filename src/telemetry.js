/* Telemetry capture.

   One record per message sent, not per keystroke — scoring fires
   continuously and would otherwise produce hundreds of rows for a
   single prompt.

   Records are written to local storage as a queue. Production will flush
   that queue to a backend every 60 seconds and clear it only on confirmed
   receipt, so a failed request retries rather than losing data. The queue
   structure is here so that change is one function rather than a rewrite.

   org_id, dept_id and user_hash are left null. Those must be attached
   server-side from a verified identity — anything the browser sends
   could be edited.

   There is no field capable of holding prompt text. The privacy guarantee
   is structural, not procedural.
*/

const QUEUE_KEY = 'tokenwise_telemetry';
const MAX_QUEUE = 500;   // stop unbounded growth if a flush never runs

function read() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (e) { return []; }
}

function write(records) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(records)); }
    catch (e) { console.warn('Telemetry write failed', e); }
}

// Tracks the prompt currently being composed. Set on first score,
// cleared once the message is sent.
let pending = null;

export function beginPrompt(score) {
    if (pending) return;
    pending = {
        message_id: crypto.randomUUID(),
        started_at: new Date().toISOString(),
        initial_score: score.scored ? score.score : null,
        initial_tokens: score.tokens ?? null,
        initial_issues: score.issues || [],
        was_optimised: false
    };
}

export function markOptimised() {
    if (pending) pending.was_optimised = true;
}

export function recordSend(fields) {
    const record = {
        ...(pending || {
            message_id: crypto.randomUUID(),
            started_at: new Date().toISOString(),
            initial_score: null,
            initial_tokens: null,
            was_optimised: false
        }),
        sent_at: new Date().toISOString(),
        org_id: null,
        dept_id: null,
        user_hash: null,
        is_synthetic: false,
        factor_version: 'v2026.06',
        ...fields
    };

    const q = read();
    q.push(record);
    // Drop oldest first if over cap
    write(q.length > MAX_QUEUE ? q.slice(-MAX_QUEUE) : q);

    pending = null;
    return record;
}

export function discardPending() {
    pending = null;
}

/* Console helpers for inspection and export */

export function installConsoleHelpers() {
    window.tokenwise = {
        all: () => read(),

        count: () => read().length,

        // Newline-delimited JSON, which is what BigQuery ingests
        ndjson: () => read().map(r => JSON.stringify(r)).join('\n'),

        download: () => {
            const blob = new Blob([read().map(r => JSON.stringify(r)).join('\n')],
                { type: 'application/x-ndjson' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `tokenwise-telemetry-${Date.now()}.ndjson`;
            a.click();
            URL.revokeObjectURL(a.href);
        },

        summary: () => {
            const r = read();
            if (!r.length) return 'No records';
            const sum = k => r.reduce((n, x) => n + (x[k] || 0), 0);
            const byModel = {};
            r.forEach(x => { byModel[x.model_used] = (byModel[x.model_used] || 0) + 1; });
            const scored = r.filter(x => x.initial_score !== null && x.final_score !== null);
            return {
                messages: r.length,
                tokens_total: sum('tokens_total'),
                tokens_new: sum('tokens_new'),
                tokens_history: sum('tokens_history'),
                tokens_thinking: sum('tokens_thinking'),
                tokens_out: sum('tokens_out'),
                no_bound_pct: Math.round(
                    r.filter(x => x.constraint_present === false).length / r.length * 100),
                optimised_pct: Math.round(
                    r.filter(x => x.was_optimised).length / r.length * 100),
                avg_score_gain: scored.length
                    ? Math.round(scored.reduce((n, x) => n + (x.final_score - x.initial_score), 0) / scored.length)
                    : null,
                by_model: byModel
            };
        },

        clear: () => { localStorage.removeItem(QUEUE_KEY); return 'Cleared'; }
    };
}
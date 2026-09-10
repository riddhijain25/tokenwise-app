/* ============================================================
   TokenWise Telemetry
   ============================================================

   - One record per message sent
   - Records are queued in localStorage
   - Queue is flushed by app.js
   - Records are removed only after successful server receipt
   - Prompt text is never stored
   - user_hash is NOT supplied by the browser
   - org_id / dept_id may be supplied by the browser for testing
   ============================================================ */

const QUEUE_KEY = 'tokenwise_telemetry';
const MAX_QUEUE = 500;


/* ---------- local queue helpers ---------- */

function read() {
    try {
        return JSON.parse(
            localStorage.getItem(QUEUE_KEY) || '[]'
        );
    } catch (e) {
        console.warn('Telemetry read failed:', e);
        return [];
    }
}

function write(records) {
    try {
        localStorage.setItem(
            QUEUE_KEY,
            JSON.stringify(records)
        );
    } catch (e) {
        console.warn('Telemetry write failed:', e);
    }
}


/* ---------- queue API ---------- */

/*
 * Returns the current queue.
 * app.js uses this when flushing telemetry.
 */
export function getQueue() {
    return read();
}


/*
 * Remove only the records that were included in a
 * successfully acknowledged batch.
 *
 * Example:
 *
 * Queue:       A B C D
 * Sent batch:  A B C
 * Success:     A B C removed
 * Remaining:   D
 */
export function removeSent(events) {
    if (!Array.isArray(events) || events.length === 0) {
        return;
    }

    const sentIds = new Set(
        events
            .map(event => event?.message_id)
            .filter(Boolean)
    );

    if (sentIds.size === 0) {
        return;
    }

    const currentQueue = read();

    const remaining = currentQueue.filter(
        record => !sentIds.has(record.message_id)
    );

    write(remaining);
}


/*
 * Used for testing/debugging.
 */
export function clearQueue() {
    try {
        localStorage.removeItem(QUEUE_KEY);
    } catch (e) {
        console.warn('Telemetry clear failed:', e);
    }
}


/* ============================================================
   Current prompt tracking
   ============================================================ */

let pending = null;


/*
 * Called when the first score is calculated for a prompt.
 *
 * We intentionally keep the FIRST score/token count because
 * that represents the initial state before optimization.
 */
export function beginPrompt(score) {
    if (!pending) {
        // Brand new prompt session
        pending = {
            message_id: crypto.randomUUID(),
            started_at: new Date().toISOString(),
            initial_score: score?.scored ? score.score : null,
            initial_tokens: score?.tokens ?? null,
            initial_issues: Array.isArray(score?.issues) ? [...score.issues] : [],
            was_optimised: false
        };
    } else if (!pending.was_optimised) {
        // If the user is typing/rewriting back and forth BEFORE optimizing,
        // keep updating initial_tokens to reflect their latest draft state!
        pending.initial_score = score?.scored ? score.score : null;
        pending.initial_tokens = score?.tokens ?? null;
        pending.initial_issues = Array.isArray(score?.issues) ? [...score.issues] : [];
    }
}


/*
 * Called when the user clicks Optimize.
 */
export function markOptimised(optimizedScore) {
    if (pending) {
        pending.was_optimised = true;

        // Optional: if you want to track what the tokens changed to after optimization
        if (optimizedScore) {
            pending.final_tokens = optimizedScore.tokens ?? null;
            pending.final_score = optimizedScore.scored ? optimizedScore.score : null;
        }
    }
}


/*
 * Create one telemetry record when a message is successfully
 * sent to the model.
 */
export function recordSend(fields = {}) {

    /*
     * Fallback in case beginPrompt() was not called.
     */
    const baseRecord = pending || {
        message_id: crypto.randomUUID(),

        started_at: new Date().toISOString(),

        initial_score: null,

        initial_tokens: null,

        initial_issues: [],

        was_optimised: false
    };


    const record = {
        ...baseRecord,
        ...fields,

        sent_at:
            fields.sent_at ||
            new Date().toISOString(),

        /*
         * org_id and dept_id can currently be supplied by
         * the browser during testing.
         *
         * user_hash is intentionally NOT created here.
         * server.js derives it from the authenticated Firebase
         * user.
         */

        org_id:
            fields.org_id ?? null,

        dept_id:
            fields.dept_id ?? null,

        is_synthetic: false,

        factor_version:
            fields.factor_version ||
            'v2026.06'
    };


    /* ---------- add to queue ---------- */

    const queue = read();

    queue.push(record);


    /*
     * Enforce the maximum queue size.
     *
     * If there are more than 500 records, retain the newest
     * 500 records.
     */
    const trimmedQueue =
        queue.length > MAX_QUEUE
            ? queue.slice(-MAX_QUEUE)
            : queue;

    write(trimmedQueue);


    /*
     * Prompt has now been recorded.
     */
    pending = null;

    return record;
}


/*
 * Called when the request fails.
 *
 * No telemetry record is created for the failed request.
 */
export function discardPending() {
    pending = null;
}


/* ============================================================
   Console helpers
   ============================================================ */

export function installConsoleHelpers() {

    window.tokenwise = {

        /*
         * View queued records:
         *
         * tokenwise.all()
         */
        all: () => read(),


        /*
         * Number of queued records:
         *
         * tokenwise.count()
         */
        count: () => read().length,


        /*
         * Export queue as NDJSON:
         *
         * tokenwise.ndjson()
         */
        ndjson: () =>
            read()
                .map(record => JSON.stringify(record))
                .join('\n'),


        /*
         * Download queued telemetry.
         */
        download: () => {

            const data =
                read()
                    .map(record => JSON.stringify(record))
                    .join('\n');

            const blob = new Blob(
                [data],
                {
                    type: 'application/x-ndjson'
                }
            );

            const url =
                URL.createObjectURL(blob);

            const a =
                document.createElement('a');

            a.href = url;
            a.download = 'tokenwise-telemetry.ndjson';

            document.body.appendChild(a);
            a.click();
            a.remove();

            URL.revokeObjectURL(url);
        },


        /*
         * Basic queue summary.
         */
        summary: () => {

            const records = read();

            return {
                count: records.length,

                optimised:
                    records.filter(
                        r => r.was_optimised === true
                    ).length,

                notOptimised:
                    records.filter(
                        r => r.was_optimised !== true
                    ).length,

                totalTokens:
                    records.reduce(
                        (sum, r) =>
                            sum + (r.tokens_total || 0),
                        0
                    )
            };
        },


        /*
         * Testing only:
         *
         * tokenwise.clear()
         */
        clear: () => {
            clearQueue();
            return 'Telemetry queue cleared';
        }
    };
}
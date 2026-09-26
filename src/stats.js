/**
 * Creates a statistics tracker with the specified limit for rolling windows.
 * @param {number} limit - Maximum number of values to keep per list (default 200)
 * @returns {object} Stats object with planMs, briefTokens, droppedTokens, and stageMs
 */
export function createStats(limit = 200) {
    return { limit, planMs: [], briefTokens: [], droppedTokens: [], stageMs: {} };
}

function push(list, value, limit) {
    list.push(value);
    if (list.length > limit) list.shift();
}

/**
 * Calculates the nearest-rank percentile of a sorted array.
 * @param {number[]} values - Array of values (need not be sorted)
 * @param {number} p - Percentile (0-100)
 * @returns {number|null} The percentile value, or null if no values
 */
export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

/**
 * Records stage execution times for stages that ran.
 * @param {object} stats - The stats object from createStats
 * @param {object[]} reports - Array of stage reports with id, status, and ms
 */
export function recordStageTimes(stats, reports) {
    for (const report of reports) {
        if (report.status === 'ran') push(stats.stageMs[report.id] ??= [], report.ms, stats.limit);
    }
}

/**
 * Records a plan execution with duration, stage times, and token metrics.
 * @param {object} stats - The stats object from createStats
 * @param {object} data - Plan data with ms, reports, briefTokens, droppedTokens
 */
export function recordPlan(stats, { ms, reports, briefTokens, droppedTokens }) {
    push(stats.planMs, ms, stats.limit);
    push(stats.briefTokens, briefTokens, stats.limit);
    push(stats.droppedTokens, droppedTokens, stats.limit);
    recordStageTimes(stats, reports);
}

const average = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * Generates a summary of statistics with percentiles and averages.
 * @param {object} stats - The stats object from createStats
 * @returns {object} Summary with turns, plan percentiles, stage stats, and token averages
 */
export function summarizeStats(stats) {
    return {
        turns: stats.planMs.length,
        plan: { p50: percentile(stats.planMs, 50), p95: percentile(stats.planMs, 95) },
        stages: Object.fromEntries(Object.entries(stats.stageMs).map(([id, values]) => [
            id, { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) },
        ])),
        avgBriefTokens: average(stats.briefTokens),
        avgDroppedTokens: average(stats.droppedTokens),
    };
}

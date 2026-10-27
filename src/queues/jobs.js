'use strict';
/**
 * src/queues/jobs.js
 *
 * Per-market delayed jobs, so the worker wakes at the exact due time instead of waiting for a
 * polling cycle. Jobs live in Redis and survive restarts. A repeating sweeper (see scheduler.js)
 * is the safety net for anything that was missed.
 */

const client = require('./client');
// Tolerate the different ways client.js may export its queues.
const resolutionQueue = client.resolutionQueue || client.queues?.resolution || client.queues?.resolutionQueue
  || (typeof client.getQueue === 'function' ? client.getQueue('resolution') : null);
if (!resolutionQueue) throw new Error('src/queues/client.js must export the resolution queue as `resolutionQueue`');

const JOB = 'resolve-market';
const opts = (jobId, delay) => ({ jobId, delay: Math.max(0, Math.floor(delay)), attempts: 1, removeOnComplete: true, removeOnFail: { count: 200 } });

/** Schedule (idempotently) the due-time resolution and the deadline cancel check for a market. */
async function scheduleResolution(marketId, { dueAt, deadlineAt }, now = Date.now()) {
  await resolutionQueue.add(JOB, { marketId, trigger: 'scheduled' }, opts(`due-${marketId}`, dueAt - now));
  if (deadlineAt) {
    // One last, higher-effort attempt before the deadline (after the deadline the contract no longer accepts a resolution)...
    const finalAt = deadlineAt - Number(process.env.AGENT_FINAL_ATTEMPT_LEAD_MINUTES || 90) * 60_000;
    if (finalAt > now) await resolutionQueue.add(JOB, { marketId, trigger: 'final' }, opts(`final-${marketId}`, finalAt - now));
    // ...and only after that, if there is still no verified answer, the refund.
    await resolutionQueue.add(JOB, { marketId, trigger: 'deadline' }, opts(`deadline-${marketId}`, deadlineAt + 60_000 - now));
  }
}

/** Try again later (agent deferred, or an attempt failed). Unique id so it never collides with a finished job. */
async function scheduleRetry(marketId, delayMs) {
  await resolutionQueue.add(JOB, { marketId, trigger: 'retry' }, opts(`retry-${marketId}-${Date.now()}`, delayMs));
}

/** Manual (user-triggered) resolution. Runs immediately. */
async function enqueueManualResolution(marketId, requestedBy, jobRecordId) {
  return resolutionQueue.add(JOB, { marketId, trigger: 'manual', requestedBy, jobRecordId }, opts(`manual-${marketId}-${Date.now()}`, 0));
}

/** Pay out a settled market (winners, or refunds). Idempotent; deduped per market while a job is waiting. */
async function schedulePayout(marketId, delayMs = 5000) {
  await resolutionQueue.add('payout-market', { marketId }, opts(`payout-${marketId}`, delayMs));
}

async function hasScheduledJob(marketId) {
  const j = await resolutionQueue.getJob(`due-${marketId}`);
  return !!j;
}

module.exports = { schedulePayout, JOB, scheduleResolution, scheduleRetry, enqueueManualResolution, hasScheduledJob };

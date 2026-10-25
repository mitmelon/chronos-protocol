'use strict';
/**
 * src/queues/handlers.js
 *
 * Job handlers for the BullMQ workers. In src/queues/workers.js the resolution worker should simply be:
 *
 *   const { handleResolutionJob } = require('./handlers');
 *   new Worker(QUEUE_NAMES.resolution, handleResolutionJob, { connection, concurrency: 2 });
 *
 * - job.name === 'resolve-market'  (due-time, deadline, retry or manual): one agent run for one market
 * - any other name (the repeating sweep): resolve everything that is due, refund anything past its deadline
 */

const { resolveMarketById, runResolution } = require('../agent/resolve');
const { JOB } = require('./jobs');
const { payoutMarket } = require('../agent/payouts');

async function handleResolutionJob(job) {
  if (job.name === JOB) {
    const { marketId, trigger = 'scheduled', requestedBy = null, jobRecordId = null } = job.data || {};
    const result = await resolveMarketById(marketId, { trigger, requestedBy, jobRecordId });
    console.log(`[worker] resolve-market ${marketId} (${trigger}): ${result.status}`);
    return result;
  }
  if (job.name === 'payout-market') {
    const result = await payoutMarket(job.data.marketId);
    console.log(`[worker] payout-market ${job.data.marketId}: ${result.status} (${result.paid || 0} paid, ${result.failed || 0} failed)`);
    return result;
  }
  const result = await runResolution();
  console.log(`[worker] resolution sweep: ${result.marketsChecked || 0} checked, ${result.marketsResolved || 0} resolved, ${result.marketsRefunded || 0} refunded`);
  return result;
}

module.exports = { handleResolutionJob };

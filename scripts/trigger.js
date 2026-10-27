'use strict';
/**
 * scripts/trigger.js: queue an agent job right now instead of waiting for its schedule.
 * The running worker (node worker.js) picks it up.
 *
 *   node scripts/trigger.js discovery          find and publish new markets
 *   node scripts/trigger.js keeper             sync chain -> database, close trading
 *   node scripts/trigger.js resolve <id>       settle one market (same as pressing Resolve)
 *   node scripts/trigger.js payout <id>        pay out / refund a settled market
 *   node scripts/trigger.js sweep              resolve everything that is due
 */
require('dotenv').config();
const { discoveryQueue, resolutionQueue, keeperQueue } = require('../src/queues/client');

const [what, id] = process.argv.slice(2);
const once = { removeOnComplete: true, attempts: 1 };
const needId = () => { if (!/^\d+$/.test(id || '')) { console.error(`Usage: node scripts/trigger.js ${what} <marketId>`); process.exit(1); } return Number(id); };

(async () => {
  let job;
  switch (what) {
    case 'discovery': job = await discoveryQueue.add('discovery-manual', {}, once); break;
    case 'keeper':    job = await keeperQueue.add('keeper-manual', {}, once); break;
    case 'sweep':     job = await resolutionQueue.add('resolution-manual', {}, once); break;
    case 'resolve':   job = await resolutionQueue.add('resolve-market', { marketId: needId(), trigger: 'manual', requestedBy: 'cli' }, { ...once, jobId: `cli-${id}-${Date.now()}` }); break;
    case 'payout':    job = await resolutionQueue.add('payout-market', { marketId: needId() }, { ...once, jobId: `payout-cli-${id}-${Date.now()}` }); break;
    default: console.error('Usage: node scripts/trigger.js discovery | keeper | sweep | resolve <id> | payout <id>'); process.exit(1);
  }
  console.log(`Queued ${what}${id ? ' ' + id : ''} (job ${job.id}). Watch the worker log.`);
  await Promise.all([discoveryQueue.close(), resolutionQueue.close(), keeperQueue.close()]);
  process.exit(0);
})().catch((e) => { console.error('Could not queue the job. Is Redis running?', e.message); process.exit(1); });

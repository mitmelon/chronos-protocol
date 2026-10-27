'use strict';
/**
 * src/queues/scheduler.js
 *
 * Registers repeatable BullMQ jobs so each queue fires on its configured
 * cron pattern. BullMQ stores repeat-job state in Redis, so schedules
 * survive worker restarts without creating duplicate entries.
 *
 * Called once by worker.js at startup.
 */

const { discoveryQueue, resolutionQueue, keeperQueue } = require('./client');
const config = require('../config');

async function scheduleRepeatJobs() {
  // BullMQ upserts by (name + repeat key) — safe to call on every restart
  await discoveryQueue.add(
    'discovery',
    {},
    { repeat: { pattern: config.agent.discoverySchedule } },
  );

  await resolutionQueue.add(
    'resolution',
    {},
    { repeat: { pattern: config.agent.resolutionSchedule } },
  );

  await keeperQueue.add(
    'keeper',
    {},
    { repeat: { pattern: config.agent.keeperSchedule } },
  );

  // Run the keeper once right away: it syncs markets and makes sure every active market has its due-time resolution job
  // (Redis may have been flushed, or the market may predate the queue).
  await keeperQueue.add('keeper-startup', {}, { removeOnComplete: true, attempts: 1 });

  if (config.agent.discoveryOnStart) {
    await discoveryQueue.add('discovery-startup', {}, { removeOnComplete: true, attempts: 1 });
    console.log('[scheduler] AGENT_DISCOVERY_ON_START=true: discovery queued now');
  }

  console.log('[scheduler] Repeating jobs registered:');
  console.log(`  discovery:  ${config.agent.discoverySchedule}`);
  console.log(`  resolution: ${config.agent.resolutionSchedule}`);
  console.log(`  keeper:     ${config.agent.keeperSchedule}`);
}

module.exports = { scheduleRepeatJobs };

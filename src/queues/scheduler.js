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

  console.log('[scheduler] Repeating jobs registered:');
  console.log(`  discovery:  ${config.agent.discoverySchedule}`);
  console.log(`  resolution: ${config.agent.resolutionSchedule}`);
  console.log(`  keeper:     ${config.agent.keeperSchedule}`);
}

module.exports = { scheduleRepeatJobs };

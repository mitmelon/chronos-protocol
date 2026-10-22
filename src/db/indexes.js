'use strict';

const { db } = require('./client');

async function ensureIndexes() {
  const database = db();

  // predictions
  const predictions = database.collection('predictions');
  await predictions.createIndex({ marketId: 1 }, { unique: true, sparse: true });
  await predictions.createIndex({ state: 1 });
  await predictions.createIndex({ tradingDeadline: 1 });
  await predictions.createIndex({ resolutionDeadline: 1 });
  await predictions.createIndex({ tags: 1 });
  await predictions.createIndex({ category: 1 });
  await predictions.createIndex({ createdAt: -1 });
  await predictions.createIndex({ question: 'text', resolutionCriteria: 'text' });

  // evidence
  const evidence = database.collection('evidence');
  await evidence.createIndex({ marketId: 1 }, { unique: true });
  await evidence.createIndex({ submittedOnChain: 1 });

  // positions
  const positions = database.collection('positions');
  await positions.createIndex({ address: 1, marketId: 1 }, { unique: true });
  await positions.createIndex({ address: 1 });
  await positions.createIndex({ marketId: 1 });

  // resolutionJobs
  const resolutionJobs = database.collection('resolutionJobs');
  await resolutionJobs.createIndex({ marketId: 1 }, { unique: true });
  await resolutionJobs.createIndex({ status: 1 });

  // agentRuns
  const agentRuns = database.collection('agentRuns');
  await agentRuns.createIndex({ runId: 1 }, { unique: true });
  await agentRuns.createIndex({ type: 1, startedAt: -1 });

  // protocolSettings
  const protocolSettings = database.collection('protocolSettings');
  await protocolSettings.createIndex({ key: 1 }, { unique: true });

  console.log('[db] Indexes ensured');
}

module.exports = { ensureIndexes };

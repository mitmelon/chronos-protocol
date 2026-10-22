'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/client');
const { fetchEvidence } = require('../services/parallel');
const { processSearchResults, buildEvidenceURI } = require('../services/evidence');
const { proposeResolution } = require('../services/gemini');
const { resolveMarket, markRefundable } = require('../services/contract');
const config = require('../config');

const OUTCOME_TO_UINT8 = { YES: 1, NO: 2 };

async function runResolution() {
  const runId = uuidv4();
  const database = db();
  const agentRuns = database.collection('agentRuns');
  const predictions = database.collection('predictions');
  const evidence = database.collection('evidence');
  const resolutionJobs = database.collection('resolutionJobs');

  const run = { runId, type: 'resolution', startedAt: new Date(), status: 'running', marketsChecked: 0, marketsResolved: 0, marketsRefunded: 0, marketsUnresolvable: 0, errors: [] };
  await agentRuns.insertOne(run);

  try {
    const now = new Date();

    const toResolve = await predictions.find({ state: 'TradingClosed', resolutionDeadline: { $gt: now }, marketId: { $exists: true, $ne: null } }).toArray();
    const toRefund  = await predictions.find({ state: { $in: ['Open','TradingClosed'] }, resolutionDeadline: { $lt: now }, marketId: { $exists: true, $ne: null } }).toArray();

    run.marketsChecked = toResolve.length + toRefund.length;

    for (const market of toRefund) {
      try {
        const { txHash } = await markRefundable(market.marketId);
        await predictions.updateOne({ marketId: market.marketId }, { $set: { state: 'Refundable', updatedAt: new Date(), markRefundableTxHash: txHash } });
        run.marketsRefunded++;
        console.log(`[resolution] Marked market ${market.marketId} refundable (tx: ${txHash})`);
      } catch (err) {
        console.error(`[resolution] markRefundable failed for market ${market.marketId}:`, err.message);
        run.errors.push({ marketId: market.marketId, step: 'markRefundable', error: err.message });
      }
    }

    for (const market of toResolve) {
      const existingJob = await resolutionJobs.findOne({ marketId: market.marketId, status: { $in: ['pending','submitted'] } });
      if (existingJob) { console.log(`[resolution] Market ${market.marketId} already has pending job`); continue; }

      const jobId = uuidv4();
      const job = { jobId, marketId: market.marketId, question: market.question, resolutionCriteria: market.resolutionCriteria, authoritySource: market.authoritySource, status: 'pending', createdAt: new Date() };
      await resolutionJobs.insertOne(job);

      try {
        console.log(`[resolution] Gathering evidence for market ${market.marketId}: "${market.question.slice(0, 60)}..."`);
        const rawResults = await fetchEvidence(market.question, market.authoritySource);
        const sources = await processSearchResults(rawResults);

        const { parsed: proposal } = await proposeResolution(market, { sources });
        console.log(`[resolution] Market ${market.marketId}: proposed ${proposal.proposedOutcome} (confidence: ${proposal.confidence})`);

        const evidenceDoc = { marketId: market.marketId, proposedOutcome: proposal.proposedOutcome, confidence: proposal.confidence, geminiReasoning: proposal.reasoning, conflictDetected: proposal.conflictDetected, insufficientEvidence: proposal.insufficientEvidence, sources, runId, createdAt: new Date(), submittedOnChain: false };
        await evidence.replaceOne({ marketId: market.marketId }, evidenceDoc, { upsert: true });

        if (proposal.proposedOutcome === 'UNRESOLVABLE' || proposal.conflictDetected || proposal.insufficientEvidence || proposal.confidence < config.agent.minConfidence) {
          run.marketsUnresolvable++;
          await resolutionJobs.updateOne({ jobId }, { $set: { status: 'unresolvable', reason: proposal.reasoning, updatedAt: new Date() } });
          continue;
        }

        const evidenceURI = await buildEvidenceURI(market.marketId, { ...proposal, sources });
        const outcomeUint8 = OUTCOME_TO_UINT8[proposal.proposedOutcome];
        if (!outcomeUint8) throw new Error(`Unknown outcome: ${proposal.proposedOutcome}`);

        const { txHash } = await resolveMarket(market.marketId, outcomeUint8, evidenceURI);
        await predictions.updateOne({ marketId: market.marketId }, { $set: { state: 'Resolved', outcome: proposal.proposedOutcome, resolvedAt: new Date(), evidenceURI, resolveTxHash: txHash, updatedAt: new Date() } });
        await evidence.updateOne({ marketId: market.marketId }, { $set: { submittedOnChain: true, txHash, updatedAt: new Date() } });
        await resolutionJobs.updateOne({ jobId }, { $set: { status: 'submitted', txHash, updatedAt: new Date() } });
        run.marketsResolved++;
        console.log(`[resolution] Market ${market.marketId} resolved ${proposal.proposedOutcome} (tx: ${txHash})`);
      } catch (err) {
        console.error(`[resolution] Error resolving market ${market.marketId}:`, err.message);
        run.errors.push({ marketId: market.marketId, step: 'resolve', error: err.message });
        await resolutionJobs.updateOne({ jobId }, { $set: { status: 'failed', error: err.message, updatedAt: new Date() } });
      }
    }

    run.status = 'completed'; run.completedAt = new Date();
  } catch (err) {
    console.error('[resolution] Fatal error:', err);
    run.status = 'failed'; run.error = err.message; run.completedAt = new Date();
  }

  await agentRuns.updateOne({ runId }, { $set: run });
  return run;
}

module.exports = { runResolution };

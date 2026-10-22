'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/client');
const { getMarketCount, getMarket, closeTrading } = require('../services/contract');
const config = require('../config');

async function runKeeper() {
  const runId = uuidv4();
  const database = db();
  const agentRuns = database.collection('agentRuns');
  const predictions = database.collection('predictions');

  const run = { runId, type: 'keeper', startedAt: new Date(), status: 'running', marketsScanned: 0, tradingClosed: 0, dbSynced: 0, errors: [] };
  await agentRuns.insertOne(run);

  try {
    if (!config.arc.factoryAddress) {
      run.status = 'skipped'; run.skipReason = 'VITE_FACTORY_ADDRESS not configured';
      await agentRuns.updateOne({ runId }, { $set: run });
      return run;
    }

    const marketCount = await getMarketCount();
    const count = Number(marketCount);
    run.marketsScanned = count;
    const now = Math.floor(Date.now() / 1000);

    const BATCH = 10;
    for (let i = 0; i < count; i += BATCH) {
      const batch = [];
      for (let j = i; j < Math.min(i + BATCH, count); j++) batch.push(j);

      const markets = await Promise.allSettled(batch.map(id => getMarket(id)));

      for (let k = 0; k < markets.length; k++) {
        const result = markets[k];
        if (result.status === 'rejected') { run.errors.push({ marketId: batch[k], error: result.reason?.message || 'fetch failed' }); continue; }

        const market = result.value;
        await predictions.updateOne({ marketId: market.marketId }, {
          $set: { marketId: market.marketId, question: market.question, resolutionCriteria: market.resolutionCriteria, tradingDeadline: market.tradingDeadline, resolutionDeadline: market.resolutionDeadline, yesPool: market.yesPool, noPool: market.noPool, totalPool: market.totalPool, state: market.state, outcome: market.outcome, resolvedAt: market.resolvedAt, evidenceURI: market.evidenceURI, swept: market.swept, creator: market.creator, feeBps: market.feeBps, updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date(), category: 'Other', tags: [] },
        }, { upsert: true });
        run.dbSynced++;

        if (market.state === 'Open') {
          const deadlineTs = Math.floor(market.tradingDeadline.getTime() / 1000);
          if (now >= deadlineTs) {
            try {
              const { txHash } = await closeTrading(market.marketId);
              await predictions.updateOne({ marketId: market.marketId }, { $set: { state: 'TradingClosed', closeTradingTxHash: txHash, updatedAt: new Date() } });
              run.tradingClosed++;
              console.log(`[keeper] Closed trading for market ${market.marketId} (tx: ${txHash})`);
            } catch (err) {
              if (!err.message?.includes('InvalidMarketState')) {
                console.warn(`[keeper] closeTrading failed for market ${market.marketId}:`, err.message);
                run.errors.push({ marketId: market.marketId, step: 'closeTrading', error: err.message });
              }
            }
          }
        }
      }
    }

    run.status = 'completed'; run.completedAt = new Date();
  } catch (err) {
    console.error('[keeper] Fatal error:', err);
    run.status = 'failed'; run.error = err.message; run.completedAt = new Date();
  }

  await agentRuns.updateOne({ runId }, { $set: run });
  return run;
}

module.exports = { runKeeper };

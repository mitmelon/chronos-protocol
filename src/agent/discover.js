'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/client');
const { discoverFutureEvents } = require('../services/parallel');
const { generateMarketQuestion, validateQuestion } = require('../services/gemini');
const config = require('../config');

async function runDiscovery() {
  const runId = uuidv4();
  const database = db();
  const agentRuns = database.collection('agentRuns');
  const predictions = database.collection('predictions');

  const run = { runId, type: 'discovery', startedAt: new Date(), status: 'running', marketsConsidered: 0, marketsPublished: 0, marketsRejected: 0, rejectionReasons: [], errors: [] };
  await agentRuns.insertOne(run);

  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const publishedToday = await predictions.countDocuments({ createdAt: { $gte: today } });
    if (publishedToday >= config.agent.maxMarketsPerDay) {
      run.status = 'skipped';
      run.skipReason = `Already published ${publishedToday} markets today (max: ${config.agent.maxMarketsPerDay})`;
      await agentRuns.updateOne({ runId }, { $set: run });
      return run;
    }
    const quota = config.agent.maxMarketsPerDay - publishedToday;

    console.log(`[discovery] Discovering events (quota: ${quota})`);
    const events = await discoverFutureEvents();
    run.marketsConsidered = events.length;

    const existingQuestions = await predictions.find({}, { projection: { question: 1 } }).toArray();
    const questionTexts = existingQuestions.map(p => p.question);

    let published = 0;
    for (const event of events) {
      if (published >= quota) break;
      try {
        const { parsed: questionData } = await generateMarketQuestion(event);
        if (!questionData.verifiable) { run.marketsRejected++; run.rejectionReasons.push({ event: event.title, reason: questionData.rejectionReason }); continue; }

        const { parsed: validation } = await validateQuestion(questionData.question, questionData.resolutionCriteria, questionTexts);
        if (!validation.valid || validation.isDuplicate) { run.marketsRejected++; run.rejectionReasons.push({ event: event.title, reason: validation.rejectionReason || 'Duplicate detected' }); continue; }

        const now = Math.floor(Date.now() / 1000);
        const tradingDeadlineSecs = now + (questionData.tradingDeadlineDaysFromNow * 86400);
        const resolutionDeadlineSecs = now + (questionData.resolutionDeadlineDaysFromNow * 86400);

        if (tradingDeadlineSecs - now < 86400 || tradingDeadlineSecs - now > 365 * 86400) { run.marketsRejected++; run.rejectionReasons.push({ event: event.title, reason: 'Trading deadline out of range (24h - 365d)' }); continue; }
        if (resolutionDeadlineSecs <= tradingDeadlineSecs) { run.marketsRejected++; run.rejectionReasons.push({ event: event.title, reason: 'Resolution deadline must be after trading deadline' }); continue; }

        const marketDoc = {
          question: questionData.question.slice(0, 1024),
          resolutionCriteria: questionData.resolutionCriteria.slice(0, 4096),
          category: questionData.category || 'Other',
          tags: questionData.tags || [],
          authoritySource: questionData.authoritySource || '',
          tradingDeadline: new Date(tradingDeadlineSecs * 1000),
          resolutionDeadline: new Date(resolutionDeadlineSecs * 1000),
          tradingDeadlineTs: tradingDeadlineSecs,
          resolutionDeadlineTs: resolutionDeadlineSecs,
          state: 'Pending',
          outcome: 'UNRESOLVED',
          yesPool: '0', noPool: '0', totalPool: '0',
          source: { eventTitle: event.title, eventUrl: event.url, searchQuery: event.searchQuery || '' },
          discoveryRunId: runId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await predictions.insertOne(marketDoc);
        questionTexts.push(questionData.question);
        published++;
        run.marketsPublished++;
        console.log(`[discovery] Published market: "${questionData.question.slice(0, 80)}..."`);
      } catch (err) {
        console.error(`[discovery] Error processing event "${event.title}":`, err.message);
        run.errors.push({ event: event.title, error: err.message });
      }
    }

    run.status = 'completed';
    run.completedAt = new Date();
  } catch (err) {
    console.error('[discovery] Fatal error:', err);
    run.status = 'failed'; run.error = err.message; run.completedAt = new Date();
  }

  await agentRuns.updateOne({ runId }, { $set: run });
  return run;
}

module.exports = { runDiscovery };

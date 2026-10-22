'use strict';

const { getProtocolSettings } = require('../services/contract');
const config = require('../config');

async function settingsRoutes(fastify) {
  fastify.get('/api/settings/public', async (request, reply) => {
    try {
      const settings = await getProtocolSettings();
      return { feeBps: settings.feeBps, gracePeriodDays: settings.gracePeriodDays, usdcAddress: config.arc.usdcAddress, contractAddress: config.arc.factoryAddress, chainId: config.arc.chainId, explorerUrl: config.arc.explorerUrl, treasury: settings.treasury, oracle: settings.oracle, paused: settings.paused };
    } catch (err) {
      return { feeBps: config.protocol.feeBps, gracePeriodDays: config.protocol.gracePeriodSeconds / 86400, usdcAddress: config.arc.usdcAddress, contractAddress: config.arc.factoryAddress, chainId: config.arc.chainId, explorerUrl: config.arc.explorerUrl, error: 'Contract not reachable: ' + err.message };
    }
  });
}

module.exports = settingsRoutes;

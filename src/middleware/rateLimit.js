'use strict';

module.exports = {
  global: {
    max: 60,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: true,
      message: 'Too many requests',
      code: 'RATE_LIMITED',
    }),
  },
  tradeHistory: {
    max: 20,
    timeWindow: '1 minute',
  },
};

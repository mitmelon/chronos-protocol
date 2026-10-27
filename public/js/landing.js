// Live numbers on the home page: TVL, staked, resolved, paid to winners.
import { getStats } from './api2.js';
import { formatUsdc } from './utils.js';

const usdc = (raw) => (raw === null || raw === undefined ? '—' : `${formatUsdc(raw, Number(raw) >= 1e9 ? 0 : 2)} <small>USDC</small>`);
const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

async function paint() {
  try {
    const s = await getStats();
    set('st-tvl', usdc(s.tvlUsdc));
    set('st-staked', usdc(s.totalStakedUsdc));
    set('st-staked-n', `${s.positions} position${s.positions === 1 ? '' : 's'}, ${s.stakers} staker${s.stakers === 1 ? '' : 's'}`);
    set('st-resolved', String(s.resolvedMarkets));
    set('st-resolved-n', `${s.openMarkets} open now${s.refundedMarkets ? `, ${s.refundedMarkets} refunded` : ''}`);
    set('st-won', usdc(s.paidToWinnersUsdc));
  } catch { /* leave the dashes: the page still works without live numbers */ }
}
if (document.getElementById('st-tvl')) { paint(); setInterval(paint, 30000); }

// ─── Oracle (agent) ──────────────────────────────────────────────────────────
import { api } from '../api.js';
import { esc, formatDateTime, timeAgo, emptyState } from '../utils.js';
import { icon } from '../ui.js';

const TYPES = [['all', 'All types'], ['discovery', 'Discovery'], ['resolution', 'Resolution'], ['keeper', 'Keeper']];
const STEPS = [['discovery', 'Discovery'], ['validation', 'Validation'], ['keeper', 'Keeper'], ['resolution', 'Resolution']];
const cap = (s) => String(s || '').replace(/^./, c => c.toUpperCase());

export async function renderAgent(view) {
  view.innerHTML = `
    <div class="page">
      <div class="page-head"><div><h1>Oracle</h1><p>Discovery, research and resolution, run autonomously.</p></div></div>
      <div class="stack">
        <div class="metrics" id="metrics">
          ${[0, 1, 2, 3].map(() => `<div class="metric"><div class="skeleton" style="height:14px;width:80px"></div><div class="skeleton" style="height:28px;width:50px;margin-top:10px"></div></div>`).join('')}
        </div>

        <div class="cols">
          <section class="card card-pad">
            <h2 class="section-title">Pipeline</h2>
            <dl class="kv" id="pipeline" style="margin-top:14px">
              ${STEPS.map(([k, l]) => `<div><dt>${l}</dt><dd id="step-${k}" style="font-weight:400;color:var(--muted)">—</dd></div>`).join('')}
            </dl>
          </section>
          <section class="card card-pad">
            <h2 class="section-title">Last run</h2>
            <div id="last-run" style="margin-top:14px"><div class="skeleton" style="height:96px"></div></div>
          </section>
        </div>

        <section class="card">
          <div class="card-head">
            <h2 class="section-title">Run history</h2>
            <div style="display:flex;gap:8px">
              <select id="f-type" aria-label="Filter runs by type">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
              <button class="btn btn-secondary btn-sm btn-icon" id="refresh" aria-label="Refresh">${icon.refresh}</button>
            </div>
          </div>
          <div class="table-wrap" id="runs"></div>
        </section>
      </div>
    </div>`;

  const $ = (s) => view.querySelector(s);
  const typeEl = $('#f-type');
  typeEl.addEventListener('change', () => loadRuns());
  $('#refresh').addEventListener('click', () => loadAll());

  async function loadAll() {
    const [report, recent] = await Promise.allSettled([api.dailyReport(), api.agentRuns({ limit: 30 })]);
    if (!view.isConnected) return;

    if (report.status === 'fulfilled') {
      const r = report.value;
      const running = r.currentStatus === 'running';
      $('#metrics').innerHTML = `
        <div class="metric"><div class="k">Status</div><div class="v" style="font-size:20px;padding-top:4px">${running ? 'Running' : 'Idle'}</div><div class="n">${esc(r.currentRunType || 'Waiting for next run')}</div></div>
        <div class="metric"><div class="k">Runs today</div><div class="v">${esc(r.runsToday ?? 0)}</div></div>
        <div class="metric"><div class="k">Markets published</div><div class="v">${esc(r.marketsPublishedToday ?? 0)}</div><div class="n">Today</div></div>
        <div class="metric"><div class="k">Resolved</div><div class="v">${esc(r.marketsResolvedToday ?? 0)}</div><div class="n">Today</div></div>`;

      const l = r.lastRun;
      const row = (k, v) => `<div><dt>${k}</dt><dd class="num">${esc(v ?? 0)}</dd></div>`;
      $('#last-run').innerHTML = l ? `
        <p class="hint" style="margin:0 0 12px">${cap(l.type)} run, ${formatDateTime(l.startedAt)}</p>
        <dl class="kv">${l.type === 'discovery' ? row('Considered', l.marketsConsidered) + row('Published', l.marketsPublished) + row('Rejected', l.marketsRejected)
          : l.type === 'resolution' ? row('Checked', l.marketsChecked) + row('Resolved', l.marketsResolved) + row('Unresolvable', l.marketsUnresolvable)
          : row('Status', l.status)}</dl>`
        : '<p class="hint" style="margin:0">No runs yet today.</p>';
    } else {
      $('#metrics').innerHTML = `<div class="metric" style="grid-column:1/-1"><div class="n">Oracle report is unavailable.</div></div>`;
      $('#last-run').innerHTML = '<p class="hint" style="margin:0">Unavailable.</p>';
    }

    if (recent.status === 'fulfilled') {
      const runs = recent.value.runs || [];
      STEPS.forEach(([k]) => {
        const last = runs.find(x => x.type === k);
        const el = $(`#step-${k}`);
        if (el) el.textContent = last ? `${cap(last.status)}, ${timeAgo(last.startedAt)}` : '—';
      });
    }
    loadRuns();
  }

  let req = 0;
  async function loadRuns() {
    const mine = ++req, type = typeEl.value, box = $('#runs');
    box.classList.add('loading');
    try {
      const { runs = [] } = await api.agentRuns(type !== 'all' ? { type, limit: 30 } : { limit: 30 });
      if (mine !== req) return;
      if (!runs.length) { box.innerHTML = emptyState('No runs yet', 'The oracle runs automatically on its schedule.'); return; }
      box.innerHTML = `
        <table class="table">
          <thead><tr><th>Type</th><th>Status</th><th>Started</th><th class="r">Duration</th><th>Details</th><th class="r">Errors</th></tr></thead>
          <tbody>${runs.map(run => {
            const secs = run.completedAt ? Math.round((new Date(run.completedAt) - new Date(run.startedAt)) / 1000) : null;
            const details = run.type === 'discovery' ? `${run.marketsPublished || 0} published of ${run.marketsConsidered || 0} considered`
              : run.type === 'resolution' ? `${run.marketsResolved || 0} resolved, ${run.marketsRefunded || 0} refunded`
              : run.type === 'keeper' ? `${run.dbSynced || 0} synced, ${run.tradingClosed || 0} closed` : '—';
            const errs = run.errors?.length || 0;
            return `<tr>
              <td style="font-weight:500">${esc(cap(run.type))}</td>
              <td><span class="tag${run.status === 'failed' ? ' tag-yes' : run.status === 'completed' ? '' : ' tag-outline'}">${esc(cap(run.status))}</span></td>
              <td class="num" style="color:var(--muted)">${formatDateTime(run.startedAt)}</td>
              <td class="r num" style="color:var(--muted)">${secs !== null ? secs + 's' : run.status === 'running' ? 'Running' : '—'}</td>
              <td>${esc(details)}</td>
              <td class="r num" style="${errs ? 'font-weight:600' : 'color:var(--faint)'}">${errs}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
    } catch (err) {
      if (mine === req) box.innerHTML = emptyState('Could not load runs', err.message);
    } finally { if (mine === req) box.classList.remove('loading'); }
  }

  loadAll();
}

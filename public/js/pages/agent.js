// ─── Agent Intelligence Page ─────────────────────────────────────────────────
import { api } from '../api.js';
import { formatDateTime, formatDate } from '../utils.js';

export async function renderAgent(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Agent Intelligence</h1>
      <p class="page-subtitle">Autonomous discovery, research, and resolution pipeline</p>
    </div>

    <!-- Daily report -->
    <div class="stat-grid" id="agent-stats">
      ${[1,2,3,4].map(() => `<div class="stat-card"><div class="skeleton" style="height:12px;width:80px;margin-bottom:10px"></div><div class="skeleton" style="height:28px;width:60px"></div></div>`).join('')}
    </div>

    <!-- Pipeline status -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div class="card" style="padding:20px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:14px;font-size:13.5px">Agent Pipeline</div>
        <div id="pipeline-status">
          ${['Discovery', 'Validation', 'Keeper', 'Resolution'].map(step => `
            <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">
              <div class="dot dot-blue"></div>
              <span style="font-size:13px;color:var(--ink-2)">${step}</span>
              <span style="margin-left:auto;font-size:11px;color:var(--subtle)" id="step-${step.toLowerCase()}">—</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card" style="padding:20px">
        <div style="font-weight:600;color:var(--ink);margin-bottom:14px;font-size:13.5px">Today's Activity</div>
        <div id="daily-activity">
          <div class="skeleton" style="height:100px"></div>
        </div>
      </div>
    </div>

    <!-- Recent runs -->
    <div class="card">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-weight:600;color:var(--ink)">Agent Run History</span>
        <div style="display:flex;gap:6px">
          <select class="select" id="run-type-filter" style="font-size:12px;padding:5px 24px 5px 8px">
            <option value="all">All types</option>
            <option value="discovery">Discovery</option>
            <option value="resolution">Resolution</option>
            <option value="keeper">Keeper</option>
          </select>
          <button class="btn btn-sm btn-ghost" id="refresh-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
        </div>
      </div>
      <div id="runs-list"></div>
    </div>
  `;

  container.querySelector('#run-type-filter').addEventListener('change', (e) => loadRuns(e.target.value));
  container.querySelector('#refresh-btn').addEventListener('click', () => loadAll());

  async function loadAll() {
    const [reportResult, runsResult] = await Promise.allSettled([
      api.dailyReport(),
      api.agentRuns({ limit: 30 }),
    ]);

    // Stats
    const stats = container.querySelector('#agent-stats');
    if (reportResult.status === 'fulfilled') {
      const r = reportResult.value;
      stats.innerHTML = `
        <div class="stat-card">
          <div class="stat-label">Status</div>
          <div style="display:flex;align-items:center;gap:7px;margin-top:4px">
            <div class="dot ${r.currentStatus === 'running' ? 'dot-green pulse' : 'dot-blue'}"></div>
            <span style="font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--ink)">${r.currentStatus === 'running' ? 'Running' : 'Idle'}</span>
          </div>
          ${r.currentRunType ? `<div class="stat-subtext">${r.currentRunType}</div>` : ''}
        </div>
        <div class="stat-card">
          <div class="stat-label">Runs Today</div>
          <div class="stat-value">${r.runsToday}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Markets Published</div>
          <div class="stat-value">${r.marketsPublishedToday}</div>
          <div class="stat-subtext">Today</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Resolved Today</div>
          <div class="stat-value">${r.marketsResolvedToday}</div>
        </div>
      `;

      // Daily activity
      const activity = container.querySelector('#daily-activity');
      activity.innerHTML = r.lastRun ? `
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Last run: ${formatDateTime(r.lastRun.startedAt)}</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${r.lastRun.type === 'discovery' ? `
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Considered</span><span style="color:var(--ink)">${r.lastRun.marketsConsidered || 0}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Published</span><span style="color:var(--success)">${r.lastRun.marketsPublished || 0}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Rejected</span><span style="color:var(--danger)">${r.lastRun.marketsRejected || 0}</span>
            </div>
          ` : r.lastRun.type === 'resolution' ? `
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Checked</span><span style="color:var(--ink)">${r.lastRun.marketsChecked || 0}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Resolved</span><span style="color:var(--success)">${r.lastRun.marketsResolved || 0}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--muted)">Unresolvable</span><span style="color:var(--warning)">${r.lastRun.marketsUnresolvable || 0}</span>
            </div>
          ` : `<div style="font-size:12px;color:var(--muted)">Type: ${r.lastRun.type}</div>`}
        </div>
      ` : `<p style="font-size:12px;color:var(--subtle)">No runs today yet.</p>`;
    }

    loadRuns('all');
  }

  async function loadRuns(type = 'all') {
    const list = container.querySelector('#runs-list');
    list.style.opacity = '0.5';
    try {
      const params = type !== 'all' ? { type, limit: 30 } : { limit: 30 };
      const { runs = [] } = await api.agentRuns(params);
      list.style.opacity = '1';

      if (!runs.length) {
        list.innerHTML = `<div class="empty-state" style="padding:40px"><h3>No agent runs yet</h3><p>The agent will run automatically on its schedule.</p></div>`;
        return;
      }

      list.innerHTML = `
        <div class="table-wrap" style="border:none;border-radius:0">
          <table>
            <thead><tr>
              <th>Type</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Details</th>
              <th>Errors</th>
            </tr></thead>
            <tbody>
              ${runs.map(run => {
                const duration = run.completedAt ? Math.round((new Date(run.completedAt) - new Date(run.startedAt)) / 1000) : null;
                const statusColor = { completed: 'var(--success)', failed: 'var(--danger)', running: 'var(--accent)', skipped: 'var(--warning)' }[run.status] || 'var(--muted)';

                let details = '—';
                if (run.type === 'discovery') details = `${run.marketsPublished || 0} published / ${run.marketsConsidered || 0} considered`;
                else if (run.type === 'resolution') details = `${run.marketsResolved || 0} resolved, ${run.marketsRefunded || 0} refunded`;
                else if (run.type === 'keeper') details = `${run.dbSynced || 0} synced, ${run.tradingClosed || 0} closed`;

                return `<tr>
                  <td style="font-weight:600;text-transform:capitalize;color:var(--ink)">${run.type}</td>
                  <td><span style="color:${statusColor};font-size:12px;font-weight:600;text-transform:capitalize">${run.status}</span></td>
                  <td style="font-size:12px;color:var(--muted)">${formatDateTime(run.startedAt)}</td>
                  <td style="font-size:12px;color:var(--muted)">${duration !== null ? duration + 's' : run.status === 'running' ? '<span class="pulse">…</span>' : '—'}</td>
                  <td style="font-size:12px;color:var(--ink-2)">${details}</td>
                  <td style="font-size:12px;color:${(run.errors?.length || 0) > 0 ? 'var(--danger)' : 'var(--muted)'}">${run.errors?.length || 0}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      list.style.opacity = '1';
      list.innerHTML = `<div class="empty-state"><p style="color:var(--danger)">${err.message}</p></div>`;
    }
  }

  loadAll();
}

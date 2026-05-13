import type { DashboardSnapshot } from "../status-dashboard/index.js";

/**
 * Server-renders the dashboard HTML with the current snapshot inlined, then
 * the page subscribes to /events (SSE) for real-time updates. Minimal CSS,
 * no client-side framework — just vanilla JS to swap inner content on each
 * SSE message.
 */
export function renderDashboardHtml(initial: DashboardSnapshot): string {
  const initialJson = escapeHtmlForScript(JSON.stringify(initial));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cognit Flow · Status</title>
<style>
  body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 12px; color: #f0f6fc; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; }
  .card .label { color: #8b949e; text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
  .card .value { font-size: 22px; font-weight: 600; color: #f0f6fc; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; }
  th { color: #8b949e; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; background: #0d1117; }
  tr:last-child td { border-bottom: none; }
  td.state { color: #58a6ff; }
  .section { margin-top: 24px; }
  .empty { padding: 20px; color: #6e7681; font-style: italic; }
  .footer { color: #6e7681; font-size: 12px; margin-top: 32px; }
  code { background: #21262d; padding: 1px 6px; border-radius: 4px; color: #c9d1d9; }
</style>
</head>
<body>
<h1>Cognit Flow · Status</h1>
<div id="dashboard"></div>
<div class="footer">Updated <span id="updated"></span> · <code id="conn-status">connecting…</code></div>

<script>
const initial = ${initialJson};

function render(snap) {
  const m = snap.metrics;
  const running = snap.orchestrator.running;
  const retries = snap.orchestrator.retries;

  const cards = \`
    <div class="grid">
      <div class="card"><div class="label">Running</div><div class="value">\${m.runningCount}</div></div>
      <div class="card"><div class="label">Completed</div><div class="value">\${m.completedCount}</div></div>
      <div class="card"><div class="label">Retries</div><div class="value">\${m.retriesCount}</div></div>
      <div class="card"><div class="label">Claimed</div><div class="value">\${m.claimedCount}</div></div>
    </div>\`;

  const runningRows = running.length === 0
    ? '<div class="empty">No agents running.</div>'
    : \`<table><thead><tr>
         <th>Identifier</th><th>State</th><th>Started</th><th>Workspace</th><th>Last event</th>
       </tr></thead><tbody>\${running.map(r => \`
         <tr>
           <td>\${esc(r.identifier)}</td>
           <td class="state">\${esc(r.state)}</td>
           <td>\${formatTime(r.startedAt)}</td>
           <td>\${esc(r.workspacePath ?? '—')}</td>
           <td>\${esc(r.lastEvent ?? '—')}</td>
         </tr>\`).join('')}
       </tbody></table>\`;

  const retryRows = retries.length === 0
    ? '<div class="empty">No retries scheduled.</div>'
    : \`<table><thead><tr>
         <th>Identifier</th><th>Attempt</th><th>Due in</th><th>Error</th>
       </tr></thead><tbody>\${retries.map(r => \`
         <tr>
           <td>\${esc(r.identifier)}</td>
           <td>\${r.attempt}</td>
           <td>\${(r.dueInMs / 1000).toFixed(1)}s</td>
           <td>\${esc(r.error ?? '—')}</td>
         </tr>\`).join('')}
       </tbody></table>\`;

  document.getElementById('dashboard').innerHTML =
    cards +
    '<div class="section"><h1>Running agents</h1>' + runningRows + '</div>' +
    '<div class="section"><h1>Retry queue</h1>' + retryRows + '</div>';

  document.getElementById('updated').textContent = formatTime(snap.generatedAt);
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function formatTime(iso) { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } }

render(initial);

const es = new EventSource('/events');
es.onopen = () => { document.getElementById('conn-status').textContent = 'connected'; };
es.onerror = () => { document.getElementById('conn-status').textContent = 'reconnecting…'; };
es.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
</script>
</body>
</html>`;
}

function escapeHtmlForScript(json: string): string {
  // Prevent </script> in JSON payloads from breaking out of the inline script.
  return json.replace(/<\/script/gi, "<\\/script");
}

import { telemetry } from './telemetry.js';
import { cyan, dim, fitLine } from './tui-style.js';

/** @param {string} title @param {string[]} content @param {number} width @param {number} height */
export function panel(title, content, width, height) {
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 5))}╮`;
  const rows = Array.from({ length: Math.max(0, height - 2) }, (_, i) => `${dim('│')}${fitLine(content[i] ?? '', width - 2)}${dim('│')}`);
  return [cyan(top), ...rows, dim(`╰${'─'.repeat(width - 2)}╯`)];
}

/** Responsive dashboard panels. Rendering has no I/O or persistence effects.
 * @param {import('./tui.js').TUI} tui @param {number} width @param {number} height
 * @returns {string[]}
 */
export function dashboard(tui, width, height) {
  const view = telemetry(tui.am.getStatus());
  if (height < 8) return panel('Accounts', view.accounts.slice(0, height - 2).map(account => ` ${account.name} · ${account.auth} · ${account.status}`), width, height);
  const wide = width >= 110;
  const accountWidth = wide ? Math.floor(width * 0.69) : width;
  const telemetryHeight = !wide && height >= 14 ? 5 : 0;
  const panelHeight = Math.max(5, height - 6 - telemetryHeight);
  const capacity = Math.max(1, panelHeight - 3);
  const focus = tui.mode === 'select' ? tui.selIdx : tui.am.currentIndex;
  const start = Math.max(0, Math.min(focus - capacity + 1, view.accounts.length - capacity));
  const both = accountWidth >= 70;
  const barWidth = Math.max(5, Math.min(14, Math.floor((accountWidth - 68) / 2)));
  const rows = view.accounts.slice(start, start + capacity).map((_, i) => tui._renderAcct(start + i, barWidth, both));
  if (!rows.length) rows.push(' No accounts. Press a to add one.');
  if (view.accounts.length > capacity) rows.push(` Accounts ${start + 1}–${Math.min(start + capacity, view.accounts.length)} of ${view.accounts.length}`);
  let upper = panel('Accounts', rows, accountWidth, panelHeight);
  if (wide) {
    const metrics = [
      ` ${view.totals.inFlight} active attempts`,
      ` ${view.totals.requests} requests`,
      ` Tokens in  ${view.totals.input}`,
      ` Tokens out ${view.totals.output}`,
      '', ' Routing feedback',
      ...view.accounts.filter(account => account.adaptive?.samples).slice(0, 3).map(account => ` ${account.name}: ${Math.round(account.adaptive.latencyMs)}ms / ${(account.adaptive.failureRate * 100).toFixed(0)}% fail`),
      '', ' Pools',
      ...view.pools.flatMap(pool => [` ${pool.name} · ${pool.strategy}`, ` ${pool.members.length} accounts / ${pool.totals.requests} requests`]),
    ];
    const side = panel('Telemetry', metrics, width - accountWidth, panelHeight);
    upper = upper.map((line, i) => line + side[i]);
  }
  const active = [...tui.active.values()].map(request => ` ${request.method} ${request.path} → ${request.account ?? 'routing'} (${((Date.now() - request.started) / 1000).toFixed(1)}s)`);
  if (telemetryHeight) upper.push(...panel('Telemetry', [
    ` ${view.totals.requests} requests · ${view.totals.inFlight} active attempts`,
    ` Tokens in ${view.totals.input} / out ${view.totals.output}`,
    ` Pools: ${view.pools.map(pool => pool.name).join(', ')}`,
  ], width, telemetryHeight));
  const activity = [...active, ...tui.log.map(entry => ` ${entry.t} ${entry.msg}`)];
  return [...upper, ...panel(`Activity · ${tui.active.size} active`, activity, width, height - panelHeight - telemetryHeight)];
}

/** Scrollable usage content shares the dashboard frame and wraps long values.
 * @param {string[]} content @param {number} width @param {number} height @param {number} offset
 * @returns {{lines: string[], offset: number}}
 */
export function usagePanel(content, width, height, offset) {
  const inner = Math.max(1, width - 4);
  const wrapped = content.flatMap(line => {
    const characters = Array.from(line);
    if (!characters.length) return [''];
    const rows = [];
    for (let i = 0; i < characters.length; i += inner) rows.push(` ${characters.slice(i, i + inner).join('')}`);
    return rows;
  });
  const capacity = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(offset, wrapped.length - capacity));
  return { lines: panel('Usage · since proxy start', wrapped.slice(start, start + capacity), width, height), offset: start };
}

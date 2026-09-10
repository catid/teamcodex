import type { AccountManager } from '@teamcodex/proxy/account-manager';
interface Dashboard {
  am: AccountManager;
  mode: string;
  selIdx?: number;
  active: Map<number, { method: string | undefined; path: string | undefined; account?: string | null; started: number }>;
  log: { t: string; msg: string }[];
  _renderAcct(index: number, width: number, both: boolean): string;
}
import { telemetry } from '@teamcodex/core/telemetry';

import { cyan, dim, fitLine, plainText } from './style.ts';

export function panel(title: string, content: string[], width: number, height: number): string[] {
  const top = `╭─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 5))}╮`;
  const rows = Array.from({ length: Math.max(0, height - 2) }, (_, i) => `${dim('│')}${fitLine(content[i] ?? '', width - 2)}${dim('│')}`);
  return [cyan(top), ...rows, dim(`╰${'─'.repeat(width - 2)}╯`)];
}

export function dashboard(tui: Dashboard, width: number, height: number): string[] {
  const view = telemetry(tui.am.getStatus());
  if (height < 8) return panel('Accounts', view.accounts.slice(0, height - 2).map(account => plainText(` ${account.name} · ${account.auth} · ${account.status}`)), width, height);
  const wide = width >= 110;
  const accountWidth = wide ? Math.floor(width * 0.69) : width;
  const telemetryHeight = !wide && height >= 14 ? 5 : 0;
  const panelHeight = Math.max(5, height - 6 - telemetryHeight);
  const capacity = Math.max(1, panelHeight - 3);
  const focus = tui.mode === 'select' ? tui.selIdx ?? 0 : tui.am.currentIndex;
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
      ...view.accounts.filter(account => account.adaptive?.samples).slice(0, 3).map(account => ` ${plainText(account.name)}: ${Math.round(account.adaptive.latencyMs)}ms / ${(account.adaptive.failureRate * 100).toFixed(0)}% fail`),
      '', ' Pools',
      ...view.pools.flatMap(pool => [` ${plainText(pool.name)} · ${plainText(pool.strategy)}`, ` ${pool.members.length} accounts / ${pool.totals.requests} requests`]),
    ];
    const side = panel('Telemetry', metrics, width - accountWidth, panelHeight);
    upper = upper.map((line, i) => `${line}${side[i] ?? ''}`);
  }
  const active = [...tui.active.values()].map(request => plainText(` ${request.method} ${request.path} → ${request.account ?? 'routing'} (${((Date.now() - request.started) / 1000).toFixed(1)}s)`));
  if (telemetryHeight) upper.push(...panel('Telemetry', [
    ` ${view.totals.requests} requests · ${view.totals.inFlight} active attempts`,
    ` Tokens in ${view.totals.input} / out ${view.totals.output}`,
    ` Pools: ${view.pools.map(pool => plainText(pool.name)).join(', ')}`,
  ], width, telemetryHeight));
  const activity = [...active, ...tui.log.map(entry => plainText(` ${entry.t} ${entry.msg}`))];
  return [...upper, ...panel(`Activity · ${tui.active.size} active`, activity, width, height - panelHeight - telemetryHeight)];
}

export function usagePanel(content: string[], width: number, height: number, offset: number): { lines: string[]; offset: number } {
  const inner = Math.max(1, width - 4);
  const wrapped = content.flatMap(line => {
    const characters = Array.from(plainText(line));
    if (!characters.length) return [''];
    const rows = [];
    for (let i = 0; i < characters.length; i += inner) rows.push(` ${characters.slice(i, i + inner).join('')}`);
    return rows;
  });
  const capacity = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(offset, wrapped.length - capacity));
  return { lines: panel('Usage · since proxy start', wrapped.slice(start, start + capacity), width, height), offset: start };
}

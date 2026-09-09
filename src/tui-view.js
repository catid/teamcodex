import { accountStatus } from './account-status.js';
import { telemetry } from './telemetry.js';
import { dashboard, usagePanel } from './tui-panels.js';
import { bar,bold, cyan, dim, ESC, fitLine, gray, green, plainText, red, rpad, vw, yellow } from './tui-style.js';
import { usageLines } from './usage-view.js';

export function render() {
  if (!this.running) return;
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;

  if (W < 40 || H < 8) {
    const messages = ['Terminal too small', 'Minimum: 40 x 8', `Current: ${W} x ${H}`];
    const visible = messages.slice(0, H).map(line => line.slice(0, Math.max(0, W - 1)));
    const top = Math.floor((H - visible.length) / 2);
    const output = visible.map((line, index) => `${ESC}${top + index + 1};${Math.floor((W - line.length) / 2) + 1}H${line}`).join('');
    process.stdout.write(`${ESC}?25l${ESC}0m${ESC}H${ESC}2J${output}`);
    return;
  }

  const lines = [];

  // ── Header
  const left = bold(' TeamCodex');
  const port = this.config.proxy?.port || 1456;
  const oauthAccounts = telemetry(this.am.getStatus()).accounts.filter(account => account.auth === 'OAuth');
  const known = oauthAccounts.filter(account => account.resets != null);
  const resetCount = known.reduce((total, account) => total + account.resets, 0);
  const resets = oauthAccounts.length ? `${resetCount}${known.length < oauthAccounts.length ? ' + ?' : ''}` : '—';
  const right = W >= 70 ? `Resets available ${cyan(resets)}  ·  Port ${port} ${green('▲')} ` : `Resets ${cyan(resets)} `;
  lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
  lines.push(` ${  dim('─'.repeat(W - 2))}`);

  if (this.mode === 'usage') {
    const result = usagePanel(usageLines(this.am.getStatus()).slice(2), W, H - 4, this.usageOffset);
    this.usageOffset = result.offset;
    lines.push(...result.lines);
  } else lines.push(...dashboard(this, W, H - 4));

  // ── Footer
  lines.push(` ${  dim('─'.repeat(W - 2))}`);
  lines.push(this._renderFooter());

  // Write buffer
  let buf = `${ESC}H`;
  for (let i = 0; i < H; i++) {
    buf += fitLine(lines[i] || '', W);
    if (i < H - 1) buf += '\r\n';
  }
  // Show cursor only in input mode
  buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
  process.stdout.write(buf);
}

export function renderAccount(idx, bw, showBoth) {
  const a = this.am.accounts[idx];
  const isCur = idx === this.am.currentIndex;
  const isSel = this.mode === 'select' && idx === this.selIdx;

  // Prefix: selection marker + current marker
  const sel = isSel ? cyan('>') : ' ';
  const cur = isCur ? green('►') : ' ';

  // Name (bold if selected)
  const rawName = plainText(a.name).slice(0, 12).padEnd(12);
  const name = isSel ? bold(rawName) : rawName;

  // Type — show plan for ChatGPT accounts
  const typeLabel = a.type === 'chatgpt' ? 'OAuth' : 'API key';
  const type = gray(typeLabel.slice(0, 7).padEnd(7));

  // Status
  let status;
  switch (accountStatus(a)) {
    case 'disabled': status = gray('disabled'); break;
    case 'refreshing': status = cyan('refreshing'); break;
    case 'active':    status = isCur ? green('active') : 'active'; break;
    case 'throttled': status = yellow('throttled'); break;
    case 'exhausted': status = red('exhausted'); break;
    case 'error':     status = red('auth error'); break;
    default:          status = plainText(a.status || 'ready');
  }
  status = rpad(status, 10);

  // Quota ratios — Codex windows (ChatGPT) or standard limits (API key)
  const q = a.quota;
  let r1, r2, t1, t2;
  let l1 = '5h ', l2 = 'Wk ';

  if (a.type === 'chatgpt') {
    r1 = q.primary;
    r2 = q.secondary;
    t1 = q.primaryReset;
    t2 = q.secondaryReset;
  } else {
    l1 = 'Tok';
    l2 = 'Req';
    r1 = (q.tokensLimit != null && q.tokensRemaining != null)
      ? 1 - q.tokensRemaining / q.tokensLimit : null;
    r2 = (q.requestsLimit != null && q.requestsRemaining != null)
      ? 1 - q.requestsRemaining / q.requestsLimit : null;
    t1 = q.resetsAt;
    t2 = t1;
  }

  let line = ` ${sel}${cur} ${name} ${type} ${status} ${l1} ${bar(r1, bw, t1)}`;
  if (showBoth) {
    const count = a.type === 'chatgpt' ? (a.usageReset.availableCredits ?? '?') : '—';
    const credits = a.type === 'chatgpt' && a.usageReset.availableCredits > 0 ? cyan(count) : gray(count);
    line += `  ${l2} ${bar(r2, bw, t2)}  Resets ${credits}`;
  }
  return line;
}

export function renderFooter() {
  switch (this.mode) {
    case 'usage': return ' ↑↓ scroll  u/Esc back';
    case 'normal': {
      if ((process.stdout.columns || 80) < 70) return ` u usage  ${this.am.routing ? '' : 's switch  '}a add  r remove  R reload  q quit`;
      const switchAction = this.am.routing ? '' : `${bold('s')}witch  `;
      return ` ${bold('u')}sage  ${switchAction}${bold('a')}dd  ${bold('r')}emove  ${bold('R')}eload  ${bold('q')}uit`;
    }
    case 'select': {
      const act = this.selAction === 'switch' ? 'switch' : 'remove';
      return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
    }
    case 'add':
      return ' k API key  o OAuth browser  d Device code  i Import  Esc cancel';
    case 'input':
      return ` ${this.inputPrompt}: ${'*'.repeat(this.inputBuf.length)}█`;
    default:
      return '';
  }
}

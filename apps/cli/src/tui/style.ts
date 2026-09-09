// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = (s: string | number) => `${BOLD}${s}${RESET}`;
const dim = (s: string | number) => `${DIM}${s}${RESET}`;
const fg = (c: number, s: string | number) => `${ESC}${c}m${s}${RESET}`;
const green = (s: string | number) => fg(32, s);
const yellow = (s: string | number) => fg(33, s);
const red = (s: string | number) => fg(31, s);
const cyan = (s: string | number) => fg(36, s);
const gray = (s: string | number) => fg(90, s);

// eslint-disable-next-line no-control-regex -- Match ANSI escape sequences for terminal display width.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI_RE, '');
const vw = (s: string) => strip(s).length;

function rpad(s: string, w: number): string {
  const gap = w - vw(s);
  return gap > 0 ? `${s}${' '.repeat(gap)}` : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
function truncate(s: string, w: number): string {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return `${out}${RESET}`;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
function fitLine(s: string, w: number): string {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return `${s}${' '.repeat(w - v)}`;
  return s;
}

function formatReset(resetTs: number | null | undefined): string {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "2h30m" or "45%") is drawn on top of the bar.
 */
function bar(ratio: number | null | undefined, w = 10, resetTs?: number | null): string {
  const rst = formatReset(resetTs);

  if (typeof ratio !== 'number' || Number.isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = rst || '-';
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  // Background colors: 42=green, 43=yellow, 41=red; 100=bright black (gray) for empty
  const bg = ratio < 0.7 ? 42 : ratio < 0.9 ? 43 : 41;

  // Build the label to overlay: show reset time if available, else percentage
  const pct = `${(ratio * 100).toFixed(0)  }%`;
  const label = rst || pct;
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = `${' '.repeat(lp)}${text}${' '.repeat(rp)}`;

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};97m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}


export { bar,bold, cyan, dim, ESC, fitLine, gray, green, red, rpad, SPINNER, vw, yellow };

import type { AccountConfig, Config } from '@teamcodex/core/config';
import type { AccountManager } from '@teamcodex/proxy/account-manager';
import type { RequestInfo } from '@teamcodex/proxy/http/types';

interface TuiOptions {
  accountManager: AccountManager;
  config: Config;
  saveConfig: (change: { upsert: AccountConfig } | { remove: { name: string; accountId?: string | null } }) => Promise<unknown>;
  syncAccounts: (options?: { removeMissing?: boolean }) => Promise<{ added?: number; updated?: number } | void>;
  onQuit?: () => void;
}
interface ActiveRequest extends RequestInfo { t: string; started: number; account: string | null }

import { spawn } from 'node:child_process';

import { errorMessage } from '@teamcodex/core/errors';
import { accountInfoFromTokens,importCredentials } from '@teamcodex/proxy/auth/tokens';

import { ESC, SPINNER } from './style.ts';
import { render, renderAccount, renderFooter } from './view.ts';

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  readonly am: AccountManager;
  readonly config: Config;
  private readonly saveConfig: TuiOptions['saveConfig'];
  private readonly syncAccounts: TuiOptions['syncAccounts'];
  private readonly onQuit: (() => void) | undefined;
  log: { t: string; msg: string }[] = [];
  active = new Map<number, ActiveRequest>();
  usageOffset = 0;
  mode: 'normal' | 'select' | 'add' | 'input' | 'usage' = 'normal';
  selAction: 'switch' | 'remove' | null = null;
  selIdx = 0;
  inputPrompt = '';
  inputBuf = '';
  private inputCb: ((value: string) => void) | null = null;
  frame = 0;
  running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _origLog: typeof console.log | null = null;
  private _origErr: typeof console.error | null = null;
  private _dataHandler: ((data: string) => void) | undefined;
  private _resizeHandler: (() => void) | undefined;
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit }: TuiOptions) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;


  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; if (this._origErr) console.error = this._origErr; }
    if (this._dataHandler) process.stdin.removeListener('data', this._dataHandler);
    if (this._resizeHandler) process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch { /* stdin may no longer be a TTY. */ }
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id: number, info: RequestInfo) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id: number, info: { account: string }) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  onRequestEnd(id: number, info: RequestInfo & { account: string | null; status: number | null }) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
  }

  _addLog(msg: string) {
    msg = msg.replace(/^\[TeamCodex\]\s*/, '');
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
  }

  // ── input handling ─────────────────────────────────

  _onData(d: string) {
    if (this.mode === 'input' && d.length > 1 && !d.includes('\x1b')) {
      for (const ch of d) if (ch >= ' ') this._key(ch);
      return;
    }
    const keys: Record<string, string> = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b': 'esc', '\r': 'enter', '\n': 'enter', '\x03': 'ctrl-c', '\x7f': 'bs', '\x08': 'bs' };
    // PTYs may deliver several keypresses in one chunk. Keep CSI sequences intact.
    // eslint-disable-next-line no-control-regex -- Decode terminal keyboard sequences.
    for (const ch of d.match(/\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu) || []) {
      const key = keys[ch];
      if (key) this._key(key);
      else if (ch.length === 1 && ch >= ' ') this._key(ch);
    }
  }

  _key(k: string) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'usage':
        if (['esc', 'u', 'q'].includes(k)) this.mode = 'normal';
        else if (['down', 'j'].includes(k)) this.usageOffset++;
        else if (['up', 'k'].includes(k)) this.usageOffset = Math.max(0, this.usageOffset - 1);
        break;
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
    }
    this.render();
  }

  _keyNormal(k: string) {
    if (k === 'q') { this.stop(); this.onQuit?.(); }
    else if (k === 's' && this.am.accounts.length > 0) {
      if (this.am.routing) { this._addLog(errorMessage('TUI_SWITCH_POOLED')); return; }
      this.mode = 'select'; this.selAction = 'switch'; this.selIdx = this.am.currentIndex;
    }
    else if (k === 'r' && this.am.accounts.length > 0) {
      this.mode = 'select'; this.selAction = 'remove'; this.selIdx = 0;
    }
    else if (k === 'u') { this.mode = 'usage'; this.usageOffset = 0; }
    else if (k === 'a') { this.mode = 'add'; }
    else if (k === 'R') { this._doSync(); }
  }

  _keySelect(k: string) {
    if (this.selAction === 'switch' && this.am.routing) {
      this.mode = 'normal';
      this._addLog(errorMessage('TUI_SWITCH_POOLED'));
      return;
    }
    const len = this.am.accounts.length;
    if (!len) { this.mode = 'normal'; return; }
    this.selIdx = Math.min(this.selIdx, len - 1);
    if (k === 'up' || k === 'k') this.selIdx = Math.max(0, this.selIdx - 1);
    else if (k === 'down' || k === 'j') this.selIdx = Math.min(len - 1, this.selIdx + 1);
    else if (k === 'enter') {
      if (this.selAction === 'switch') {
        this.am.currentIndex = this.selIdx;
        this._addLog(`Switched to "${this.am.accounts[this.selIdx]?.name ?? ''}"`);
      } else {
        this._doRemove(this.selIdx).catch(e => this._addLog(errorMessage('TUI_REMOVE_FAILED', { message: (e instanceof Error ? e.message : String(e)) })));
      }
      this.mode = 'normal';
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyAdd(k: string) {
    if (k === 'i') { this._doImport(); this.mode = 'normal'; }
    else if (k === 'o' || k === 'd') { void this._doLogin(k === 'o' ? '--browser' : '--device-auth'); }
    else if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doAddKey(v).catch(e => this._addLog(errorMessage('TUI_ADD_FAILED', { message: (e instanceof Error ? e.message : String(e)) }))); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyInput(k: string) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = '';
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      const { added = 0, updated = 0 } = await this.syncAccounts({ removeMissing: true }) || {};
      if (added > 0) {
        this._addLog(`Synced ${added} new account(s) from config`);
      } else if (updated > 0) {
        this._addLog(`Updated ${updated} account(s)`);
      } else {
        this._addLog('Config reloaded, no account changes');
      }
    } catch (e) {
      this._addLog(errorMessage('TUI_SYNC_FAILED', { message: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async _doLogin(method: '--browser' | '--device-auth') {
    this.mode = 'normal';
    this.stop();
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [process.argv[1] ?? '', 'login', method], { stdio: 'inherit', env: process.env });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code === 0) await this.syncAccounts();
    } catch (error) {
      this._addLog(errorMessage('OAUTH_LOGIN_FAILED', { message: (error instanceof Error ? error.message : String(error)) }));
    } finally { this.start(); }
  }

  async _doImport() {
    try {
      this._addLog('Importing credentials from Codex CLI...');
      const creds = await importCredentials();
      const info = accountInfoFromTokens(creds);

      let name;
      if (info.email) {
        name = info.email;
        if (info.planType) this._addLog(`Detected ChatGPT ${info.planType}: ${name}`);
      } else {
        const n = this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
        name = `account-${n}`;
      }

      const entry: AccountConfig = {
        name, type: 'chatgpt', source: 'import',
        accountId: info.accountId,
        planType: info.planType,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        idToken: creds.idToken,
        expiresAt: creds.expiresAt,
      };

      await this.saveConfig({ upsert: entry });
      await this.syncAccounts();
      this._addLog(`Imported account "${name}"`);
    } catch (e) {
      this._addLog(errorMessage('TUI_IMPORT_FAILED', { message: (e instanceof Error ? e.message : String(e)) }));
    }
  }

  async _doAddKey(apiKey: string) {
    let n = 1;
    while (this.config.accounts.some(a => a.name === `api-${n}`)) n++;
    const name = `api-${n}`;
    await this.saveConfig({ upsert: { name, type: 'apikey', apiKey: apiKey.trim() } });
    await this.syncAccounts();
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx: number) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const account = this.am.accounts[idx];
    if (!account) return;
    const name = account.name;
    await this.saveConfig({ remove: account });
    await this.syncAccounts({ removeMissing: true });
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    this._addLog(`Removed account "${name}"`);
  }

  // ── rendering ──────────────────────────────────────

  render() { return render.call(this); }
  _renderAcct(index: number, width: number, both: boolean) { return renderAccount.call(this, index, width, both); }
  _renderFooter() { return renderFooter.call(this); }
}

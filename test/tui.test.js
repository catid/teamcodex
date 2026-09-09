import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { dashboard, usagePanel } from '../src/tui-panels.js';

const accounts = ['first', 'second'].map(name => ({ name, type: 'apikey', apiKey: 'fake' }));
const routing = { defaultPool: 'main', pools: { main: { accounts: ['first', 'second'], strategy: 'failover' } } };

test('coalesced terminal keypresses preserve selection navigation', () => {
  const manager = new AccountManager(Array.from({ length: 35 }, (_, i) => ({ ...accounts[0], name: `account-${i}` })));
  manager.currentIndex = 0;
  const tui = new TUI({ accountManager: manager, config: {} });
  tui._onData(`s${'j'.repeat(34)}`);
  assert.equal(tui.selIdx, 34);
  tui._onData('\x1b[A\x1b[A\x1b[B\r');
  assert.equal(manager.currentIndex, 33);
  assert.equal(tui.mode, 'normal');
});

test('external account, activity, log and usage text cannot emit terminal controls', () => {
  const malicious = 'x\x1b]52;c;dGVzdA==\x07\x1b[2J\r\n\u202ey';
  const manager = new AccountManager([{ ...accounts[0], name: malicious }]);
  const tui = new TUI({ accountManager: manager, config: {} });
  tui.onRequestStart(1, { method: 'POST', path: malicious });
  tui.onRequestRouted(1, { account: malicious });
  tui._addLog(malicious);
  const output = [tui._renderAcct(0, 8, true), ...usagePanel([malicious], 50, 10, 0).lines];
  for (const [width, height] of [[40, 7], [80, 24], [140, 30]]) output.push(...dashboard(tui, width, height));
  // Generated SGR styles remain valid, but no other controls may reach the terminal.
  // eslint-disable-next-line no-control-regex -- Validate terminal control filtering.
  const unstyled = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
  // eslint-disable-next-line no-control-regex -- Validate terminal control filtering.
  assert.doesNotMatch(unstyled, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(unstyled, /dGVzdA==/);
});

test('manual switching remains available without pools', () => {
  const manager = new AccountManager(accounts);
  manager.currentIndex = 0;
  const tui = new TUI({ accountManager: manager, config: {} });
  assert.match(stripVTControlCharacters(tui._renderFooter()), /switch/);
  tui._key('s');
  tui._key('down');
  tui._key('enter');
  assert.equal(manager.getActiveAccount().name, 'second');
  assert.match(tui.log[0].msg, /Switched to "second"/);
});

test('pool routing hides manual switching and explains an attempted shortcut', () => {
  const manager = new AccountManager(accounts, 0.98, routing);
  manager.currentIndex = 0;
  const tui = new TUI({ accountManager: manager, config: {} });
  assert.doesNotMatch(stripVTControlCharacters(tui._renderFooter()), /switch/);
  tui._key('s');
  assert.equal(tui.mode, 'normal');
  assert.match(tui.log[0].msg, /routing pools/i);
  assert.equal(manager.currentIndex, 0);
});

test('enabling pools while a switch menu is open cannot claim a manual switch', () => {
  const manager = new AccountManager(accounts);
  manager.currentIndex = 0;
  const tui = new TUI({ accountManager: manager, config: {} });
  tui._key('s');
  tui._key('down');
  manager.routing = routing;
  tui._key('enter');
  assert.equal(tui.mode, 'normal');
  assert.equal(manager.currentIndex, 0);
  assert.doesNotMatch(tui.log.map(entry => entry.msg).join('\n'), /Switched to/);
  assert.match(tui.log[0].msg, /routing pools/i);
});

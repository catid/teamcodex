import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManualAuthInput } from '../src/oauth.js';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

test('pasted callback URLs enforce state and never swallow a mismatch', () => {
  assert.throws(() => parseManualAuthInput('http://localhost:1455/auth/callback?code=abc&state=wrong', 'expected'), /state mismatch/);
  assert.throws(() => parseManualAuthInput('http://localhost:1455/auth/callback?code=abc', 'expected'), /state mismatch/);
  assert.deepEqual(parseManualAuthInput('http://localhost:1455/auth/callback?code=abc&state=expected', 'expected'), { code: 'abc' });
  assert.deepEqual(parseManualAuthInput('abc', 'expected'), { code: 'abc' });
});

test('TUI accepts pasted API keys and masks the input display', () => {
  const tui = new TUI({ accountManager: new AccountManager([]), config: { accounts: [] } });
  tui.mode = 'input';
  tui._onData('sk-pasted-key');
  assert.equal(tui.inputBuf, 'sk-pasted-key');
  assert.ok(!tui._renderFooter().includes('sk-pasted-key'));
});

import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/update.py'
spec = importlib.util.spec_from_file_location('update', SCRIPT)
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='teamcodex update ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.checkout = self.root / 'installed checkout'
        self.log = self.root / 'commands.log'
        self.env = dict(os.environ, TEST_UPDATE_LOG=str(self.log), GIT_CONFIG_NOSYSTEM='1')
        self.git(self.root, 'init', '-q', '-b', 'main', str(self.source))
        self.git(self.source, 'config', 'user.email', 'test@example.invalid')
        self.git(self.source, 'config', 'user.name', 'Test')
        self.git(self.source, 'config', 'commit.gpgsign', 'false')
        self.publish('old')
        self.git(self.root, 'clone', '-q', str(self.source), str(self.checkout))
        self.git(self.checkout, 'config', 'user.email', 'test@example.invalid')
        self.git(self.checkout, 'config', 'user.name', 'Test')
        self.git(self.checkout, 'config', 'commit.gpgsign', 'false')

    def git(self, root, *args):
        return subprocess.run(['git', '-C', str(root), *args], env=self.env,
                              text=True, capture_output=True, check=True).stdout.strip()

    def publish(self, version):
        launcher = self.source / 'teamcodex.sh'
        launcher.write_text('#!/bin/sh\n'
                            f'printf "%s %s\\n" "{version}" "$*" >> "$TEST_UPDATE_LOG"\n'
                            'if [ "$1" = build ] && [ "${TEST_BUILD_FAIL:-0}" = 1 ]; then exit 7; fi\n'
                            'if [ "$1" = start ] && [ "${TEST_HEALTH_FAIL:-0}" = 1 ]; then exit 8; fi\n')
        launcher.chmod(0o755)
        self.git(self.source, 'add', 'teamcodex.sh')
        self.git(self.source, 'commit', '-qm', version)

    def invoke(self, **env):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.checkout)],
                              cwd=self.root, env=dict(self.env, **env),
                              text=True, capture_output=True, timeout=15)

    def test_fast_forward_uses_updated_launcher_and_preserves_untracked_files(self):
        self.publish('new')
        local = self.checkout / 'local notes.txt'
        local.write_text('keep me')
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('service is healthy', result.stdout)
        self.assertEqual(self.log.read_text().splitlines(), ['new build', 'new start --wait-timeout 120'])
        self.assertEqual(local.read_text(), 'keep me')
        self.assertEqual(self.git(self.checkout, 'rev-parse', 'HEAD'), self.git(self.source, 'rev-parse', 'HEAD'))

    def test_tracked_edits_stop_before_pull_or_build(self):
        self.publish('new')
        edited = self.checkout / 'teamcodex.sh'
        edited.write_text(edited.read_text() + '# local edit\n')
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('local changes', result.stderr)
        self.assertIn('# local edit', edited.read_text())
        self.assertFalse(self.log.exists())

    def test_diverged_branches_are_not_rewritten(self):
        self.publish('remote')
        note = self.checkout / 'local.txt'
        note.write_text('local commit')
        self.git(self.checkout, 'add', 'local.txt')
        self.git(self.checkout, 'commit', '-qm', 'local')
        before = self.git(self.checkout, 'rev-parse', 'HEAD')
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.git(self.checkout, 'rev-parse', 'HEAD'), before)
        self.assertFalse(self.log.exists())

    def test_failed_build_does_not_touch_running_service(self):
        self.publish('new')
        result = self.invoke(TEST_BUILD_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.log.read_text().splitlines(), ['new build'])
        self.assertNotIn('service is healthy', result.stdout)
        # The released lock permits retrying after a failed build.
        self.assertEqual(self.invoke().returncode, 0)

    def test_failed_health_check_is_reported(self):
        result = self.invoke(TEST_HEALTH_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('service is healthy', result.stdout)

    def test_concurrent_update_is_rejected(self):
        with (self.checkout / '.git/teamcodex-update.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already running', result.stderr)
        self.assertFalse(self.log.exists())

    def test_command_timeout_is_bounded(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            update.run(self.root, [sys.executable, '-c', 'import time; time.sleep(30)'], timeout=0.05)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Fast-forward this installation, build it, and wait for service health."""
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys


def run(root, args, timeout=120, capture=False):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0')
    if 'GIT_SSH_COMMAND' not in env and 'GIT_SSH' not in env:
        env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes -o ConnectTimeout=15'
    process = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE if capture else None,
                               text=True, start_new_session=True)
    try:
        stdout, _ = process.communicate(timeout=timeout)
    except BaseException:
        # Cancel the whole command, including Git's SSH or Docker's CLI child.
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        except ProcessLookupError:
            pass
        raise
    if process.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed (exit {process.returncode}); update stopped')
    return (stdout or '').strip()


def update(root):
    root = Path(root).resolve()
    git = ['git', '-C', str(root)]
    top = Path(run(root, [*git, 'rev-parse', '--show-toplevel'], capture=True)).resolve()
    if top != root:
        raise RuntimeError('The TeamCodex installation must be the root of its Git checkout')
    lock_path = Path(run(root, [*git, 'rev-parse', '--git-path', 'teamcodex-update.lock'], capture=True))
    if not lock_path.is_absolute():
        lock_path = root / lock_path
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('Another TeamCodex update is already running for this checkout') from exc
        if run(root, [*git, 'status', '--porcelain', '--untracked-files=no'], capture=True):
            raise RuntimeError('Tracked files have local changes. Commit or stash them before updating.')
        branch = run(root, [*git, 'symbolic-ref', '--quiet', '--short', 'HEAD'], capture=True)
        upstream = run(root, [*git, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], capture=True)
        print(f'Updating {branch} from {upstream} in {root}', flush=True)
        run(root, [*git, 'pull', '--ff-only'])
        revision = run(root, [*git, 'rev-parse', '--short', 'HEAD'], capture=True)
        # Use the newly downloaded launcher, not shell code loaded before pull.
        launcher = str(root / 'teamcodex.sh')
        print('Building the updated image; the existing service stays running during the build.', flush=True)
        run(root, [launcher, 'build'], timeout=600)
        print('Applying the image and waiting for service health.', flush=True)
        run(root, [launcher, 'start', '--wait-timeout', '120'], timeout=150)
        print(f'TeamCodex updated to {revision}; service is healthy.', flush=True)


def main():
    if len(sys.argv) != 2:
        print('Usage: teamcodex update', file=sys.stderr)
        return 2
    # Raising lets run() stop its child process group and release the lock.
    def terminated(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminated)
    try:
        update(sys.argv[1])
    except KeyboardInterrupt:
        print('TeamCodex update interrupted.', file=sys.stderr)
        return 130
    except subprocess.TimeoutExpired as exc:
        print(f'TeamCodex update timed out after {exc.timeout}s; update stopped.', file=sys.stderr)
        return 1
    except (OSError, RuntimeError) as exc:
        print(f'TeamCodex: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

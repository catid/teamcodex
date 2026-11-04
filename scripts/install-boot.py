#!/usr/bin/env python3
"""Install boot startup for the current user's Docker-backed TeamCodex checkout."""
import getpass
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
from errors import error_message
from boot import systemd_unit
import tempfile

root = Path(__file__).resolve().parent.parent
user = getpass.getuser()
user_home = Path.home()
path = str(user_home / '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'


def install_file(content, destination, mode='644'):
    with tempfile.TemporaryDirectory(prefix='teamcodex-boot-') as directory:
        file = Path(directory) / 'service'
        file.write_bytes(content)
        subprocess.run(['sudo', '-n', 'install', '-o', 'root', '-m', mode, str(file), destination], check=True)


if os.getuid() == 0:
    sys.exit(error_message('BOOT_USER_INVALID'))
if sys.platform.startswith('linux'):
    unit = systemd_unit(root, user, user_home, path)
    install_file(unit.encode(), '/etc/systemd/system/teamcodex.service')
    subprocess.run(['sudo', '-n', 'systemd-analyze', 'verify', '/etc/systemd/system/teamcodex.service'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'enable', 'docker.service'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'daemon-reload'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'enable', 'teamcodex.service'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'start', 'teamcodex.service'], check=True)
    subprocess.run(['sudo', '-n', 'systemctl', 'is-active', '--quiet', 'teamcodex.service'], check=True)
    print('Enabled teamcodex.service at boot')
elif sys.platform == 'darwin':
    if not shutil.which('colima'):
        sys.exit(error_message('BOOT_COLIMA_REQUIRED'))
    logs = user_home / 'Library/Logs/TeamCodex'
    logs.mkdir(parents=True, exist_ok=True)
    label = 'com.teamcodex.boot'
    job = {
        'Label': label,
        'UserName': user,
        'ProgramArguments': [sys.executable, str(root / 'scripts/start-at-boot.py')],
        'WorkingDirectory': str(root),
        'EnvironmentVariables': {'HOME': str(user_home), 'PATH': path},
        'RunAtLoad': True,
        'KeepAlive': {'SuccessfulExit': False},
        'ThrottleInterval': 30,
        'AbandonProcessGroup': True,
        'StandardOutPath': str(logs / 'boot.log'),
        'StandardErrorPath': str(logs / 'boot-error.log'),
    }
    destination = '/Library/LaunchDaemons/' + label + '.plist'
    install_file(plistlib.dumps(job), destination)
    subprocess.run(['sudo', '-n', 'launchctl', 'bootout', 'system/' + label], capture_output=True)
    subprocess.run(['sudo', '-n', 'launchctl', 'enable', 'system/' + label], check=True)
    subprocess.run(['sudo', '-n', 'launchctl', 'bootstrap', 'system', destination], check=True)
    print('Enabled com.teamcodex.boot LaunchDaemon (Colima, runs as ' + user + ')')
else:
    sys.exit(error_message('BOOT_PLATFORM_UNSUPPORTED'))

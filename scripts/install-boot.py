#!/usr/bin/env python3
"""Install boot startup for the current user's Docker-backed TeamCodex checkout."""
import getpass
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
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
    sys.exit('Run this installer as the account that owns TeamCodex; it uses sudo for the service definition.')
if sys.platform.startswith('linux'):
    # systemd treats percent signs as specifiers, even inside quotes.
    def quoted(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    unit = f'''[Unit]
Description=TeamCodex Docker proxy
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
User={user}
Environment={quoted('HOME=' + str(user_home))}
Environment={quoted('PATH=' + path)}
ExecStart={quoted(root / 'teamcodex.sh')} serve --wait-timeout 120
ExecStop={quoted(root / 'teamcodex.sh')} stop
TimeoutStartSec=180
TimeoutStopSec=30
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
'''
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
        sys.exit('Unattended macOS boot requires Colima. With Docker Desktop, enable its Start at login setting instead.')
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
    sys.exit('Supported platforms: Ubuntu Linux and macOS with Colima')

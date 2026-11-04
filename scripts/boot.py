"""Build boot service definitions for TeamCodex."""
from pathlib import Path


def systemd_unit(root, user, user_home, path):
    """Return the systemd unit that starts the user's TeamCodex service."""
    # systemd treats percent signs as specifiers, even inside quotes.
    def quoted(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'

    root = Path(root)
    return f'''[Unit]
Description=TeamCodex Docker proxy
Wants=docker.service
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

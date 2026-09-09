#!/usr/bin/env python3
"""Launch Colima and TeamCodex once; launchd retries failures after 30 seconds."""
from pathlib import Path
import subprocess
import sys

try:
    subprocess.run(['colima', 'start'], check=True, timeout=180)
    subprocess.run([str(Path(__file__).resolve().parent.parent / 'teamcodex.sh'),
                    'serve', '--wait-timeout', '120'], check=True, timeout=150)
except (OSError, subprocess.SubprocessError) as error:
    print('TeamCodex boot startup failed: ' + str(error), file=sys.stderr)
    sys.exit(1)

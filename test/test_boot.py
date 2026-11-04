import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/boot.py'
spec = importlib.util.spec_from_file_location('boot', SCRIPT)
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootTests(unittest.TestCase):
    def test_systemd_unit_keeps_docker_ordering_without_shutdown_coupling(self):
        unit = boot.systemd_unit('/home/catid/teamcodex', 'catid', '/home/catid', '/usr/bin:%HOME%')
        self.assertIn('Wants=docker.service\n', unit)
        self.assertNotIn('Requires=docker.service', unit)
        self.assertIn('After=docker.service network-online.target', unit)
        self.assertIn('ExecStart="/home/catid/teamcodex/teamcodex.sh" serve --wait-timeout 120', unit)
        self.assertIn('ExecStop="/home/catid/teamcodex/teamcodex.sh" stop', unit)
        self.assertIn('Environment="PATH=/usr/bin:%%HOME%%"', unit)


if __name__ == '__main__':
    unittest.main()

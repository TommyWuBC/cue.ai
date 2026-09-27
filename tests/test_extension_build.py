import json
import pathlib
import subprocess
import sys
import unittest
import zipfile


ROOT = pathlib.Path(__file__).resolve().parent.parent


class ExtensionBuildTests(unittest.TestCase):
    def test_build_contains_every_runtime_asset(self):
        subprocess.run([sys.executable, str(ROOT / 'tools/build-extension.py')],
                       cwd=ROOT, check=True, capture_output=True, text=True)
        archive = ROOT / 'dist/cue-extension-0.1.0.zip'
        with zipfile.ZipFile(archive) as package:
            self.assertIsNone(package.testzip())
            manifest = json.loads(package.read('manifest.json'))
            names = set(package.namelist())
            self.assertEqual(manifest['manifest_version'], 3)
            self.assertEqual(manifest['host_permissions'], ['http://localhost:4173/*'])
            self.assertEqual(manifest['optional_host_permissions'],
                             ['https://*/*'])
            self.assertFalse(manifest['web_accessible_resources'][0].get('use_dynamic_url', False))
            self.assertNotIn('default_popup', manifest['action'])
            self.assertEqual(manifest['action']['default_title'], 'Start Cue on this page')
            self.assertIn(manifest['background']['service_worker'], names)
            self.assertIn('extension/runtime.js', names)
            self.assertIn('extension/privacy.html', names)
            self.assertIn('vendor/models/facemesh/model.json', names)
            self.assertIn('vendor/models/facemesh/group1-shard1of1.bin', names)
            self.assertIn('client/aura.js', names)
            self.assertIn('client/analytics.js', names)
            self.assertIn('client/analytics.css', names)
            self.assertIn('client/analytics-store.js', names)
            self.assertIn('client/analytics-transport.js', names)
            self.assertIn('extension/demo-analytics.js', names)
            self.assertEqual(manifest['content_scripts'][0]['matches'], ['http://localhost:4173/*'])
            self.assertIn('client/avatar.js', names)
            self.assertIn('client/splash.js', names)
            self.assertIn('extension/assets/cue-splash.jpg', names)
            self.assertIn('extension/assets/cue-splash.jpg',
                          manifest['web_accessible_resources'][0]['resources'])
            self.assertTrue(package.read('extension/assets/cue-splash.jpg').startswith(b'\xff\xd8'))
            self.assertIn(b"import(chrome.runtime.getURL('client/avatar.js'))",
                          package.read('extension/content.js'))
            for icon in manifest['icons'].values():
                self.assertTrue(package.read(icon).startswith(b'\x89PNG\r\n\x1a\n'))

    def test_plain_http_remote_backend_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / 'tools/build-extension.py'),
             '--server-url', 'http://example.com'], cwd=ROOT,
            capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must use HTTPS', result.stderr)


if __name__ == '__main__':
    unittest.main()

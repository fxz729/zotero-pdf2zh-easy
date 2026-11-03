"""Local API must not accept browser requests or an unrelated port listener."""
import hashlib
import hmac
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class RuntimeSecurityTests(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from runtime.security import register_auth
        self.app = Flask(__name__)
        self.app.testing = True
        self.app.add_url_rule('/api/tasks', view_func=lambda: {'tasks': []}, methods=['GET', 'POST'])
        register_auth(self.app, 'a' * 64)
        self.client = self.app.test_client()
        self.base = 'http://127.0.0.1:8891'

    def test_health_proof_is_hmac_of_fresh_nonce_without_sending_secret(self):
        nonce = '01' * 16
        response = self.client.get('/health?challenge=' + nonce, base_url=self.base)
        self.assertEqual(response.status_code, 200)
        expected = hmac.new(('a' * 64).encode(), nonce.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(response.json['proof'], expected)
        self.assertNotIn('a' * 64, response.get_data(as_text=True))

    def test_wrong_or_missing_token_cannot_access_tasks(self):
        for token in ['', 'b' * 64]:
            response = self.client.post('/api/tasks', headers={'X-PDF2zh-Easy-Token': token}, base_url=self.base)
            self.assertEqual(response.status_code, 403)
        response = self.client.get('/api/tasks', headers={'X-PDF2zh-Easy-Token': 'a' * 64}, base_url=self.base)
        self.assertEqual(response.status_code, 200)

    def test_browser_origin_and_rebound_hostname_are_rejected(self):
        headers = {'X-PDF2zh-Easy-Token': 'a' * 64, 'Origin': 'https://untrusted.example'}
        self.assertEqual(self.client.get('/api/tasks', headers=headers, base_url=self.base).status_code, 403)
        self.assertEqual(self.client.get('/health?challenge=' + '01' * 16, base_url='http://untrusted.example:8891').status_code, 403)

    def test_invalid_challenge_is_not_reflected_in_errors(self):
        response = self.client.get('/health?challenge=<script>private</script>', base_url=self.base)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('private', response.get_data(as_text=True))

    def test_non_ascii_or_malformed_tokens_are_rejected_without_server_errors(self):
        for token in ('é', '中文', 'a' * 63, 'a' * 65, 'A' * 64, 'g' * 64):
            with self.subTest(token=token):
                response = self.client.get('/api/tasks', base_url=self.base,
                                           headers={'X-PDF2zh-Easy-Token': token})
                self.assertEqual(response.status_code, 403)
                self.assertNotIn(token, response.get_data(as_text=True))

    def test_challenge_and_registered_identity_validate_string_types(self):
        from flask import Flask
        from runtime.security import challenge_proof, register_auth
        for value in (None, [], {}, 123, 'é'):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    challenge_proof('a' * 64, value)
                with self.assertRaises(ValueError):
                    register_auth(Flask(__name__), value)


if __name__ == '__main__':
    unittest.main()

"""Per-install local service authentication; no credentials in health requests."""
import hashlib
import hmac
import re
from server.utils.privacy import register_credentials, register_secret, redact_json

TOKEN_HEADER = 'X-PDF2zh-Easy-Token'
RUNTIME_VERSION = '0.1.0'


def is_hex(value, length):
    return isinstance(value, str) and len(value) == length and re.fullmatch(r'[a-f0-9]+', value) is not None


def challenge_proof(token, nonce):
    if not is_hex(nonce, 32):
        raise ValueError('Invalid local service challenge.')
    return hmac.new(token.encode('ascii'), nonce.encode('ascii'), hashlib.sha256).hexdigest()


def register_auth(app, token, port=8891):
    from flask import jsonify, request
    if not is_hex(token, 64):
        raise ValueError('Invalid local service identity.')
    register_secret(token)

    @app.after_request
    def sanitize_diagnostics(response):
        # Do not deserialize PDF/file streams or rewrite health HMAC proofs.
        if response.direct_passthrough or not response.is_json:
            return response
        data = response.get_json(silent=True)
        failed = isinstance(data, dict) and data.get('status') in ('error', 'failed')
        if response.status_code >= 400 or failed or request.path in ('/api/history', '/api/tasks'):
            response.set_data(app.json.dumps(redact_json(data)))
        return response

    @app.before_request
    def authorize():
        if request.host not in {f'127.0.0.1:{port}', f'localhost:{port}'}:
            return jsonify(error='Local service access denied.'), 403
        if request.headers.get('Origin') not in (None, 'null'):
            return jsonify(error='Local service access denied.'), 403
        if request.path == '/health' and request.method == 'GET':
            try:
                proof = challenge_proof(token, request.args.get('challenge', ''))
            except ValueError:
                return jsonify(error='Invalid local service challenge.'), 400
            return jsonify(status='ok', service='pdf2zh-easy', runtime_version=RUNTIME_VERSION, proof=proof)
        supplied = request.headers.get(TOKEN_HEADER, '')
        if not is_hex(supplied, 64) or not hmac.compare_digest(supplied, token):
            return jsonify(error='Local service access denied.'), 403
        if request.is_json:
            data = request.get_json(silent=True)
            if isinstance(data, dict):
                register_credentials(data.get('llm_api', {}))
        return None

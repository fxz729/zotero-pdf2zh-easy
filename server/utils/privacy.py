"""Credential-safe diagnostic copies. Never transform engine inputs or PDF data."""
import builtins
from contextlib import contextmanager
import json
import re
import sys
import threading
from urllib.parse import quote, quote_plus

# Standalone server imports utils.*, while runtime tests can use server.utils.*.
# Both spellings must share the same in-memory credential registry.
sys.modules.setdefault('utils.privacy', sys.modules[__name__])
sys.modules.setdefault('server.utils.privacy', sys.modules[__name__])

MASK = '[REDACTED]'
_SECRETS = set()
_LOCK = threading.RLock()
_SENSITIVE = re.compile(r'key|token|secret|password|auth|credential|cookie|headers?', re.I)
_LABELLED = re.compile(
    r'''(["']?[\w-]*(?:key|token|secret|password|authorization|credential|cookie)[\w-]*["']?\s*[:=]\s*)'''
    r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)''', re.I)
_BEARER = re.compile(r'''\b(Bearer|Basic)\s+[^\s,'";}\]]+''', re.I)
_USERINFO = re.compile(r'(https?://)[^/\s:@]+:[^/@\s]+@', re.I)


def register_secret(value):
    if not isinstance(value, str) or not value:
        return
    variants = {value, json.dumps(value, ensure_ascii=True)[1:-1],
                json.dumps(value, ensure_ascii=False)[1:-1], repr(value)[1:-1],
                quote(value, safe=''), quote_plus(value, safe='')}
    with _LOCK:
        _SECRETS.update(item for item in variants if item)
    match = re.fullmatch(r'(?:Bearer|Basic)\s+(.+)', value, re.I)
    if match:
        register_secret(match.group(1))


def register_credentials(value, sensitive=False):
    """Learn only credential fields, including serialized extraData header objects."""
    if isinstance(value, dict):
        for key, item in value.items():
            register_credentials(item, sensitive or bool(_SENSITIVE.search(str(key))))
    elif isinstance(value, (list, tuple)):
        for item in value:
            register_credentials(item, sensitive)
    elif isinstance(value, str):
        if sensitive:
            register_secret(value)
        if value.lstrip().startswith(('{', '[')):
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                return
            register_credentials(parsed, sensitive)


def redact_text(value):
    text = str(value)
    with _LOCK:
        secrets = sorted(_SECRETS, key=len, reverse=True)
    for secret in secrets:
        text = text.replace(secret, MASK)
    text = _USERINFO.sub(r'\1' + MASK + '@', text)
    text = _BEARER.sub(lambda match: match.group(1) + ' ' + MASK, text)
    return _LABELLED.sub(lambda match: match.group(1) + MASK, text)


def redact_json(value):
    """Return a detached diagnostic tree; the actual engine config stays intact."""
    if isinstance(value, dict):
        return {redact_text(key) if isinstance(key, str) else key:
                MASK if _SENSITIVE.search(str(key)) or re.sub(r'[^a-z]', '', str(key).lower()) == 'extradata'
                else redact_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_json(item) for item in value]
    if isinstance(value, str):
        return redact_text(value)
    return value


def safe_print(*values, **options):
    builtins.print(*(redact_json(value) if isinstance(value, (dict, list, tuple))
                     else redact_text(value) for value in values), **options)


def redact_argv(command):
    """Sanitize an exception/log copy, preserving the actual Popen argv array."""
    result = []
    hide_next = False
    for argument in command:
        text = str(argument)
        if hide_next:
            register_credentials(text, sensitive=True)
            result.append(MASK)
            hide_next = False
        elif text.startswith('-') and _SENSITIVE.search(text.split('=', 1)[0]):
            if '=' in text:
                flag, secret = text.split('=', 1)
                register_credentials(secret, sensitive=True)
                result.append(flag + '=' + MASK)
            else:
                result.append(text)
                hide_next = True
        else:
            result.append(redact_text(text))
    return result


class RedactingStream:
    """Line/frame-aware text wrapper; preserve headless fileno/isatty/encoding APIs."""
    def __init__(self, stream):
        self._stream = stream
        self._pending = ''
        self._lock = threading.RLock()

    def __getattr__(self, name):
        return getattr(self._stream, name)

    def write(self, value):
        if not isinstance(value, str):
            raise TypeError('write() argument must be str')
        with self._lock:
            self._pending += value
            end = max(self._pending.rfind('\n'), self._pending.rfind('\r')) + 1
            if end:
                self._stream.write(redact_text(self._pending[:end]))
                self._pending = self._pending[end:]
        return len(value)

    def flush(self):
        with self._lock:
            # The headless pipe flushes each arbitrary 4096-byte chunk. Retain
            # a suffix that could be the beginning of a registered credential;
            # otherwise two separately safe-looking writes could leak a full key.
            carry = 0
            with _LOCK:
                secrets = tuple(_SECRETS)
            for secret in secrets:
                for length in range(min(len(secret) - 1, len(self._pending)), carry, -1):
                    if self._pending.endswith(secret[:length]):
                        carry = length
                        break
            ready = self._pending[:-carry] if carry else self._pending
            self._pending = self._pending[-carry:] if carry else ''
            if ready:
                self._stream.write(redact_text(ready))
            self._stream.flush()

    def finish(self):
        self.flush()
        with self._lock:
            if self._pending:
                # An incomplete credential prefix at shutdown is not diagnostic.
                self._stream.write(MASK)
                self._pending = ''
                self._stream.flush()


@contextmanager
def redacted_output():
    original_out, original_err = sys.stdout, sys.stderr
    out, err = RedactingStream(original_out), RedactingStream(original_err)
    sys.stdout, sys.stderr = out, err
    try:
        yield
    finally:
        try:
            out.finish()
            err.finish()
        finally:
            sys.stdout, sys.stderr = original_out, original_err

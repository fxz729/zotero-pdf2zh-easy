"""Spawn controlled background children without allocating a Windows console.

Pipe redirection alone does not prevent a console allocation when the parent has
no console (Zotero -> helper -> uv/Python). Apply this at every spawn boundary.
"""
import subprocess
import sys


def quiet_options(platform=None):
    if (platform or sys.platform) == 'win32':
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE
        return {'creationflags': subprocess.CREATE_NO_WINDOW, 'startupinfo': startup}
    return {'start_new_session': True}


def _options(options):
    if options.get('shell') or any(key in options for key in ('creationflags', 'startupinfo', 'start_new_session')):
        raise ValueError('Background children must use fixed argv and managed window flags.')
    return {**options, **quiet_options()}


def popen(command, **options):
    return subprocess.Popen(command, **_options(options))


def run(command, **options):
    return subprocess.run(command, **_options(options))


def service_popen(command, **options):
    """Only the owned persistent service may outlive Gecko's helper Job.

    Gecko terminates non-breakaway helper descendants even on a successful
    wait(). Ordinary installation children must remain contained in that Job.
    """
    settings = _options(options)
    if sys.platform == 'win32':
        settings['creationflags'] |= subprocess.CREATE_BREAKAWAY_FROM_JOB
    return subprocess.Popen(command, **settings)

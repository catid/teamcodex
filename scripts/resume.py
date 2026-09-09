#!/usr/bin/env python3
"""Select saved Codex threads across providers, then resume the original ID."""
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path


VALUE_FLAGS = {'-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox',
               '-C', '--cd', '-a', '--ask-for-approval', '-i', '--image', '--add-dir',
               '--enable', '--disable', '--remote', '--remote-auth-token-env'}


def selection_options(args):
    """Leave explicit IDs, remote servers, help, and unrelated commands to Codex."""
    operation = None
    cwd = os.getcwd()
    all_dirs = last = non_interactive = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {'-h', '--help', '-V', '--version', '--remote'} or arg.startswith('--remote='):
            return None
        if arg == '--':
            if i + 1 < len(args):
                return None  # explicit session ID after the delimiter
            break
        if arg in VALUE_FLAGS:
            if i + 1 >= len(args):
                return None  # let Codex report its argument error
            if arg in {'-C', '--cd'}:
                cwd = args[i + 1]
            i += 2
            continue
        if arg.startswith('--cd='):
            cwd = arg.split('=', 1)[1]
        elif arg.startswith('-C') and len(arg) > 2:
            cwd = arg[2:].removeprefix('=')
        elif arg == '--last':
            last = True
        elif arg == '--all':
            all_dirs = True
        elif arg == '--include-non-interactive':
            non_interactive = True
        elif not arg.startswith('-'):
            if operation is not None or arg not in {'resume', 'fork'}:
                return None
            operation = arg
        i += 1
    if operation is None:
        return None
    return {'cwd': str(Path(cwd).resolve()), 'all_dirs': all_dirs, 'last': last,
            'non_interactive': non_interactive}


class ThreadReader:
    """Bounded JSON-RPC reads using Codex's public API, without editing its DB."""
    def __enter__(self):
        self.process = subprocess.Popen(['codex', 'app-server', '--stdio'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b''
        self.next_id = 0
        self.deadline = time.monotonic() + 30
        return self

    def __exit__(self, *_):
        self.selector.close()
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()

    def call(self, method, params):
        self.next_id += 1
        self.send({'id': self.next_id, 'method': method, 'params': params})
        deadline = min(self.deadline, time.monotonic() + 20)
        while time.monotonic() < deadline:
            if b'\n' not in self.buffer:
                if not self.selector.select(max(0, deadline - time.monotonic())):
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError('Codex closed the session-list connection')
                self.buffer += chunk
                if len(self.buffer) > 16 * 1024 * 1024:
                    raise RuntimeError('Codex session-list response is too large')
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            message = json.loads(line)
            if message.get('id') != self.next_id:
                continue
            if 'error' in message:
                raise RuntimeError(message['error'].get('message', 'Cannot list sessions'))
            return message['result']
        raise RuntimeError('Timed out reading saved Codex sessions; retry or pass a session ID')

    def threads(self, options):
        self.call('initialize', {'clientInfo': {'name': 'teamcodex_resume', 'version': '1.0.0'},
                                 'capabilities': {}})
        self.send({'method': 'initialized'})
        params = {'limit': 100, 'modelProviders': [], 'sortKey': 'updated_at',
                  'archived': False}
        if not options['all_dirs']:
            params['cwd'] = options['cwd']
        if options['non_interactive']:
            params['sourceKinds'] = ['cli', 'vscode', 'exec']
        threads, seen, cursors = [], set(), set()
        # Bound even a broken server that repeats pages or generates cursors forever.
        for _ in range(100):
            page = self.call('thread/list', params)
            for thread in page['data']:
                if thread['id'] not in seen:
                    seen.add(thread['id'])
                    threads.append(thread)
            if options['last'] and threads:
                break
            cursor = page.get('nextCursor')
            if not cursor:
                break
            if cursor in cursors:
                raise RuntimeError('Codex repeated a session-list page; retry or pass a session ID')
            cursors.add(cursor)
            params['cursor'] = cursor
        else:
            raise RuntimeError('Too many sessions to list; run resume from the project directory')
        return threads


def label(thread):
    title = thread.get('name') or thread.get('preview') or thread['id']
    # Render stored text as text, never terminal control sequences.
    return ' '.join(str(title).split())


def pick(threads):
    import curses

    def screen(stdscr):
        query, selected = '', 0
        stdscr.keypad(True)
        while True:
            matches = [t for t in threads if query.casefold() in
                       (label(t) + ' ' + t.get('cwd', '') + ' ' + t['id']).casefold()]
            selected = min(selected, max(0, len(matches) - 1))
            height, width = stdscr.getmaxyx()
            stdscr.erase()

            def line(row, text, highlight=False):
                if 0 <= row < height:
                    safe = ''.join(c if c.isprintable() else ' ' for c in text)
                    try:
                        stdscr.addnstr(row, 0, safe, max(0, width - 1),
                                       curses.A_REVERSE if highlight else 0)
                    except curses.error:
                        pass

            line(0, 'Resume a saved conversation — all providers')
            line(1, 'Search: ' + query)
            count = max(1, height - 5)
            offset = (selected // count) * count
            for row, thread in enumerate(matches[offset:offset + count], 3):
                idx = offset + row - 3
                line(row, f"{'>' if idx == selected else ' '} {label(thread)}"
                     f"  [{thread.get('modelProvider', '?')}]  {thread.get('cwd', '')}", idx == selected)
            if not matches:
                line(3, 'No matching sessions')
            line(height - 1, f'{len(matches)} sessions | arrows: select | Enter: continue | Esc/Ctrl-C: cancel')
            stdscr.refresh()
            key = stdscr.get_wch()
            if key in ('\x1b', '\x03'):
                return None
            if key in ('\n', '\r', curses.KEY_ENTER) and matches:
                return matches[selected]['id']
            if key in (curses.KEY_UP, '\x10'):
                selected = max(0, selected - 1)
            elif key in (curses.KEY_DOWN, '\x0e'):
                selected = min(max(0, len(matches) - 1), selected + 1)
            elif key == curses.KEY_NPAGE:
                selected = min(max(0, len(matches) - 1), selected + count)
            elif key == curses.KEY_PPAGE:
                selected = max(0, selected - count)
            elif key in (curses.KEY_BACKSPACE, '\x7f', '\b'):
                query, selected = query[:-1], 0
            elif isinstance(key, str) and key.isprintable():
                query, selected = query + key, 0
    return curses.wrapper(screen)


def with_session(args, session):
    # Keep option values/literal arguments intact; only remove selector flags.
    result, i = [], 0
    while i < len(args):
        arg = args[i]
        if arg == '--':
            result.extend([session, *args[i:]])
            return result
        if arg in VALUE_FLAGS:
            result.extend(args[i:i + 2])
            i += 2
            continue
        if arg not in {'--last', '--all', '--include-non-interactive'}:
            result.append(arg)
        i += 1
    return [*result, session]


def main(args):
    options = selection_options(args)
    if options is not None:
        if not options['last'] and not sys.stdin.isatty():
            raise RuntimeError('Session picker needs a terminal. Use resume --last or resume SESSION_ID.')
        with ThreadReader() as reader:
            threads = reader.threads(options)
        if not threads:
            raise RuntimeError('No saved sessions found. Try teamcodex resume --all for other directories.')
        session = threads[0]['id'] if options['last'] else pick(threads)
        if session is None:
            return
        args = with_session(args, session)
    os.execvpe('codex', ['codex', *args], os.environ)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f'TeamCodex: {exc}', file=sys.stderr)
        sys.exit(1)

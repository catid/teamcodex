import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resume', Path(__file__).resolve().parents[1] / 'scripts/resume.py')
resume = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resume)


class ResumeTests(unittest.TestCase):
    def test_options_and_literal_values(self):
        args = ['-m', 'gpt-6-astra', 'resume', '--last', '-C', '/tmp/project', '-c', 'title="--all"']
        options = resume.selection_options(args)
        self.assertTrue(options['last'])
        self.assertFalse(options['all_dirs'])
        self.assertEqual(options['cwd'], str(Path('/tmp/project').resolve()))
        self.assertEqual(resume.with_session(args, 'original'),
                         ['-m', 'gpt-6-astra', 'resume', '-C', '/tmp/project', '-c', 'title="--all"', 'original'])
        self.assertEqual(resume.with_session(['resume', '--last', '--'], 'original'), ['resume', 'original', '--'])

    def test_explicit_ids_and_unrelated_commands_pass_through(self):
        for args in [['resume', 'original'], ['resume', '--', 'original'], ['exec', 'resume', '--last'],
                     ['resume', '--help'], ['resume', '--remote', 'unix:///tmp/server'], ['exec', 'resume']]:
            self.assertIsNone(resume.selection_options(args))

    def test_all_providers_pagination_without_database_mutations(self):
        reader = resume.ThreadReader()
        pages = iter([{}, {'data': [{'id': 'old', 'modelProvider': 'openai'}], 'nextCursor': 'next'},
                      {'data': [{'id': 'old'}, {'id': 'new', 'modelProvider': 'teamcodex'}], 'nextCursor': None}])
        calls = []
        reader.call = lambda method, params: (calls.append((method, dict(params))), next(pages))[1]
        reader.send = lambda _: None
        threads = reader.threads(resume.selection_options(['resume', '--all']))
        self.assertEqual([t['id'] for t in threads], ['old', 'new'])
        self.assertEqual(calls[1][1]['modelProviders'], [])
        self.assertNotIn('cwd', calls[1][1])
        self.assertEqual(calls[2][1]['cursor'], 'next')

    def test_last_uses_original_id_across_providers(self):
        with patch.object(resume, 'ThreadReader') as reader, patch.object(resume.os, 'execvpe') as execute:
            reader.return_value.__enter__.return_value.threads.return_value = [{'id': 'old-openai-thread'}]
            resume.main(['resume', '--last', '-c', 'model_provider=teamcodex'])
            self.assertEqual(execute.call_args.args[1], ['codex', 'resume', '-c', 'model_provider=teamcodex', 'old-openai-thread'])

    def test_no_sessions_never_silently_starts_a_new_conversation(self):
        with patch.object(resume, 'ThreadReader') as reader, patch.object(resume.os, 'execvpe') as execute:
            reader.return_value.__enter__.return_value.threads.return_value = []
            with self.assertRaisesRegex(RuntimeError, 'No saved sessions'):
                resume.main(['resume', '--last'])
            execute.assert_not_called()

    def test_repeated_cursor_is_bounded(self):
        reader = resume.ThreadReader()
        reader.call = lambda *_: {'data': [], 'nextCursor': 'same'}
        reader.send = lambda _: None
        with self.assertRaisesRegex(RuntimeError, 'repeated'):
            reader.threads(resume.selection_options(['resume']))


if __name__ == '__main__':
    unittest.main()

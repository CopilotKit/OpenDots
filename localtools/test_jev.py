import base64
import io
import os
import unittest
from unittest.mock import Mock, patch
from PIL import Image
from jev import select_target, check_image


class JevTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'LOCALTOOLS_JEV_URL': 'http://127.0.0.1:8017', 'LOCALTOOLS_JEV_BACKEND': 'visual-jev'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.elements = [{'ref': 5, 'name': 'Account', 'role': 'button', 'inView': True}]

    def reply(self, probs, **changes):
        def respond(*args, **kwargs):
            data = {'options': kwargs['json']['options'], 'probabilities': probs, 'choice_index': 1, **changes}
            return Mock(status_code=200, json=lambda: data)
        return respond

    def test_maps_choice_to_observed_ref_and_sends_image(self):
        with patch('jev.requests.post', side_effect=self.reply([0.02, 0.98])) as post:
            self.assertEqual(select_target('Account menu', self.elements, b'image')['ref'], 5)
            args = post.call_args.kwargs
            self.assertFalse(args['allow_redirects'])
            self.assertIn('image', args['json']['state'][-1])

    def test_rejects_uncertain_malformed_and_forged_responses(self):
        for probs, changes in [([0.4, 0.6], {}), ([0.9, 0.1], {}), ([0.01, float('nan')], {}), ([0.02, 0.98], {'choice_index': True}), ([0.02, 0.98], {'options': ['forged', 'delete']})]:
            with self.subTest(probs=probs, changes=changes), patch('jev.requests.post', side_effect=self.reply(probs, **changes)):
                with self.assertRaises((ValueError, LookupError)):
                    select_target('Account', self.elements)

    def test_no_request_when_disabled_remote_or_too_many_targets(self):
        with patch('jev.requests.post') as post:
            for url in ['', 'https://example.com', 'http://localhost:8017/v1', 'http://user@localhost:8017']:
                with patch.dict(os.environ, {'LOCALTOOLS_JEV_URL': url}), self.assertRaises((RuntimeError, ValueError)):
                    select_target('Account', self.elements)
            with self.assertRaises(ValueError):
                select_target('Account', self.elements * 8)
            post.assert_not_called()

    def test_visual_check_preserves_no_and_abstains_on_weak_yes(self):
        for probs, index, expected in [([0.01, 0.98, 0.01], 1, 'yes'), ([0.01, 0.01, 0.98], 2, 'no'), ([0.2, 0.6, 0.2], 1, 'uncertain'), ([0.98, 0.01, 0.01], 0, 'uncertain')]:
            with patch('jev.requests.post', side_effect=self.reply(probs, choice_index=index)):
                self.assertEqual(check_image('Menu visible?', b'image')['assessment'], expected)

    def test_server_request_requires_inline_image_and_bounded_choices(self):
        # Importing the bridge does not load model weights or start a server.
        from visual_jev_server import parse_request
        buffer = io.BytesIO()
        Image.new('RGB', (10, 10)).save(buffer, format='PNG')
        request = {'kind': 'choice', 'options': ['None', 'Account'], 'question': 'Which button?', 'state': ['Context', {'image': 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()}]}
        self.assertEqual(parse_request(request)[0].size, (10, 10))
        for bad in [{**request, 'options': ['x'] * 9}, {**request, 'state': [{'image': 'https://example.com/image.png'}]}]:
            with self.assertRaises(ValueError):
                parse_request(bad)

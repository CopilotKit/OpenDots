import tempfile
import unittest
from pathlib import Path
from confirmation_policy import confirmations_required


class ConfirmationPolicyTests(unittest.TestCase):
    def test_changes_are_read_on_every_action(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "policy.json"
            self.assertTrue(confirmations_required(path))
            self.assertFalse(confirmations_required(path, False))
            path.write_text('{"mode":"unattended"}', encoding="utf-8")
            self.assertFalse(confirmations_required(path))
            path.write_text('{"mode":"confirm"}', encoding="utf-8")
            self.assertTrue(confirmations_required(path, False))
            for invalid in ['broken', 'null', '[]', '{"mode":"oops"}', '{"mode":"unattended", "extra":true}']:
                path.write_text(invalid, encoding="utf-8")
                self.assertTrue(confirmations_required(path, False))


if __name__ == "__main__":
    unittest.main()

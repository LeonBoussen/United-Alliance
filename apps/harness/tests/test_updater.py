from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from harness.updater import BACKUP, PENDING, Updater, UpdateError, source_hash


def make_tree(root: Path, main: str = "print('v1')\n") -> None:
    (root / "harness").mkdir(parents=True, exist_ok=True)
    (root / "harness" / "__init__.py").write_text("")
    (root / "harness" / "__main__.py").write_text(main)
    (root / "requirements.txt").write_text("websockets\n")


def package(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        make_tree(self.root)
        self.updater = Updater(self.root, "http://127.0.0.1:8080")

    def tearDown(self):
        self.tmp.cleanup()

    def new_version(self):
        files = {"harness/__init__.py": "", "harness/__main__.py": "print('v2')\n", "requirements.txt": "websockets\nopenai\n"}
        staged = Path(self.tmp.name) / "expected"
        for name, content in files.items():
            (staged / name).parent.mkdir(parents=True, exist_ok=True)
            (staged / name).write_bytes(content.encode())  # bytes, like extraction (no newline translation)
        pkg = package(files)
        return pkg, hashlib.sha256(pkg).hexdigest(), source_hash(staged)

    def test_hash_ignores_pycache_and_changes_with_content(self):
        h1 = source_hash(self.root)
        (self.root / "harness" / "__pycache__").mkdir()
        (self.root / "harness" / "__pycache__" / "x.py").write_text("junk")
        self.assertEqual(source_hash(self.root), h1)
        (self.root / "harness" / "__main__.py").write_text("print('changed')\n")
        self.assertNotEqual(source_hash(self.root), h1)

    def test_apply_swaps_code_keeps_backup_and_commit_cleans_up(self):
        pkg, sha, src = self.new_version()
        self.updater.apply(pkg, sha, src)
        self.assertEqual((self.root / "harness" / "__main__.py").read_text(), "print('v2')\n")
        self.assertIn("openai", (self.root / "requirements.txt").read_text())
        self.assertEqual((self.root / BACKUP / "harness" / "__main__.py").read_text(), "print('v1')\n")
        self.assertTrue((self.root / PENDING).exists())
        self.assertEqual(source_hash(self.root), src)

        self.updater.commit()
        self.assertFalse((self.root / PENDING).exists())
        self.assertFalse((self.root / BACKUP).exists())

    def test_rejects_bad_checksum_wrong_contents_and_path_traversal(self):
        pkg, sha, src = self.new_version()
        with self.assertRaises(UpdateError):
            self.updater.apply(pkg, "0" * 64, src)
        with self.assertRaises(UpdateError):
            self.updater.apply(pkg, sha, "f" * 64)
        evil = package({"harness/__main__.py": "x", "../outside.py": "x"})
        with self.assertRaises(UpdateError):
            self.updater.apply(evil, hashlib.sha256(evil).hexdigest(), src)
        # Nothing changed after the failures.
        self.assertEqual((self.root / "harness" / "__main__.py").read_text(), "print('v1')\n")
        self.assertFalse((self.root / PENDING).exists())
        self.assertFalse((self.root / ".update-staging").exists())


if __name__ == "__main__":
    unittest.main()

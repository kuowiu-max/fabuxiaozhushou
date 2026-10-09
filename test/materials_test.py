import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from zipfile import ZipFile

SCRIPT = Path(__file__).resolve().parents[1] / "skills/发布小助手/scripts/package_materials.py"
SPEC = importlib.util.spec_from_file_location("package_materials", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MaterialPackTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "资料.json"
        self.output = self.root / "素材包.zip"
        self.image = b"\x89PNG\r\n\x1a\n\x00\xff\x12original-bytes"
        (self.root / "图片.png").write_bytes(self.image)
        self.spec = {
            "store": {"name": "测试门店", "city": "测试城市"},
            "content": {"titles": ["测试标题一", "测试标题二"], "body": "只用于打包测试，不代表真实门店。", "tags": ["测试"]},
            "sources": [{"title": "用户提供的测试资料", "notes": "仅测试"}],
            "images": [{"path": "图片.png", "kind": "user-original", "caption": "测试原图"}],
            "unexpected_private_field": "must-not-be-exported"
        }

    def write_input(self):
        self.input.write_text(json.dumps(self.spec, ensure_ascii=False), encoding="utf8")

    def test_export_keeps_originals_and_records_sources(self):
        self.write_input()
        result = MODULE.package(self.input, self.output)
        self.assertEqual(result["images"], 1)
        with ZipFile(self.output) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("图片/01-图片.png"), self.image)
            self.assertIn("不代表真实门店", archive.read("文案.txt").decode())
            self.assertIn("用户提供", archive.read("来源.txt").decode())
            metadata = archive.read("素材记录.json").decode()
            self.assertNotIn("must-not-be-exported", metadata)
            self.assertNotIn(str(self.root), metadata)

    def test_existing_output_is_preserved(self):
        self.write_input()
        self.output.write_bytes(b"existing-user-file")
        with self.assertRaisesRegex(ValueError, "已存在"):
            MODULE.package(self.input, self.output)
        self.assertEqual(self.output.read_bytes(), b"existing-user-file")

    def test_content_only_cli_exports_text_and_photos_without_source_records(self):
        self.spec["sources"][0]["url"] = "https://www.meituan.com/test-store"
        self.spec["images"][0].update(kind="reference-photo", source_url="https://www.meituan.com/test-store")
        self.write_input()
        result = subprocess.run([sys.executable, str(SCRIPT), "--input", str(self.input), "--output", str(self.output), "--content-only"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["sources"], 0)
        with ZipFile(self.output) as archive:
            self.assertEqual(set(archive.namelist()), {"文案.txt", "图片/01.png"})
            self.assertEqual(archive.read("图片/01.png"), self.image)
            self.assertIn("不代表真实门店", archive.read("文案.txt").decode())
            self.assertNotIn("meituan.com", archive.read("文案.txt").decode())

    def test_reference_images_are_not_exported_as_publishable_originals(self):
        self.spec["images"][0]["kind"] = "reference-only"
        self.write_input()
        with self.assertRaisesRegex(ValueError, "图片需标明"):
            MODULE.package(self.input, self.output)
        self.assertFalse(self.output.exists())

    def test_remote_or_missing_images_do_not_produce_fake_package(self):
        for path in ["https://example.com/photo.png", "missing.png"]:
            self.spec["images"][0]["path"] = path
            self.write_input()
            with self.assertRaises(ValueError):
                MODULE.package(self.input, self.output)
            self.assertFalse(self.output.exists())

    def test_non_image_file_cannot_be_packaged_as_photo(self):
        (self.root / "配置.png").write_text("not an image", encoding="utf8")
        self.spec["images"][0]["path"] = "配置.png"
        self.write_input()
        with self.assertRaisesRegex(ValueError, "原图格式"):
            MODULE.package(self.input, self.output)

    def test_empty_image_list_is_valid_and_does_not_fabricate_files(self):
        self.spec["images"] = []
        self.write_input()
        self.assertEqual(MODULE.package(self.input, self.output)["images"], 0)
        with ZipFile(self.output) as archive:
            self.assertEqual(len(archive.namelist()), 3)

    def test_unsafe_source_url_is_rejected(self):
        self.spec["sources"][0]["url"] = "javascript:alert(1)"
        self.write_input()
        with self.assertRaisesRegex(ValueError, "来源链接"):
            MODULE.package(self.input, self.output)

    def test_reference_photo_keeps_its_origin_and_is_not_labeled_authorized(self):
        self.spec["images"][0].update(kind="reference-photo", source_url="https://www.meituan.com/test-store")
        self.write_input()
        MODULE.package(self.input, self.output)
        with ZipFile(self.output) as archive:
            metadata = json.loads(archive.read("素材记录.json"))
            self.assertEqual(metadata["images"][0]["kind"], "reference-photo")
            self.assertEqual(metadata["images"][0]["source_url"], "https://www.meituan.com/test-store")
            self.assertIn("外站参考", archive.read("来源.txt").decode())

    def test_reference_photo_without_origin_cannot_be_exported(self):
        self.spec["images"][0]["kind"] = "reference-photo"
        self.write_input()
        with self.assertRaisesRegex(ValueError, "必须保留原帖出处"):
            MODULE.package(self.input, self.output)


if __name__ == "__main__":
    unittest.main()

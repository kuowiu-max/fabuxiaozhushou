import importlib.util
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError
import json

SCRIPT = Path(__file__).resolve().parents[1] / "skills/发布小助手/scripts/fetch_photos.py"
SPEC = importlib.util.spec_from_file_location("fetch_photos", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Response(BytesIO):
    def __init__(self, data, url, content_type="image/png"):
        super().__init__(data)
        self.url = url
        self.headers = {"Content-Type": content_type}

    def geturl(self):
        return self.url


class PhotoFetchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "照片"
        self.image = b"\x89PNG\r\n\x1a\n\x00\xfforiginal-reference-image"
        self.spec = {
            "store": {"name": "仅用于测试的门店", "city": "测试城市"},
            "photos": [{"url": "https://img.meituan.net/test-photo.png", "source_url": "https://www.meituan.com/test-store", "caption": "测试照片"}]
        }

    def opener(self, behavior):
        class Opener:
            def open(_, request, timeout):
                return behavior(request, timeout)
        return Opener()

    def test_download_preserves_bytes_and_source(self):
        requests = []
        def respond(request, timeout):
            requests.append(request)
            return Response(self.image, request.full_url)
        result = MODULE.fetch(self.spec, self.output, self.opener(respond))
        self.assertEqual(len(result["images"]), 1)
        record = result["images"][0]
        self.assertEqual(Path(record["path"]).read_bytes(), self.image)
        self.assertEqual(record["kind"], "reference-photo")
        self.assertEqual(record["source_url"], self.spec["photos"][0]["source_url"])
        self.assertNotIn("Authorization", requests[0].headers)
        self.assertNotIn("Cookie", requests[0].headers)

    def test_duplicate_url_only_downloaded_once(self):
        self.spec["photos"] *= 2
        result = MODULE.fetch(self.spec, self.output, self.opener(lambda req, _: Response(self.image, req.full_url)))
        self.assertEqual(len(result["images"]), 1)

    def test_blocked_page_is_not_saved_as_photo(self):
        def denied(request, _):
            raise HTTPError(request.full_url, 403, "Denied", {}, None)
        result = MODULE.fetch(self.spec, self.output, self.opener(denied))
        self.assertEqual(result["images"], [])
        self.assertIn("HTTP 403", result["errors"][0]["error"])
        self.assertEqual(list(self.output.glob("*.png")), [])

    def test_login_html_is_not_saved_as_image(self):
        result = MODULE.fetch(self.spec, self.output, self.opener(lambda req, _: Response(b"<html>Login</html>", req.full_url, "text/html")))
        self.assertEqual(result["images"], [])

    def test_outside_domains_and_redirects_are_rejected(self):
        for url in ["http://img.meituan.net/p.png", "https://img.meituan.net.attacker.example/p.png", "https://127.0.0.1/p.png", "https://user:password@img.meituan.net/p.png"]:
            with self.assertRaises(ValueError):
                MODULE.public_url(url, MODULE.IMAGE_DOMAINS)
        result = MODULE.fetch(self.spec, self.output, self.opener(lambda req, _: Response(self.image, "https://untrusted.example/p.png")))
        self.assertEqual(result["images"], [])

    def test_no_more_than_six_photos_are_downloaded(self):
        photo = self.spec["photos"][0]
        self.spec["photos"] = [{**photo, "url": f"https://img.meituan.net/{i}.png"} for i in range(10)]
        result = MODULE.fetch(self.spec, self.output, self.opener(lambda req, _: Response(self.image, req.full_url)))
        self.assertEqual(len(result["images"]), 6)

    def test_large_image_is_rejected(self):
        result = MODULE.fetch(self.spec, self.output, self.opener(lambda req, _: Response(self.image + b"x" * MODULE.MAX_IMAGE_BYTES, req.full_url)))
        self.assertEqual(result["images"], [])

    def test_existing_directory_is_preserved(self):
        self.output.mkdir()
        original = self.output / "user.txt"
        original.write_text("keep", encoding="utf8")
        with self.assertRaisesRegex(ValueError, "已存在"):
            MODULE.fetch(self.spec, self.output)
        self.assertEqual(original.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()

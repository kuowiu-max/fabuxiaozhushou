#!/usr/bin/env python3
"""Fetch already-discovered public review photos; no page scraping or authentication."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

IMAGE_DOMAINS = ("xhscdn.com", "meituan.net", "dpfile.com")
SOURCE_DOMAINS = ("xiaohongshu.com", "xhslink.com", "meituan.com", "dianping.com")
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024


def public_url(value, domains):
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("需要实际发现的公开网页或图片链接。")
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("仅支持不含账号密码的标准 HTTPS 链接。")
    if not any(host == domain or host.endswith("." + domain) for domain in domains):
        raise ValueError("链接不在小红书、美团或大众点评的公开图片／来源域名范围内。")
    return value


class PublicImageRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl, IMAGE_DOMAINS)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def extension(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    raise ValueError("响应不是支持的 JPG、PNG 或 WebP 图片；不能把登录页面保存成照片。")


def fetch(spec, output, opener=None):
    if not isinstance(spec, dict) or not isinstance(spec.get("store"), dict):
        raise ValueError("缺少门店记录。")
    store = {key: str(spec["store"].get(key, ""))[:160] for key in ("name", "city", "branch")}
    if not store["name"].strip():
        raise ValueError("缺少已核对的门店名称。")
    photos = spec.get("photos", [])
    if not isinstance(photos, list) or not photos:
        raise ValueError("没有实际发现的公开图片链接。")
    output = Path(output).absolute()
    if os.path.lexists(output):
        raise ValueError("输出目录已存在，请换一个目录，原有文件不会覆盖。")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    opener = opener or build_opener(PublicImageRedirects())
    result = {"store": store, "images": [], "sources": [], "errors": [], "skipped_duplicates": 0, "downloaded_bytes": 0}
    seen, image_hashes, total = set(), set(), 0
    for index, photo in enumerate(photos[:20], 1):
        if len(result["images"]) >= 6:
            break
        if total >= MAX_TOTAL_BYTES:
            result["errors"].append({"photo": index, "error": "照片总下载大小已达 50 MB。"})
            break
        try:
            if not isinstance(photo, dict):
                raise ValueError("图片记录格式错误。")
            url = public_url(photo.get("url"), IMAGE_DOMAINS)
            source_url = public_url(photo.get("source_url"), SOURCE_DOMAINS)
            if url in seen:
                result["skipped_duplicates"] += 1
                continue
            seen.add(url)
            request = Request(url, headers={"User-Agent": "PublishHelper/0.3", "Referer": source_url})
            with opener.open(request, timeout=20) as response:
                public_url(response.geturl(), IMAGE_DOMAINS)
                content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
                if not content_type.startswith("image/"):
                    raise ValueError("响应不是图片，可能需要登录或访问权限。")
                limit = min(MAX_IMAGE_BYTES, MAX_TOTAL_BYTES - total)
                if limit <= 0:
                    raise ValueError("照片总大小已达 50 MB。")
                data = response.read(limit + 1)
                total += len(data)
                if len(data) > limit:
                    raise ValueError("单张图片超过 10 MB，或照片总大小超过 50 MB。")
            suffix = extension(data)
            digest = hashlib.sha256(data).digest()
            if digest in image_hashes:
                result["skipped_duplicates"] += 1
                continue
            filename = f"{len(result['images']) + 1:02d}-评论照片.{suffix}"
            path = output / filename
            path.write_bytes(data)
            image_hashes.add(digest)
            caption = str(photo.get("caption", ""))[:300]
            result["images"].append({"path": str(path), "kind": "reference-photo", "source_url": source_url, "caption": caption})
            if source_url not in [source["url"] for source in result["sources"]]:
                result["sources"].append({"title": str(photo.get("source_title", "评论照片来源"))[:200], "url": source_url, "notes": "外站参考照片，未自动取得转载授权。"})
        except HTTPError as error:
            result["errors"].append({"photo": index, "error": f"HTTP {error.code}，图片访问失败；不会绕过限制。"})
        except (URLError, TimeoutError, OSError):
            result["errors"].append({"photo": index, "error": "网络或文件访问失败。"})
        except ValueError as error:
            result["errors"].append({"photo": index, "error": str(error)})
    result["downloaded_bytes"] = total
    report = output / "照片来源.json"
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    return result


def main():
    parser = argparse.ArgumentParser(description="下载真实页面中已发现的公开照片，保留来源，不处理登录或水印。")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        input_path = Path(args.input)
        if input_path.stat().st_size > 100_000:
            raise ValueError("链接记录超过 100 KB。")
        spec = json.loads(input_path.read_text(encoding="utf8"))
        result = fetch(spec, args.output)
        print(json.dumps({"output": str(Path(args.output).absolute()), "downloaded": len(result["images"]), "failed": len(result["errors"])}, ensure_ascii=False))
        return 0 if result["images"] else 2
    except (OSError, ValueError, TypeError) as error:
        print(f"照片获取失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Package an AI-produced draft and existing originals; never fetch or edit images."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlsplit
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED


def text(value, limit=5000):
    return value.strip()[:limit] if isinstance(value, str) else ""


def image_type(data):
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    raise ValueError("原图格式需为 JPG、PNG 或 WebP。")


def collect(spec, base):
    if not isinstance(spec, dict):
        raise ValueError("素材记录需为 JSON 对象。")
    store, content = spec.get("store", {}), spec.get("content", {})
    if not isinstance(store, dict) or not isinstance(content, dict):
        raise ValueError("门店与文案记录格式错误。")
    store = {key: text(store.get(key), 160) for key in ("name", "city", "branch", "address")}
    if not store["name"]:
        raise ValueError("缺少门店名称。")
    body = text(content.get("body"), 6000)
    if not body:
        raise ValueError("缺少文案正文；请先完成文案。")
    titles_raw, tags_raw = content.get("titles", []), content.get("tags", [])
    if not isinstance(titles_raw, list) or not isinstance(tags_raw, list):
        raise ValueError("标题与话题需为列表。")
    titles = [text(v, 120) for v in titles_raw if text(v, 120)][:2]
    tags = [text(v, 80).lstrip("#") for v in tags_raw if text(v, 80).lstrip("#")][:5]
    sources_raw, images_raw = spec.get("sources", []), spec.get("images", [])
    if not isinstance(sources_raw, list) or not isinstance(images_raw, list):
        raise ValueError("来源与图片需为列表。")
    if len(images_raw) > 20:
        raise ValueError("最多打包 20 张图片。")
    sources = []
    for source in sources_raw[:20]:
        if not isinstance(source, dict):
            raise ValueError("来源记录格式错误。")
        url = text(source.get("url"), 2000)
        if url:
            parsed = urlsplit(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("来源链接需为不含账号密码的 http 或 https 地址。")
        sources.append({"title": text(source.get("title"), 200), "url": url, "notes": text(source.get("notes"), 3000)})
    images, image_files, total = [], [], 0
    for index, image in enumerate(images_raw, 1):
        if not isinstance(image, dict) or image.get("kind") not in ("user-original", "authorized-original", "reference-photo"):
            raise ValueError("图片需标明用户原图、授权原图或外站参考照片。")
        source_url = text(image.get("source_url"), 2000)
        if source_url:
            parsed = urlsplit(source_url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("图片出处需为有效的 http 或 https 链接。")
        if image["kind"] == "reference-photo" and not source_url:
            raise ValueError("外站参考照片必须保留原帖出处。")
        original_path = text(image.get("path"), 4096)
        if not original_path or "://" in original_path:
            raise ValueError("图片需指向已存在的本地原图，而非网页链接。")
        path = Path(original_path)
        if not path.is_absolute():
            path = base / path
        if not path.is_file():
            raise ValueError(f"第 {index} 张原图文件不存在。")
        size = path.stat().st_size
        if size > 10 * 1024 * 1024:
            raise ValueError(f"第 {index} 张图片超过 10 MB。")
        total += size
        if total > 50 * 1024 * 1024:
            raise ValueError("图片总大小超过 50 MB。")
        data = path.read_bytes()
        extension = image_type(data)
        stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", path.stem).strip(". ")[:80] or "图片"
        filename = f"图片/{index:02d}-{stem}.{extension}"
        images.append({"file": filename, "kind": image["kind"], "source_url": source_url, "caption": text(image.get("caption"), 500), "bytes": len(data)})
        image_files.append((filename, data))
    metadata = {"store": store, "content": {"titles": titles, "body": body, "tags": tags}, "sources": sources, "images": images}
    return metadata, image_files


def package(input_path, output_path):
    input_path, output_path = Path(input_path).resolve(), Path(output_path).absolute()
    if output_path.exists() or output_path.is_symlink():
        raise ValueError("输出文件已存在，请换一个文件名。")
    if input_path.stat().st_size > 100_000:
        raise ValueError("素材记录超过 100 KB，请减少文字。")
    spec = json.loads(input_path.read_text(encoding="utf-8"))
    metadata, images = collect(spec, input_path.parent)
    content = metadata["content"]
    draft = "\n\n".join([*(f"标题{i}：{title}" for i, title in enumerate(content["titles"], 1)), content["body"], " ".join("#" + tag for tag in content["tags"])])
    source_text = "\n\n".join(f"{i}. {s['title']}\n{s['url']}\n{s['notes']}" for i, s in enumerate(metadata["sources"], 1)) or "暂无外部来源；请以实际用户资料为准。"
    source_text += "\n\n图片类型：user-original 用户原图；authorized-original 授权原图；reference-photo 外站参考照片（不等于取得转载授权）。\n导出保留图片原始字节，不添加或去除水印。"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".publish-helper-", dir=output_path.parent)
    os.close(fd)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            archive.writestr("文案.txt", draft)
            archive.writestr("来源.txt", source_text)
            archive.writestr("素材记录.json", json.dumps(metadata, ensure_ascii=False, indent=2))
            for filename, data in images:
                archive.writestr(filename, data, compress_type=ZIP_STORED)
        # Atomic creation prevents accidentally replacing an existing material pack.
        os.link(temporary, output_path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"output": str(output_path), "images": len(images), "sources": len(metadata["sources"])}


def main():
    parser = argparse.ArgumentParser(description="打包文案、来源和已有原图，不联网或编辑图片。")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.input, args.output), ensure_ascii=False))
    except (OSError, ValueError, TypeError) as error:
        print(f"打包失败：{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

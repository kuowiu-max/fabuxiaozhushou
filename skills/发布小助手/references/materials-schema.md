# 图片获取与素材包（仅供有执行工具的 AI）

脚本由 AI 在其运行环境调用，不让用户本地部署。没有执行工具时使用该 AI 已有的图片／附件工具，或者提供真实来源链接。

## 下载已经发现的公开照片

先通过实际网页或浏览器工具发现照片链接、核对门店，写入 UTF-8 JSON：

```json
{
  "store": {"name": "已核对门店", "city": "城市", "branch": "分店"},
  "photos": [
    {"url": "从实际页面中取得的HTTPS图片链接", "source_url": "实际原帖或评论页面链接", "source_title": "来源标题", "caption": "已确认的照片用途"}
  ]
}
```

```sh
python3 /技能实际目录/scripts/fetch_photos.py --input /链接实际路径.json --output /新的照片目录
```

支持图片域名 `*.xhscdn.com`、`*.meituan.net`、`*.dpfile.com`，来源限小红书／美团／大众点评。仅支持标准 HTTPS，不接收登录凭据。最多检查20个已发现链接，交付六张不同照片：按链接及文件 SHA-256 去重，同图不同链接会跳过并继续找后续候选，不删除链接参数或猜高清地址。单张10 MB、总下载50 MB（包括重复及被丢弃的响应；判定超限最多额外读取1字节）。原图字节不变；不同压缩版本的近似图片需由有读图能力的 AI 再判断。外站拒绝访问时记录失败，不绕过限制。

退出码 0 表示至少取得一张照片，2 表示全部失败，1 表示输入或整体执行错误。必须读取 `照片来源.json` 和实际文件，再决定如何交付；结果含 `skipped_duplicates`（跳过重复数量）和 `downloaded_bytes`（实际已读字节）。不能将“尝试过下载”说成“已获取”。该文件只供 AI 核对成功数量及门店，不作为默认交付附件，不直接打包整个下载目录。

## 打包文案及实际照片

将照片结果中的 `images`、`sources` 与已写好的文案合并为 JSON：

```json
{
  "store": {"name": "门店名称", "city": "城市", "branch": "分店", "address": "已确认地址或留空"},
  "content": {"titles": ["自然标题"], "body": "依据已确认事实的原创正文", "tags": ["相关话题"]},
  "sources": [{"title": "来源标题", "url": "https://example.com/store", "notes": "实际读取的信息"}],
  "images": [{"path": "/实际存在的照片.png", "kind": "reference-photo", "source_url": "https://www.meituan.com/实际来源", "caption": "外站参考照片"}]
}
```

kind 可以是 `user-original`（用户原图）、`authorized-original`（授权原图）或 `reference-photo`（外站参考照片，必须有出处）。不可将参考照片误标为用户自有或授权原图。图片可以留空。类别只记录来源；`user-original` 不自动证明是本人到店拍摄，`authorized-original` 不自动满足分成活动的原创要求。下载脚本始终把外站图标为参考图，打包成功不表示符合活动资格。

```sh
python3 /技能实际目录/scripts/package_materials.py --input /记录实际路径.json --output /新的素材包.zip --content-only
```

输出不覆盖已有文件。默认使用 `--content-only`，只导出 `文案.txt` 和 `图片/01.png` 等编号照片，保留原始图片字节，不导出出处、来源文件、素材记录、输入 JSON 或本地原图文件名。下载与校验时使用的来源信息仅供内部核对，不要求用户保存。只有用户另行要求来源记录时才省略 `--content-only`，导出完整记录。脚本不会证明门店匹配或转载授权，AI 必须依据实际资料完成核对。

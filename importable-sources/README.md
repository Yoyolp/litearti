# 可直接导入的源

这个文件夹放的是**现成能导入的源文件**。打开应用 → 「源」→「导入源」，选这里的任意一个 JSON 就行。

这些文件不参与构建，也不被应用自动加载——它们只是给人拿的样本。真正导入后，
源会存到应用数据目录下的 `sources/sources.json`，和这个文件夹再无关系。

## 有哪些

| 文件 | 内容 | 说明 |
|---|---|---|
| `anime-kazumi.json` | 3 个番剧源 | 由 Kazumi 社区规则转换而来。三个分别演示：能直接取到 m3u8、只能取到第三方 iframe、多线路 |
| `novel-bqg5555.json` | 1 个小说源 | 笔趣阁，CSS 选择器 + POST 搜索 |
| `novel-kuwo.json` | 1 个小说源 | 酷我小说，JSONPath + `@js:` 拼接地址 |

一共 5 个源，覆盖 `novel` 和 `video` 两种类型，以及 `css:` / `xpath:` / `$." / `@js:` 四种选择器前缀。

## 关于番剧源

那三个是从 [Kazumi 社区规则库](https://github.com/Predidit/KazumiRules) 转换来的，转换过程见 `docs/kazumi-community-sources.md`。

**只有一个能直接播放**：`kazumi-mxdm` 能在页面源码里用正则捞出 m3u8 直链。另外两个：

- `kazumi-dm84` 的播放地址是一个第三方加密 iframe（`hhjx.hhplayer.com/?url=<加密串>`），拿不到直链。
- `kazumi-age` 同样走第三方解析。

这两条**能正常搜索、能列出剧集，但点了播放会给出提示**而不是白屏。这是刻意的：
它们的价值在于演示「源能解析但播放不可用」时错误信息说得清不清楚。

## 校验

```bash
node scripts/verify-importable-sources.mjs
```

这个脚本不是「JSON 能解析就算过」——它打包 `src/sources/schema.ts` 里**应用自己的校验器**来跑，
所以编辑器会拒绝的东西，这里也会拒绝。另外它检查跨文件的 id 唯一性（手工复制模板最容易忘改的就是 id）。

## 自己写一个

最小形状：

```jsonc
{
  "schemaVersion": 1,
  "id": "my-source",          // 全局唯一
  "name": "我的源",
  "version": "1.0.0",
  "homepage": "https://example.com/",
  "language": "zh",
  "type": "novel",            // novel | comic | audio | video
  "enabled": true,
  "request": {
    "headers": { "User-Agent": "..." },
    "timeoutMs": 20000,
    "delayMs": 400
  },
  "search": {
    "url": "https://example.com/search?q={{keyword}}",
    "method": "GET",
    "list": "css:ul.result li",
    "fields": {
      "title": "css:a.title",
      "detailUrl": "css:a.title@href"
    }
  },
  "detail": { "list": "css:#toc a", "fields": { "title": "css:", "url": "css:@href" } },
  "chapter": { "content": "css:#content" }
}
```

字段的完整含义见 `docs/book-sources.md`。两种规则格式之间的换算见
`docs/kazumi-community-sources.md`。

# 从 Legado（阅读）书源转换

Legado 的书源格式和本项目**不是一套东西**，但有一半以上的规则可以机械映射过来。项目带一个转换器：

```bash
node scripts/legado-convert.mjs <输入.json> [--out sources/from-legado]
```

它对每个书源给出三种结果：**可转换**、**可转换但有降级**（警告）、**无法转换**（附具体原因）。转出来的文件会先过一遍本项目的校验器，能通过才会写出。

> **设计立场**：宁可拒绝，也不产出"跑起来返回空"的半成品。一个静默失败的书源，排查成本远高于一句"这条规则做不到"。

---

## 一、实测结果

用一批真实 Legado 书源（起点、番茄、酷我、69书吧、阅友、速读谷等）跑转换器：

| 书源 | 结果 | 原因 |
|---|---|---|
| 酷我小说 | ✅ **转换并跑通** | 纯 JSON API，规则几乎一一对应 |
| 就爱文学 | ✅ 转换成功 | 但站点是 GBK，正文会乱码（见 [四、2](#2-编码)） |
| 天天看小说 | ✅ 转换成功 | 站点当前有反爬，未验证 |
| 阅友小说 | ❌ | 书页地址藏在 `onclick` 里，需要 JS 提取 |
| 起点中文 | ❌ | `java.ajax` + 浏览器验证 |
| 番茄小说2 | ❌ | 大量 `java.*` 桥 + 第三方付费接口 |
| 速读谷 | ❌ | 封面用 `book.origin` 拼接 + XPath 翻页 |
| 69书吧 / 八一 / 和图书 … | ❌ | 人机验证需要 `java.startBrowserAwait` |

**酷我小说的转换结果已随仓库提供**：`sources/legado-kuwo.json`。实测在打包应用里走通：

```
搜索「系统」 → 卡片「系统之重生这件小事」
详情（独立目录页） → 966 章
读一章 → 51 段 / 2171 字
```

---

## 二、映射表

| Legado | 本项目 | 说明 |
|---|---|---|
| `bookSourceName` | `name` | |
| `bookSourceUrl` | `homepage` | |
| `bookSourceType` | `type` | 0→novel，1→audio，2→comic |
| `enabled` | `enabled` | |
| `header` | `request.headers` | 单引号对象按宽松方式解析 |
| `searchUrl` | `search.url` | `{{key}}`→`{{keyword}}`；相对路径按 homepage 补全 |
| `searchUrl` 的 `,{'method':'POST','body':…}` | `search.method` / `search.body` | |
| `ruleSearch.bookList` | `search.list` | |
| `ruleSearch.name` / `author` / `coverUrl` / `intro` | `search.fields.title` / `author` / `cover` / `intro` | |
| `ruleSearch.bookUrl` | `search.fields.detailUrl` | |
| `ruleBookInfo.name` / `author` / `intro` / `coverUrl` | `detail.title` / `author` / `intro` / `cover` | |
| `ruleBookInfo.init` | 折进各字段前缀 | 例如 `$.data` + `$.title` → `$.data.title` |
| `ruleBookInfo.tocUrl` | **`detail.tocUrl`** | 独立目录页 |
| `ruleToc.chapterList` | `detail.list` | |
| `ruleToc.chapterName` / `chapterUrl` | `detail.fields.title` / `url` | |
| `ruleContent.content` | `chapter.content` | |
| `ruleContent.nextContentUrl` | `chapter.nextUrl` | |

### 选择器语法的对应

| Legado | 本项目 |
|---|---|
| `//meta[@property='og:x']/@content` | `css:meta[property="og:x"]@content` |
| `class.bookbox` | `css:.bookbox` |
| `id.list` | `css:#list` |
| `tag.a.0@href` | `css:a@href` |
| `class.author@class.name.0@text` | `css:.author .name` |
| `#author@tbody@tr!0` | `css:#author tbody tr`（表头行由引擎自动跳过） |
| `a@text` / `text` | `css:`（当前元素） |
| `href` / `src` | `css:@href` / `css:@src` |
| `$.data.items[*]` | 原样保留 |
| `{{$.field}}`（JSON 列表） | `@js:'前缀'+String(input.field)` |

**列表语义**：Legado 的 `bookList: "$.data"`（`data` 本身是数组）在本项目里也直接可用——引擎的列表步骤会把命中的数组展开一层。

---

## 三、无法转换的规则

| Legado 能力 | 为什么不行 |
|---|---|
| `java.ajax` / `java.getElement` / `java.put` | JS 在沙箱里跑，没有 Java 桥 |
| `java.startBrowserAwait` | 需要人机交互（验证码、登录），引擎没有内嵌浏览器等待 |
| `cookie.getCookie` / `setCookie` | 不维护 cookie jar（该功能已搁置） |
| `source.getVariable` / `getLoginInfoMap` | 没有书源变量与登录信息存储 |
| `book.origin` / `book.durChapterTitle` | 没有阅读器运行时对象 |
| `org.jsoup.*` | 沙箱里没有 Jsoup |
| XPath（`//div[@id='x']/a`） | 引擎只支持 CSS；只有 `//meta[@…]/@content` 这一种会被自动改写 |
| `##正则##替换` | 引擎不做正则变换。**这是最常踩的降级**：会丢，但会警告 |
| `<js>…</js>` 整段规则 | 同上（含 `java.`/`source.`/`cookie.` 的必然失败） |
| `@onclick@js:…` | 属性 + JS 处理；CSS 列表字段上不支持 `@js:` |
| 正则型章节列表（`:"sS":(\d),…`） | 那不是选择器，是把整个响应当字符串解析 |
| `searchUrl` 含 `{{page-1}}` | 页码基准不同，转换器会改 `{{page}}` 并警告差 1 |

---

## 四、两个站点级障碍（与规则无关）

### 1. 独立目录页

很多站的详情页只放简介，章节在另一个页面。本项目原本**没有** `tocUrl`，导致这类源全部转不了。

**已补上**：`detail.tocUrl` 是在详情页上求值、得到目录页地址的选择器；引擎先取详情页拿书名/封面/简介，再取目录页拿章节。不写 `tocUrl` 的源仍然只发一次请求。

```jsonc
"detail": {
  "list": "css:.ccss a",
  "fields": { "title": "css:", "url": "css:@href" },
  "tocUrl": "css:.newrap a@href"    // 详情页 → 目录页
}
```

### 2. 编码

`net.rs` 目前**固定按 UTF-8 解码**。GBK / GB2312 站点（中文小说站里非常常见）拿到的会是乱码。

转换器检测到 Legado 的 `charset: gbk` 会给出警告，但**不修正**——这需要引擎支持按 `Content-Type` 或 `<meta charset>` 解码。目前没做。

---

## 五、转换之后仍然要人工检查

自动转换保证的是**结构合法**，不保证**选择器真的对**。转完请至少核一遍：

1. `search.list` 选中的是不是"一本书"而不是整块列表
2. 详情页书名选择器（`detail.title`）取的是书名而不是章节名
3. 章节列表数量是否合理（几百章，不是 1 章也不是 0 章）
4. 正文是否有分段（如果只有一段，说明选择器选到了容器但没有块级子元素）

用 `node scripts/verify-ui-legado.mjs <文件> <关键词>` 可以直接在打包应用里跑一遍搜索→详情→正文。

---

## 六、如果想让更多源可用

按性价比排序：

| 改动 | 解锁什么 | 规模 |
|---|---|---|
| 按 charset 解码（`net.rs`） | 所有 GBK 站点 | 小 |
| CSS 列表字段支持 `@js:` | 从 `onclick`/`data-*` 里规整 URL | 中（`selectFromElement` 要改成异步） |
| `##正则` 变换 | 大量带前后缀清理的源 | 中 |
| 基础 XPath 子集 | 相当一部分老站 | 大 |
| cookie jar + 登录 | 需要登录的站 | 已搁置 |
| 内嵌浏览器等待 | 人机验证站 | 大，且收益有争议 |

前两项加起来大概能让真实源的可转换率从 ~30% 提到 ~60%。

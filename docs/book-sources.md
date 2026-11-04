# 书源（Book Sources）

书源是一份 JSON，描述怎么从一个网站取书。导入后，应用按这份定义搜索、浏览、阅读、下载——加一个网站不需要改代码。

> **本文讲"为什么这样设计"**：安全边界、取舍、界面与已知限制。
> **字段怎么写、有哪些约束、报错怎么读**，看 [`book-source-api.md`](book-source-api.md)——那份是字段级参考，本文不重复。

---

## 一、先说清楚边界

这是项目里**唯一会联网**的功能。README 与项目总览原本写着「不联网」，书源上线后这条改成了：

> 阅读不联网；书源板块需要联网，且只访问你添加的书源所指向的网站。

具体是：

| 板块 | 联网 |
|---|---|
| 看板 / 资料库 / 本地阅读（TXT、PDF、EPUB、音频） | 完全不联网 |
| 书源板块 | 会，但只请求书源定义的地址 |

首次进入书源板块会显示这条提示，不是可关闭的装饰。

**不上传任何本地数据。** 请求只带书源自己声明的 header，不带资料库内容、不带阅读进度、不带任何标识。

---

## 二、书源 JSON

一个书源的最小骨架：

```jsonc
{
  "schemaVersion": 1,
  "id": "example",                    // 稳定标识，进度的 key 前缀
  "name": "示例书源",
  "version": "1.0.0",
  "homepage": "https://example.com",
  "type": "novel",                    // novel | comic | audio | video
  "enabled": true,

  "request": {
    "headers": { "User-Agent": "Mozilla/5.0" },
    "timeoutMs": 15000,
    "delayMs": 300
  },

  "search": {
    "url": "https://example.com/search?q={{keyword}}",
    "method": "GET",
    "list": "css:.book-list li",
    "fields": {
      "title":     "css:.title",
      "detailUrl": "css:a@href"
    }
  },

  "detail": {
    "list": "css:.chapters a",
    "fields": { "title": "css:", "url": "css:@href" },
    "title": "css:.book-title",
    "cover": "css:img@src"
  },

  "chapter": {
    "content": "css:#content p",
    "nextUrl": "css:a[rel=next]@href"
  }
}
```

**每个字段的类型、约束、默认值与报错，见 [`book-source-api.md`](book-source-api.md)。** 本文不重复列字段表——两处各写一遍必然走偏，那正是文档最容易失效的方式。

这里只留三句必须记在脑子里的：

- **选择器前缀是封闭集合**：`$.`（JSON）/ `css:`（HTML）/ `@js:`（沙箱内计算），写别的直接校验失败
- **`@js:` 在隔离沙箱里跑**，没有网络也没有 DOM，3 秒超时——这是安全边界，不是可选优化
- **请求只能 GET/POST、只能 http(s)**，请求头白名单只有 `User-Agent` / `Accept` / `Accept-Language` / `Referer` / `Content-Type`

---

## 三、引擎替你处理的三件事

写书源时不必自己解决，但知道它们存在会少踩坑。

### 1. 正文的段落会被保留

`textContent` 会把整章压成一行，读起来是没法读的。引擎在提取文本时会识别块级元素（`<p>`、`<div>`、`<br>` 等）并在边界处换行，所以 `chapter.content` 选到一个容器时，段落结构是保留的。

**这也意味着 `chapter.content` 是"取全部匹配"的语义**：`css:#content p` 会拿到所有段落再拼接。这样一来，夹在段落旁边的导航文字（如「本章未完，点击下一页」）就不会混进正文——选 `p` 就行。

### 2. 章节分页会自动跟随

很多站点把一章拆成 `xxx.html`、`xxx_2.html`、`xxx_3.html`，每页带一个"下一页"链接。声明 `chapter.nextUrl` 后，引擎会一直跟到没有下一页为止，把各页正文拼起来。

```jsonc
"chapter": {
  "content": "css:#content p",
  "nextUrl": "css:a[rel=next]@href"
}
```

保护措施：最多跟 20 页，且记录已访问 URL——指向自己的 `next` 链接不会死循环。

> **注意**：确认最后一页**没有** `rel="next"`。有些站点把"下一章"也标成 `rel=next`，那样会串到下一章去。写源时务必打开一章的最后一页看一眼。

### 3. 搜索没有封面时，浏览页会补

搜索列表常常只有文字、没有图，封面只存在于详情页。卡片先渲染首字占位，然后在后台按 `detail.cover` 逐本补图，拿到一张更新一张。

- 串行请求，间隔用书源自己的 `request.delayMs`，不对站点连发
- 最多补 24 张（约前两屏），超出部分保留占位——这是有意的取舍，不是遗漏
- 切换书源或离开页面会取消未完成的补图

图片通过 `<img>` 直接加载，不经过 IPC：封面是静态资源，不需要 CORS。

---

### `@js:` 能做什么，不能做什么

表达式拿到一个 `input`（已抓取并解析好的数据），返回字符串或字符串数组。

**能**：`JSON`、`Math`、`Date`、字符串/数组/对象方法、正则。

**不能**（沙箱里根本没有）：`fetch`、`XMLHttpRequest`、`localStorage`、`document`、`window`、`parent`，以及 `window.__TAURI_INTERNALS__`。

导入时还会做静态检查，出现这些标识符会直接拒绝，错误信息指向具体字段。

---

## 四、安全模型

三层，逐层收紧：

### 1. 校验期（`schema.ts`）

结构、类型、枚举、选择器前缀、URL 协议、占位符白名单、JS 危险标识符。全部通过才入库。

**诚实说明**：schema 只能约束结构。`@js:` 里写什么，schema 管不了——这是"严格约束"与"允许 JS"之间的固有矛盾。所以还有下面两层。

### 2. 运行期沙箱（`sandbox.ts`）

```
<iframe sandbox="allow-scripts" srcdoc="...">   ← 故意不给 allow-same-origin
```

- 独立不透明源：摸不到父页面 DOM，摸不到 `__TAURI_INTERNALS__`
- 只通过 `postMessage` 收发，且校验 `event.source` 必须是这个 frame
- 表达式被包在 `with (SAFE_GLOBALS)` 里，全局面收窄
- 结果在跨边界前被规范化，对象不会传出来
- **3 秒超时**，超时销毁整个 frame 重建（死循环无法从外部中断）

### 3. 传输期（`net.rs`）

- 只允许 `GET` / `POST`
- 只允许 `http` / `https`；重定向到 `file:`、`data:` 等一律拒绝
- 硬超时、响应体 10 MB 上限
- 请求头只放行 `user-agent` / `accept` / `accept-language` / `referer` / `content-type`
- 响应头只回传 `content-type` / `content-length` / `location`
- **书源不能自己设 `Cookie`**：它不在放行头里。登录凭证只能来自凭证存储，由后端按 host 注入（该功能已实现但**搁置未完成**，见 [`login-credentials.md`](login-credentials.md)）
- **不维持会话**：不解析 `Set-Cookie`、不做自动续期

### 这不是绝对安全

浏览器沙箱逃逸漏洞历史上出现过，将来也会有。这套设计做到的是：

- 常见的恶意写法（想联网、想读父页面、想调 Tauri）**失败**
- 失控的表达式**不会拖死应用**
- 请求**出不去** http(s) 之外

做不到的是"证明不存在任何逃逸"。文档里写清楚这一点，比宣称安全更有用。

---

## 五、数据存放

```
%APPDATA%/app.litearti.reader/
├── library/              ← 本地书，书源不碰
│   ├── library.json
│   └── files/
└── sources/
    ├── sources.json      ← 书源定义
    └── progress.json     ← 书源阅读进度
```

书源与资料库**完全分离**：删掉书源不影响已导入的书；导入的书也不依赖书源。

阅读进度按 `书源 id + 章节 url` 记录，与本地书的进度是两套——因为章节 URL 会失效，而本地文件不会。

---

## 六、界面

侧栏第三项「书源」。

**书源管理**
- 列表：名称、类型、版本、主页、启用开关、删除
- 导入：选 JSON 文件 → 校验 → 通过则入库，失败逐条列出问题（带字段路径）
- 模板：一键查看/复制一份可用骨架

**浏览**
- 顶部选书源 + 搜索框
- **「访问网站」**：在系统浏览器打开书源主页（不占用应用窗口）
- **搜索框也接受书籍目录页网址**：粘贴 `https://…/xs/250929/` 会当作该书的详情页直接打开，
  而不是当成关键词去搜索——链接不是关键词，拿去搜只会得到空结果
- 卡片网格：**封面 + 标题 + 类型标签 + 作者/简介**
- 封面先显示首字占位块，后台从详情页逐本补图（串行 + `delayMs` 间隔，最多 24 张）；
  补不到就保持占位，不显示破图
- 类型是文字标签（小说/漫画/听书/视频），不用颜色区分

**详情**
- 封面、标题、作者、简介、章节数
- 章节列表
- 「在线阅读」（主）/「下载并导入」（次）

**阅读**
- 排版与本地 TXT 阅读器一致：`--measure-prose` 行宽、`--leading-relaxed` 行高、字号 13–28px
- 上一章 / 下一章，进度按章内比率记忆

---

## 七、下载

两条路径：

1. **有 `download.url`**：抓直链，按 `download.format` 导入
2. **没有**：把所有章节正文拼接成一个 `.txt`

两条都走 `source_download_import` → 临时文件 → 现有 `library_import` → 删临时文件。所以判重、原子写、失败报告与手动导入完全一致。

**已知限制**：直链路径拿的是文本响应，二进制文件（如真 MP3/PDF）会被重新编码。需要二进制下载的源应提供文本安全的端点，或走章节拼接。这条写在限制里，没有藏着。

---

## 八、一个完整的真实例子

`sources/bqg5555.json` 是随仓库附带的一个可用书源，针对 `https://www.bqg5555.cc/`。它不是"内置书源"，而是写书源时可以直接对照的样例。

> **那个 JSON 文件是唯一权威版本。** 本文与 [`book-source-api.md`](book-source-api.md) 里出现的副本只用于讲解——两者如有出入，以文件为准。

这个站有几个典型特征，正好演示上面的能力：

| 特征 | 书源里的写法 |
|---|---|
| 搜索是 POST 表单 | `method: POST` + `body: "type=articlename&searchkey={{keyword}}"` |
| 结果表格有表头行 | 表头 `<li>` 里没有 `.s2 a`，取不到标题，自动跳过 |
| 搜索无封面 | 靠浏览页的后台补全 |
| 详情页元信息在 og meta | `css:meta[property="og:novel:book_name"]@content` |
| 章节分 2–3 页 | `nextUrl: css:a[rel="next"]@href` |
| 正文旁边有"本章未完"链接 | `content: css:#content p`，只取段落 |

```jsonc
{
  "schemaVersion": 1,
  "id": "bqg5555",
  "name": "笔趣阁 bqg5555",
  "version": "1.0.0",
  "homepage": "https://www.bqg5555.cc/",
  "type": "novel",
  "request": {
    "headers": {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Referer": "https://www.bqg5555.cc/"
    },
    "timeoutMs": 20000,
    "delayMs": 500
  },
  "search": {
    "url": "https://www.bqg5555.cc/search/",
    "method": "POST",
    "body": "type=articlename&searchkey={{keyword}}",
    "list": "css:ul.txt-list li",
    "fields": {
      "title": "css:.s2 a",
      "author": "css:.s4",
      "detailUrl": "css:.s2 a@href"
    }
  },
  "detail": {
    "list": "css:#info ~ .section-box a",
    "fields": { "title": "css:", "url": "css:@href" },
    "title": "css:meta[property=\"og:novel:book_name\"]@content",
    "author": "css:meta[property=\"og:novel:author\"]@content",
    "cover": "css:.imgbox img@src",
    "intro": "css:#m_desc"
  },
  "chapter": {
    "content": "css:#content p",
    "nextUrl": "css:a[rel=\"next\"]@href"
  }
}
```

两处值得留意的选择器：

- **`css:#info ~ .section-box a`** ——详情页有两个章节区块（"最新章节"和"正文"）。用兄弟选择器 `~` 只取 `#info` 之后的那个，否则章节会重复一遍。
- **`css:meta[property="og:novel:book_name"]@content`** ——比去 `<h1>` 里抠文本稳，站点改版时 meta 往往不动。

**这个源会失效**：站点改版、换域名、加反爬都会让选择器对不上。那时要改的是 JSON，不是代码。

---

## 九、明确不做

| 不做 | 原因 |
|---|---|
| 内置真实书源 | 引擎优先；站点会变，维护成本在你 |
| 订阅 URL 拉书源 | 引入"从网上拿代码"的二次风险 |
| Cookie / 登录态 | 代码已实现（应用内登录窗口 + WebView2 抓取），但**端到端未验证、搁置**，仓库里没有任何声明 `auth` 的书源。见 [`login-credentials.md`](login-credentials.md) |
| JS 里发网络请求 | 沙箱不提供，故意的 |
| 反爬对抗（验证码、指纹） | 不做，也不该做 |
| 书源市场 / 分享 | 涉及内容合规，不碰 |

## 十、已知限制

| 限制 | 影响 | 可能的解法 |
|---|---|---|
| 选择器表达式能力有限 | 需要签名的站点表达不了 | 允许受限 JS 已覆盖大部分；再复杂就需要真实 JS 引擎 |
| **CSS 列表的字段上 `@js:` 静默失效** | 该字段永远是 `null`，且不报错 | 把 `selectFromElement` 改成异步并传入沙箱；文档里给了可用位置表 |
| 单页抓取 | 不能自动翻页聚合 | 加 `page` 循环与去重 |
| 无缓存 | 每次搜索都请求站点 | 加内存缓存 + TTL |
| 下载二进制受限 | MP3/PDF 直链会损坏 | Rust 侧返回原始字节 |
| 进度不跟随源更新 | 章节 URL 变了就丢进度 | 按章节序号而非 URL 记录 |
| 需要登录的站点 | 登录凭证功能已写但搁置，且不解决字体反爬 | 见 [`login-credentials.md`](login-credentials.md) |

## 十一、验证

| 项 | 状态 |
|---|---|
| `cargo test` | ✅ 63 项（网络规则、书源存储、下载导入、URL 协议） |
| `scripts/verify-source-schema.mjs` | ✅ 55 项（结构/语义/引用、错误信息质量） |
| `scripts/verify-source-selector.mjs` | ✅ 30 项（JSONPath 子集、CSS、属性提取） |
| `scripts/verify-source-engine.mjs` | ✅ 44 项（模板、URL 解析、搜索、详情、章节、**分页跟随**、**段落保留**、死循环保护） |
| `scripts/verify-source-sandbox.mjs` | ✅ 21 项（静态检查沙箱属性与防护） |
| `scripts/verify-ui-sources.mjs` | ✅ 13 项（打包应用：板块渲染、真实 IPC 持久化、沙箱跨源、`file:` 拒绝） |
| `scripts/verify-source-live.mjs` | ✅ 真实网络（bqg5555：搜索→封面→详情→分页章节） |
| `scripts/verify-ui-bqg.mjs` | ✅ 打包应用 + 真实站点（搜索、封面解码、详情、正文） |
| `vue-tsc` / `tauri build` | ✅ 通过 |

> 沙箱的静态检查（`verify-source-sandbox.mjs`）与实机检查（`verify-ui-sources.mjs`）分开：前者在改代码后秒级失败，后者证明真实边界。
>
> 两个 `live`/`bqg` 脚本会访问真实网站，**不属于离线回归套件**——站点不可达或改版时它们会失败，这是预期行为，不代表代码坏了。

# 书源 JSON 与 API 参考

本文是**书源格式的字段级参考**，以及围绕它的三组编程接口：校验器、选择器、引擎。

面向两类读者：

- **写书源的人** —— 看第一到第九节，每个字段的类型、约束、默认值、取值，以及校验器会给出的错误消息。
- **改代码的人** —— 看第十节之后的 TypeScript API，含函数签名、返回类型与错误语义。

想先理解设计取舍（为什么要沙箱、为什么手写校验器），看 [`book-sources.md`](book-sources.md)。本文只讲**是什么、怎么用**。

---

## 目录

- [一、格式总览](#一格式总览)
- [二、顶层字段](#二顶层字段)
- [三、request](#三request)
- [四、search](#四search)
- [五、detail](#五detail)
- [六、chapter](#六chapter)
- [七、download](#七download)
- [八、选择器语法](#八选择器语法)
- [九、占位符](#九占位符)
- [十、默认值汇总](#十默认值汇总)
- [十一、校验器 API](#十一校验器-api)
- [十二、校验错误消息全表](#十二校验错误消息全表)
- [十三、引擎 API](#十三引擎-api)
- [十四、下载与存储 API](#十四下载与存储-api)
- [十五、版本与兼容](#十五版本与兼容)
- [十六、完整示例](#十六完整示例)

---

## 一、格式总览

一个书源是一个 JSON 对象，描述"怎么读某一个网站"。

```jsonc
{
  "schemaVersion": 1,          // 必填，目前只能为 1
  "id": "example",             // 必填，稳定标识
  "name": "示例站",             // 必填，界面显示名
  "version": "1.0.0",          // 必填，书源自身版本
  "homepage": "https://example.com/",  // 必填，http(s)
  "language": "zh",            // 可选
  "type": "novel",             // 必填，novel|comic|audio|video
  "enabled": true,             // 可选，默认 true
  "request": { ... },          // 必填
  "search":  { ... },          // 必填
  "detail":  { ... },          // 必填
  "chapter": { ... },          // 必填
  "download": { ... }          // 可选
}
```

**必填与可选的判定是严格的**：`request` / `search` / `detail` / `chapter` 缺一即校验失败，不会用空对象兜底。理由是一个只有搜索没有章节的书源能通过校验，但打开任何一本书都会失败——把问题推迟到运行期，比在校验期就拒绝更糟。

**未知字段会被忽略，不报错。** 所以 `"serach"` 这种拼写错误不会直接提示"未知字段"，而是表现为 `search 必填字段缺失`——沿着缺哪个字段去找拼错的那个。

### 文件形态

导入时接受两种：

- 单个书源对象 `{ ... }`
- 书源数组 `[ {...}, {...} ]`

`validateSourceFile()` 两者都收，单个对象会被当成只有一个元素的数组。

---

## 二、顶层字段

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `schemaVersion` | number | ✅ | 必须等于 `1` | 版本号，用于将来识别格式变更 |
| `id` | string | ✅ | 见下 | 稳定标识，用于去重、存进度 |
| `name` | string | ✅ | 非空 | 界面显示名 |
| `version` | string | ✅ | 非空 | 书源版本，自由格式 |
| `homepage` | string | ✅ | 合法 http(s) URL | 站点主页，「访问网站」按钮用它 |
| `language` | string | ❌ | 非空（若给） | 如 `zh`，目前只做记录 |
| `type` | string | ✅ | 四选一 | 资源类型，决定卡片上的标签 |
| `enabled` | boolean | ❌ | 布尔 | 默认 `true`；关掉后不在浏览页可选 |
| `auth` | object | ❌ | 见下 | 声明该源需要登录（功能搁置，见 [2.1](#auth-登录声明搁置)） |

### `schemaVersion`

```jsonc
"schemaVersion": 1
```

校验器只接受 `1`。写 `2` 会得到：

```
schemaVersion: 不支持的版本 2，当前支持 1
```

这个字段存在的唯一目的是让将来的格式变更**可检测**，而不是让老文件静默按新规则解析。

### `id`

```jsonc
"id": "bqg5555"
```

规则：`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`

- 只能用**字母、数字、下划线、连字符**
- 必须以**字母或数字**开头（不能用 `-` 或 `_` 开头）
- 最长 **64** 字符

不合法时：

```
id: 只能用字母、数字、下划线和连字符，且以字母或数字开头，最长 64
```

**`id` 是稳定的身份，不是标签。** 三点依赖它：

1. 同一文件里 id 重复会被拒绝（`id「x」与第 2 个书源重复`）
2. 书源阅读进度以 `sourceId` 为前缀存盘
3. 重新导入同 id 的书源视为**更新**，不是新增

所以改 `name` 随意，改 `id` 等于换了一个书源——已有进度会失联。

### `type`

```jsonc
"type": "novel"
```

四选一，对应界面标签：

| 值 | 界面标签 |
|---|---|
| `novel` | 小说 |
| `comic` | 漫画 |
| `audio` | 听书 |
| `video` | 视频 |

它是**书源级**的，一个书源只能是一种资源类型。搜索结果的每张卡片都取这个值——这也是为什么 `search.fields.type` 被移除了（见[第十五节](#十五版本与兼容)）。

### `enabled`

```jsonc
"enabled": true
```

省略即 `true`。设为 `false` 后：

- 资料库不受影响（书源与资料库完全分离）
- 浏览页的书源下拉框里不再出现它
- 已存的阅读进度保留

### `homepage`

浏览器里打开的那个地址，要求能通过 `new URL()` 解析且协议是 http/https。

浏览页的「访问网站」按钮直接用它，经 Rust 的 `open_external` 交给系统浏览器。非 http(s) 会被拒绝两次：校验期一次，`external.rs` 里再一次。

### `auth` 登录声明（搁置）

```jsonc
"auth": {
  "type": "cookie",                     // 必填，目前只有这一种
  "loginUrl": "https://site.com/",      // 可选，默认 homepage
  "host": "site.com"                    // 可选，默认 loginUrl 的 host
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `type` | string | ✅ | 只能是 `cookie` |
| `loginUrl` | string | ❌ | 合法 http(s) URL |
| `host` | string | ❌ | **裸主机名**，不含协议、端口、路径 |

**这个字段目前不保证可用。** 代码路径已经打通大半（打开登录窗口、抓取 Cookie、按 host 注入），但收尾的「窗口被页面自己关掉」分支没有验证通过，功能处于搁置状态。细节、已删除的内容和恢复步骤见 [`login-credentials.md`](login-credentials.md)。

三点设计约束仍然成立，将来接手时必须保持：

1. **`auth` 里不放 Cookie。** 书源是可分享、可导出的文件，凭证存在独立的 `sources/credentials.json`，按 `sourceId` 索引。
2. **`host` 是作用域，不是跳转地址。** Cookie 只发给与该值精确相等的主机；子域名不继承。给 URL 或带端口会被校验拒绝——那样的值永远匹配不上。
3. **没声明 `auth` 的源永远不会收到 Cookie。** 界面也不会给它登录入口。

---

## 三、request

```jsonc
"request": {
  "headers": {
    "User-Agent": "Mozilla/5.0 ...",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://example.com/"
  },
  "timeoutMs": 20000,
  "delayMs": 500
}
```

| 字段 | 类型 | 必填 | 默认 | 约束 |
|---|---|---|---|---|
| `headers` | object | ❌ | `{}` | 值必须是字符串 |
| `timeoutMs` | number | ❌ | `15000` | 1000–60000 |
| `delayMs` | number | ❌ | `300` | 0–10000 |

### headers 的白名单

校验器接受任意键值，但 **Rust 侧只放行四个**（`net.rs` 的 `ALLOWED_REQUEST_HEADERS`）：

```
user-agent  accept  accept-language  referer  content-type
```

写其他头（`Cookie`、`Authorization`、`X-Forwarded-For`…）不会报错，但**不会发送**。

这是有意的：书源是用户提供的 JSON，如果它能设任意请求头，就等于能伪造身份、能尝试绕过站点的访问控制。白名单让"写书源"保持在"读公开页面"的范围内。

需要 `Referer` 的站点很常见（防盗链），它被允许。需要登录态（`Cookie`）的站点**做不了**——这是设计边界，不是遗漏。

### timeoutMs 与 delayMs

- `timeoutMs` 是**单次请求**的超时，不是整本书的。抓 100 章不会因为累计超时被中断。
- `delayMs` 是**连续请求之间**的间隔，用于礼貌抓取。浏览页后台补封面时按它串行等待。

超出范围时：

```
request.timeoutMs: 应在 1000–60000 之间，实际是 500
request.delayMs: 应在 0–10000 之间，实际是 60000
```

`delayMs: 0` 合法但不推荐——对站点不友好，也更容易触发限流。

---

## 四、search

```jsonc
"search": {
  "url": "https://example.com/search/",
  "method": "POST",
  "body": "type=articlename&searchkey={{keyword}}",
  "list": "css:ul.txt-list li",
  "fields": {
    "title": "css:.s2 a",
    "author": "css:.s4",
    "cover": "css:img@src",
    "intro": "css:.intro",
    "detailUrl": "css:.s2 a@href"
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `url` | string | ✅ | — | 搜索地址，可含占位符 |
| `method` | `"GET"` \| `"POST"` | ❌ | `"GET"` | 请求方法 |
| `body` | string | ❌ | — | POST 请求体，同样支持占位符 |
| `list` | string | ✅ | — | 列表选择器（选出一批条目） |
| `fields.title` | string | ✅ | — | 标题 |
| `fields.detailUrl` | string | ✅ | — | 详情页地址 |
| `fields.author` | string | ❌ | — | 作者 |
| `fields.cover` | string | ❌ | — | 封面 |
| `fields.intro` | string | ❌ | — | 简介 |

### url 与 body 都会做占位符替换

两个都替换是必须的。早期版本只替换 `url`，POST 站点的 `body` 里会带着字面量 `{{keyword}}` 发出去——**任何关键词都返回同一批结果**，看起来像"搜索坏了但没报错"。

```jsonc
// 典型的 POST 站点
"method": "POST",
"body": "type=articlename&searchkey={{keyword}}"
```

### list 的两种求值方式

`list` 决定后面 `fields` 怎么求值，**由选择器前缀决定**：

| `list` 前缀 | 行为 |
|---|---|
| `css:` | 选出多个 DOM 元素，每个元素的文本作为该字段的求值上下文 |
| `$.` | 选出多个 JSON 对象，每个对象作为 `input` |

**混用会报错**：

```
列表选择器需要 JSON 响应      ← 用 $. 但响应是 HTML
json list against html is an error（测试里的原文）
```

实际提示是 `列表选择器需要 JSON 响应`。

### fields 的逐条语义

对每个列表条目：

- `title` —— 取不到就**跳过这一条**（不是报错）。列表页的表头行、广告行因此会被自动过滤。
- `detailUrl` —— 取不到也**跳过**。取出后按页面 URL 解析成绝对地址。
- `author` / `cover` / `intro` —— 取不到就是 `null`，卡片照常显示。

`cover` 会做绝对化，所以写 `css:img@src` 拿到 `/img/a.jpg` 也没问题。

### 为什么没有 `fields.type`

早期版本这里有 `type`，但**引擎从不读它**。卡片的资源类型来自顶层的 `type`。一个写了不生效的配置项比没有更糟，所以在 `schemaVersion: 1` 定稿时删掉了。写它不会报错（未知字段被忽略），但也不会生效。

---

## 五、detail

```jsonc
"detail": {
  "list": "css:#info ~ .section-box a",
  "fields": {
    "title": "css:",
    "url": "css:@href"
  },
  "title": "css:meta[property=\"og:novel:book_name\"]@content",
  "author": "css:meta[property=\"og:novel:author\"]@content",
  "cover": "css:.imgbox img@src",
  "intro": "css:#m_desc"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `list` | string | ✅ | 章节列表选择器 |
| `fields.title` | string | ✅ | **单章**标题（相对列表条目） |
| `fields.url` | string | ✅ | 章节地址（相对列表条目） |
| `title` | string | ❌ | **书**的标题（相对整个详情页） |
| `author` | string | ❌ | 书的作者 |
| `intro` | string | ❌ | 书简介 |
| `cover` | string | ❌ | 书封面 |

### `fields.title` 和 `title` 是两回事

这是最容易写错的地方：

- `detail.fields.title` —— **章节**的标题。在 `list` 选出的**每个章节元素**上求值。
- `detail.title` —— **书**的标题。在**整个详情页**上求值，只求一次。

早期版本只有 `fields.title`，结果书的标题会被写成第一章的名字。现在两者分开。

`detail.title` 取不到时，书名为 `未命名`——此时浏览页会用粘贴的 URL 末段作为回退（见 `itemFromUrl`）。

### `author` 的回退

`detail.author` 缺失或取不到时，会退一步用 `search.fields.author` 在详情页上求值。

这个回退是有意的：很多站点详情页和列表页用同一个 class 表示作者，写一次就能两处生效。

### `list` 的求值

`css:` 前缀 → 选出元素，逐元素求 `fields.title` 与 `fields.url`。

章节地址会按**详情页 URL** 绝对化。标题或地址任一为空的条目被跳过。

> **常见坑**：详情页常有两个章节区（"最新章节"和"正文"）。不用兄弟选择器限定范围，章节会重复一遍。`css:#info ~ .section-box a` 里 `~` 的作用就是只取 `#info` 之后的那个区块。

---

## 六、chapter

```jsonc
"chapter": {
  "content": "css:#content p",
  "nextUrl": "css:a[rel=\"next\"]@href"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `content` | string | 必填 | 正文选择器 |
| `nextUrl` | string | 可选 | 下一分页地址 |

### content 是"取全部匹配"语义

`chapter.content` 与 `search.list` 不同：它**不是**"选出元素再逐条求值"，而是**取出所有匹配并拼接**。

```jsonc
"content": "css:#content p"   // 取到所有 <p>，按顺序拼成正文
```

这个设计解决了一个具体问题：正文旁边常有导航文字（"本章未完，点击下一页"）。选 `#content` 会把它一起抓进来；选 `#content p` 只取段落，导航文字自然被排除。

### 段落结构会被保留

提取文本时识别块级元素（`p` / `div` / `br` / `h1`–`h6` / `li` / `tr` / `blockquote` / `pre` 等）并在边界处换行，然后：

- 每行首尾空白与连续空格压缩
- 连续空行折叠成一个
- 整体 trim

所以选一个容器（`css:#content`）也能得到分段的正文，不会压成一堵墙。

### nextUrl 与分页跟随

声明后，引擎会一直跟随到**取不到 nextUrl 为止**，把各页正文按顺序拼接。

```
第 1 页 ──next──▶ 第 2 页 ──next──▶ 第 3 页 ──(无 next)──▶ 停止
          拼接              拼接              拼接
```

两道保险：

| 保险 | 值 | 作用 |
|---|---|---|
| 页数上限 | 20 页 | 防止选择器永远匹配到东西导致无限抓取 |
| 已访问集合 | 按 URL 去重 | 指向自己/环形的 `next` 立即停止 |

> **务必确认末页没有 `rel="next"`**。有些站点把"下一章"也标成 `rel=next`，那样会串到下一章——症状是章节内容越读越不对。

---

## 七、download

```jsonc
"download": {
  "url": "css:a.download@href",
  "format": "txt"
}
```

| 字段 | 类型 | 必填 | 取值 |
|---|---|---|---|
| `url` | string | ❌ | 选择器，在详情页上求值得到直链 |
| `format` | string | ✅（若 `download` 存在） | `txt` / `epub` / `pdf` / `mp3` |

### 两条下载路径

| 情况 | 行为 |
|---|---|
| 有 `download.url` | 在**详情页**上求值，绝对化后直接取字节 |
| 没有 `download.url` | 逐章抓正文，拼接成一个 `.txt` |

绝大多数小说站只有章节页，走第二条。第一条用于提供整本下载的站点。

两条路径的字节最终都经 `source_download_import`，先写临时文件再复用 `library_import` —— 所以重复检测、原子写、失败报告与手动导入完全一致。

### 已知限制

直链下载走的是同一个 `source_fetch`，它返回的是**文本**响应。二进制文件（MP3、PDF）经过它会被解码破坏。真正可靠的二进制下载需要在 Rust 侧返回原始字节，目前没做。

所以 `format: mp3` 之类目前只在"站点返回的确实是文本"时可靠。章节拼接路径不受影响。

---

## 八、选择器语法

三种，由**前缀**决定。前缀是封闭集合，写别的直接校验失败：

```
选择器必须以 $. / css: / @js: 之一开头
```

### 8.1 JSONPath 子集 `$.`

用于 JSON 接口。

| 写法 | 含义 |
|---|---|
| `$.data.list` | 逐级取键 |
| `$.data.list[0]` | 取数组第 0 项 |
| `$.data.list[*]` | 取数组全部项 |
| `$.data[*].title` | 通配后继续取键 |
| `$.data['a-b']` | 带引号的键（键名含特殊字符时） |
| `$` | 根 |

**不支持**（会明确报错，而不是静默返回空）：

| 语法 | 报错 |
|---|---|
| `..` 递归下降 | `不支持递归下降（..）` |
| `[?(...)]` 过滤 | `不支持过滤表达式（?()）` |
| `[a:b]` 切片 | `不支持切片（[a:b]）` |

其他错误：`JSONPath 必须以 $ 开头`、`JSONPath 方括号未闭合`、`不支持的方括号内容：[x]`。

**值的转换规则**：

| JSON 值 | 结果 |
|---|---|
| 字符串 | 原样 |
| 数字 / 布尔 | 转成字符串 |
| 标量数组 | 用 ` / ` 连接 |
| `null` / 对象 | 跳过 |

对象不会变成 `[object Object]` —— 它作为一个字段值没有意义，直接跳过。

### 8.2 CSS `css:`

用于 HTML 页面。

| 写法 | 含义 |
|---|---|
| `css:.book .title` | 后代选择器 |
| `css:ul li` | 标签 |
| `css:#info` | id |
| `css:a[rel="next"]` | 属性 |
| `css:#info ~ .box a` | 兄弟选择器 |
| `css:.s2 a` | 组合 |
| `css:` | **空**：文档/当前元素的正文 |

#### `@属性`

```
css:a@href        取 href
css:img@src       取 src
css:meta[property="og:title"]@content   取 content
```

用**最后一个** `@` 分割，所以属性名里含 `@` 也不至于切错。

#### `css:@href` —— 当前元素自己的属性

`@` 出现在**位置 0** 是合法的，表示"当前元素自身的属性"。这在章节列表里是必需的：

```jsonc
"list": "css:.chapters a",
"fields": {
  "title": "css:",       // <a> 自己的文本
  "url":   "css:@href"   // <a> 自己的 href
}
```

> 早期版本用 `at > 0` 判断，导致所有 `css:@href` 静默返回 `null` —— 章节一条都解析不出来。现在用 `at >= 0`。这个 bug 值得记住，因为它在错误的地方表现为"没有章节"，而不是"选择器写错了"。

#### `css:` 空选择器

`css:` 后面什么都不写，表示**当前上下文元素本身**：

- 在 `list` 选出的元素上求值 → 该元素
- 在整页上求值 → `document.body`

#### 文本提取的两种模式

引擎按**内容**决定怎么取文本：

| 元素内容 | 取法 | 例子 |
|---|---|---|
| 只含行内内容 | 空白折叠成单空格 | 标题、作者 |
| 含块级子元素或 `<br>` | 保留换行（块级边界换行） | 章节正文 |

这样标题不会变成 `第一章\n俗套的重生`，正文也不会变成一整行。

`<script>` / `<style>` / `<noscript>` 的内容不参与提取。

### 8.3 JS 表达式 `@js:`

```
@js:input.trim().replace(/\s+/g, ' ')
```

#### 输入与输出

表达式里可用变量 **`input`**。它的取值由上下文决定：

```ts
input = payload.json !== undefined
      ? payload.json        // 响应能解析成 JSON 时：给解析后的对象/数组本身
      : payload.html ?? payload.text   // 否则：给 HTML 源码字符串
```

具体到各个位置：

| 位置 | `input` 是 |
|---|---|
| 整页选择器（`detail.title`、`chapter.content`、`chapter.nextUrl` 等） | 响应能解析成 JSON → 该 JSON 值；否则 → 整页 HTML 字符串 |
| `$.` 列表的条目字段 | 该条目的**对象本身**（不是字符串，可以直接 `input.name`） |
| `css:` 列表的条目字段 | 不可用（见 8.4） |

所以 `@js: input.items.map(i => i.name).join(' / ')` 只有在 `input` 是对象时才成立——整页 JSON 接口里可以这么写，HTML 页面上 `input` 是字符串。

表达式**最后的值**作为结果。

| 返回值 | 结果 |
|---|---|
| 字符串 / 数字 / 布尔 | 转成一条结果 |
| 数组 | `null` 项被丢弃，其余逐项转字符串 |
| `null` / `undefined` | 无结果 |
| 对象 | **无结果**（`[object Object]` 无意义） |

#### 可用的全局对象

沙箱里只有这部分：

```
JSON  Math  Date  String  Number  Boolean  Array  Object  RegExp
parseInt  parseFloat  isNaN  decodeURIComponent  encodeURIComponent
```

**没有**：`fetch`、`XMLHttpRequest`、`localStorage`、`document`、`window`、`parent`。

#### 被静态拒绝的标识符

校验期就会报错的（`BANNED_IDENTIFIERS`）：

```
fetch  XMLHttpRequest  WebSocket  EventSource  importScripts
import(  eval(  new Function  Function(
document  window  parent  top
localStorage  sessionStorage  indexedDB
__TAURI_INTERNALS__  require(  process.
```

命中时报：

```
JS 表达式不能使用 fetch（沙箱不提供网络与 DOM）
```

#### 括号平衡检查

不是解析器，只数括号：

```
JS 表达式括号不匹配（( 2 个，) 1 个）
```

这条抓的是最常见的作者错误——表达式被截断。

#### 运行期边界

| 项 | 值 |
|---|---|
| 单次执行超时 | **3000 ms**，超时销毁并重建 frame |
| 沙箱启动超时 | 5000 ms |
| iframe 属性 | `sandbox="allow-scripts"`，**故意不含** `allow-same-origin` |
| 加载方式 | `srcdoc`（不发起网络请求） |

不含 `allow-same-origin` 意味着 frame 有独立的 opaque origin：它摸不到父页面的 DOM、cookie、storage，也摸不到父窗口上的 `__TAURI_INTERNALS__`。

**这是风险降低，不是安全证明。** 浏览器沙箱逃逸过去存在、将来也会存在。它保证的是"最普通的那类攻击失败"，以及"跑飞的表达式不会拖死应用"。

### 8.4 `@js:` 在哪些位置可用

**不是所有字段都支持 `@js:`**，而且不支持的地方是**静默返回 `null`**，不会报错。这一点必须查表确认，否则会得到"某个字段永远是空"的怪现象。

| 字段 | `@js:` 可用 | 原因 |
|---|---|---|
| `search.list` | ✅ | 走异步求值，能进沙箱 |
| `search.fields.*`（列表是 `$.`） | ✅ | 每个对象走异步求值 |
| `search.fields.*`（列表是 `css:`） | ❌ **静默 null** | 走同步的 `selectFromElement`，没有沙箱 |
| `detail.list` | ❌ 报错 | 只认 `css:` 与 `$.` 两种分支 |
| `detail.fields.title` / `url`（`css:` 列表） | ❌ **静默 null** | 同 `search.fields` |
| `detail.fields.*`（`$.` 列表） | ✅ | 异步求值 |
| `detail.title` / `author` / `intro` / `cover` | ✅ | 整页异步求值 |
| `chapter.content` | ✅ | 异步求值，且带 `all` 语义 |
| `chapter.nextUrl` | ✅ | 异步求值 |
| `download.url` | ✅ | 异步求值 |

**为什么会有这个差别**：选择器分两条求值路径。

```
整页 / 列表 / 正文选择器  →  engine.evaluate()      → 可 async、可进沙箱  → @js: 可用
条目字段（CSS 列表下）    →  selectFromElement()   → 同步、无沙箱访问     → @js: 不可用
```

`selectFromElement` 是同步函数，拿不到沙箱实例，所以它只能做 CSS。这不是设计选择，是历史结构留下的边界——支持它需要把这条路径改成异步并传入 sandbox。

**实用建议**：需要在条目字段上做字符串加工时，优先用 CSS 属性选择器或 JSONPath 解决；实在需要 JS，改成"列表用 `$.` 选择 JSON 接口"，那条路径支持 `@js:`。

> 这是当前版本最值得记住的坑。它不报错，只是安静地给你 `null`。

---

## 九、占位符

`search.url` 与 `search.body` 支持 `{{名字}}` 形式。

| 占位符 | 状态 | 值 |
|---|---|---|
| `{{keyword}}` | ✅ 已实现 | 搜索关键词（URL 编码） |
| `{{page}}` | ✅ 已实现 | 页码，从 1 开始 |
| `{{id}}` | ⚠️ 仅校验放行 | 引擎**不提供**，会保留字面量 |
| `{{url}}` | ⚠️ 仅校验放行 | 同上 |

替换时会做 `encodeURIComponent`，所以关键词里有空格、`&`、中文都不需要自己转义。

**`{{id}}` 与 `{{url}}` 是预留的**：校验器允许（`URL_VARIABLES` 里有），但引擎的 `search()` 只传入 `{ keyword, page }`，这两个不会被替换，会以字面量留在 URL 里。要用它们得先改引擎。

写错的占位符：

```
search.url: 未知的占位符 {{kw}}，可用：keyword / page / id / url
```

> 注意 `{{page}}` 目前**只替换、不循环**。引擎的 `search(keyword, page)` 支持传页码，但界面只调用 `page = 1`。也就是说声明了 `&page={{page}}` 的源不会自动翻页聚合，只取第一页。自动翻页是计划中的功能。

---

## 十、默认值汇总

省略这些字段时的实际取值：

| 字段 | 默认值 |
|---|---|
| `enabled` | `true` |
| `request.headers` | `{}` |
| `request.timeoutMs` | `15000` |
| `request.delayMs` | `300` |
| `search.method` | `"GET"` |
| `language` | `undefined` |
| `detail.title` / `author` / `intro` / `cover` | `undefined`（不提取） |

取值范围：

| 字段 | 范围 |
|---|---|
| `request.timeoutMs` | 1000 – 60000 |
| `request.delayMs` | 0 – 10000 |
| `id` 长度 | 1 – 64 |

---

## 十一、校验器 API

```ts
import { validateSource, validateSourceFile } from '@/sources/schema'
```

### `validateSource(input: unknown): ValidationResult`

校验**单个**书源。

```ts
const result = validateSource(JSON.parse(text))
if (!result.ok) {
  for (const issue of result.issues) {
    console.log(`${issue.path}: ${issue.message}`)
  }
} else {
  console.log(result.source!.id)  // 已补全默认值
}
```

**返回全部问题，不是第一个。** 修一个书源时能看到完整清单，而不是打地鼠。

```ts
interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  source?: BookSource   // 仅当 ok 为 true
}

interface ValidationIssue {
  path: string      // 点分路径，如 "search.fields.title"；顶层问题为空串
  message: string   // 中文，指向具体字段
}
```

`source` 是**补全默认值之后**的对象，不是原始输入。所以引擎拿到的一定是字段齐全的 `BookSource`，不必到处判空。

### `validateSourceFile(input: unknown): { ok, issues, sources }`

校验一个**文件**，接受单对象或数组。

在 `validateSource` 之上多做两件事：

1. **路径加索引前缀**：数组里第 2 个书源的错误路径是 `[1].search.fields.title`
2. **跨条目查重**：同一文件里 `id` 重复会报 `id「x」与第 2 个书源重复`

**部分成功**：某个条目失败不影响其他条目进入 `sources`。这一点很重要——一个文件里 8 个源有 1 个写错，其余 7 个仍然可以导入。

```ts
const { ok, issues, sources } = validateSourceFile(JSON.parse(text))
// ok 为 false 时 sources 里仍可能有成功的条目
```

---

## 十二、校验错误消息全表

这是"详细描述"的核心部分：校验器会输出的每一句话，以及它意味着什么。

### 通用

| 消息 | 触发条件 |
|---|---|
| `必填字段缺失` | 该字段为 `undefined` 或 `null` |
| `不能为空` | 字段是字符串但只含空白 |
| `应为字符串，实际是 X` | 类型不符 |
| `应为数字，实际是 X` | 类型不符，或 `NaN` / `Infinity` |
| `应为对象，实际是 X` | 类型不符，或给了数组 |
| `应为布尔值，实际是 X` | 类型不符 |
| `书源必须是一个 JSON 对象` | 顶层不是对象（数组、`null`、标量） |

类型名 `X` 的取值：`string` / `number` / `boolean` / `数组` / `对象` / `null`。

### 顶层

| 消息 | 触发条件 |
|---|---|
| `不支持的版本 2，当前支持 1` | `schemaVersion` 不等于 1 |
| `只能用字母、数字、下划线和连字符，且以字母或数字开头，最长 64` | `id` 不匹配正则 |
| `只支持 http/https，实际是 ftp:` | `homepage` 协议不是 http(s) |
| `不是合法的 URL` | `homepage` 无法解析 |
| `应为 novel / comic / audio / video 之一，实际是 book` | `type` 不在枚举内 |

### request

| 消息 | 触发条件 |
|---|---|
| `应为字符串，实际是 X`（`request.headers.<键>`） | 请求头的值不是字符串 |
| `应在 1000–60000 之间，实际是 500` | `timeoutMs` 越界 |
| `应在 0–10000 之间，实际是 60000` | `delayMs` 越界 |

### search

| 消息 | 触发条件 |
|---|---|
| `应为 GET 或 POST，实际是 PUT` | `method` 非法 |
| `不是合法的 URL` | `url` 无法解析 |
| `只支持 http/https，实际是 X` | `url` 协议非法 |
| `未知的占位符 {{kw}}，可用：keyword / page / id / url` | 占了不认识的占位符 |

### 选择器

| 消息 | 触发条件 |
|---|---|
| `选择器必须以 $. / css: / @js: 之一开头` | 前缀不对 |
| `JS 表达式为空` | `@js:` 后面什么都没写 |
| `JS 表达式不能使用 fetch（沙箱不提供网络与 DOM）` | 命中禁用标识符 |
| `JS 表达式括号不匹配（( 2 个，) 1 个）` | 括号数量不等 |
| `JSONPath 必须以 $ 开头：a.b` | 忘了 `$` |
| `不支持递归下降（..）` | 用了 `..` |
| `不支持过滤表达式（?()）` | 用了 `?()` |
| `不支持切片（[a:b]）` | 用了切片 |
| `不支持的方括号内容：[abc]` | 方括号里既不是数字、`*`，也不是带引号的键 |

### download

| 消息 | 触发条件 |
|---|---|
| `应为 txt / epub / pdf / mp3 之一，实际是 docx` | `format` 非法 |

### 文件级

| 消息 | 触发条件 |
|---|---|
| `id「x」与第 2 个书源重复` | 同文件内 `id` 重复 |

---

## 十三、引擎 API

```ts
import { SourceEngine } from '@/sources/engine'
```

### 构造

```ts
const engine = new SourceEngine(source, fetcher?, sandboxMount?)
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `source` | `BookSource` | 已经过校验的对象 |
| `fetcher` | `Fetcher` | 可注入，默认走 Rust；测试传假函数即可离线 |
| `sandboxMount` | `HTMLElement` | 沙箱 iframe 的挂载点；不用 `@js:` 可不传 |

注入 fetcher 是这个模块可测的关键——所有选择器逻辑都能用固定 HTML 驱动，不需要服务器。

### 方法

```ts
search(keyword: string, page?: number): Promise<SourceItem[]>
detail(detailUrl: string): Promise<SourceDetail>
chapter(chapterUrl: string): Promise<string>
cover(detailUrl: string): Promise<string | null>
itemFromUrl(url: string): Promise<SourceItem>
dispose(): void
```

| 方法 | 做什么 | 失败时 |
|---|---|---|
| `search` | 抓搜索页，逐条解析 | 抛 `SelectorError` 或网络错误 |
| `detail` | 抓详情页，解析书名/作者/封面/简介/章节 | 同上 |
| `chapter` | 抓章节页，跟随 `nextUrl` 拼接正文 | 同上 |
| `cover` | 只抓详情页取封面（用于列表补图） | 无 `detail.cover` 时返回 `null` |
| `itemFromUrl` | 把详情页 URL 变成一个卡片条目 | 没有章节时抛错 |
| `dispose` | 销毁沙箱 frame | — |

#### `itemFromUrl`

供"粘贴书籍网址"使用：不搜索，直接把该 URL 当详情页读。

```ts
const item = await engine.itemFromUrl('https://example.com/xs/250929/')
// { title, author, cover, intro, type, detailUrl }
```

标题取不到时回退到 URL 末段（`250929`），至少能让人认出自己粘的是哪一本。

**必须 `dispose()`**：沙箱持有一个 iframe，离开视图不销毁会一直挂着。

### 返回类型

```ts
interface SourceItem {
  title: string
  author: string | null
  cover: string | null      // 已绝对化
  intro: string | null
  type: ResourceType
  detailUrl: string         // 已绝对化
}

interface SourceDetail {
  title: string             // 取不到时为 "未命名"
  author: string | null
  cover: string | null
  intro: string | null
  chapters: SourceChapter[]
}

interface SourceChapter {
  title: string
  url: string               // 已绝对化
}
```

绝对化的意义：选择器里写相对路径（`/xs/1.html`）是常态，调用方不该关心。

### Fetcher

```ts
type Fetcher = (
  url: string,
  source: BookSource,
  options?: { method?: 'GET' | 'POST'; body?: string },
) => Promise<{ status: number; url: string; body: string }>
```

**`method` 默认 GET。** 只有 `search` 可能传 POST；详情页和章节页永远是 GET。

> 早期版本对每个请求都套用 `search.method`，于是详情页和章节页收到无 body 的 POST，很多站点返回空页面。症状是"章节列表能出来，正文永远空白"——极难从界面反推原因。

### 工具函数

```ts
fillTemplate(template: string, vars: Record<string, string | number>): string
absoluteUrl(href: string | null, base: string): string | null
```

- `fillTemplate` 替换 `{{name}}` 并做 URL 编码；未知变量原样保留
- `absoluteUrl` 按 base 解析；`null` / 空串 / 非法输入返回 `null`

---

## 十四、下载与存储 API

### `downloadItem`

```ts
import { downloadItem, DownloadCancelled } from '@/sources/download'

await downloadItem({
  source,          // BookSource
  title,           // 保存用的书名
  detailUrl,       // 相对链接的基准
  chapters,        // SourceChapter[]
  engine,          // 用来抓章节
  onProgress,      // (done, total) => void，可选
  shouldCancel,    // () => boolean，可选，每章前检查
})
```

| 字段 | 说明 |
|---|---|
| `onProgress` | 逐章回调，让界面显示长书进度 |
| `shouldCancel` | 在**每章请求前**检查，返回 `true` 则抛 `DownloadCancelled` |

取消是协作式的，不能在请求中途打断——但会在下一章开始前停下，不会抓完整本。

### 存储

书源与书源进度存在两个文件，与资料库完全分开：

```
%APPDATA%/app.litearti.reader/sources/
├── sources.json      书源定义（数组）
└── progress.json     书源阅读进度（对象）
```

读取容忍 BOM。写入走临时文件 + rename。

### IPC 命令

| 命令 | 签名 | 说明 |
|---|---|---|
| `sources_load` | `() => any` | 读 `sources.json`，不存在则返回 `[]` |
| `sources_save` | `(sources: any)` | 整份覆盖写 |
| `source_progress_load` | `() => any` | 读 `progress.json` |
| `source_progress_save` | `(progress: any)` | 整份覆盖写 |
| `source_fetch` | `(request) => response` | 唯一的网络出口 |
| `source_download_import` | `(title, extension, bytes) => Entry` | 下载后导入资料库 |
| `read_picked_text_file` | `(path) => string` | 读用户选中的 JSON 文件 |
| `open_external` | `(url) => void` | 系统浏览器打开，仅 http(s) |

`source_fetch` 的请求结构（`net::SourceRequest`）：

```ts
{
  url: string
  method?: 'GET' | 'POST'          // 默认 'GET'
  body?: string                    // 仅 POST 有意义
  headers?: Record<string, string> // 默认 {}
  timeoutMs?: number               // 可选；Rust 侧有默认
}
```

响应（`net::SourceResponse`）：

```ts
{
  status: number
  url: string                      // 跟随重定向后的最终地址
  headers: Record<string, string>  // 响应头
  body: string
}
```

`url` 是最终地址，用于解析相对链接——用请求 URL 解析会在重定向后算错路径。

> 注意两层形状不同：IPC 层返回 `{ status, url, headers, body }`，但 `Fetcher` 只透传 `{ status, url, body }`。引擎不需要响应头，少一层传递少一处不一致。

### 进度键

```ts
progressKey(sourceId, chapterUrl) => `${sourceId}::${chapterUrl}`
```

按**章节 URL** 记进度。已知限制：站点改版换了 URL，进度就对不上了。改成按章节序号记录能解决，但需要处理章节目录变化的合并逻辑，目前没做。

---

## 十五、版本与兼容

### 目前只有一个版本

`SUPPORTED_SCHEMA_VERSION = 1`。写 `2` 会被拒绝，不会尝试兼容解析。

### 相对早期草案的变化

| 变化 | 原因 |
|---|---|
| 移除 `search.fields.type` | 引擎从不读它；卡片的类型来自顶层 `type` |
| 新增 `detail.title` / `author` / `intro` / `cover` | 书的信息在详情页，`fields.*` 是章节的 |
| `chapter.content` 改为"取全部匹配" | 让 `css:#content p` 能排除段落间的导航文字 |
| `chapter.nextUrl` 真正实现 | 早期只定义不读取，长章节只拿到第一页 |

写旧格式的书源仍能导入：多数字段都是新增的可选字段，唯一需要注意的是 `search.fields.type` 现在不生效（不报错）。

### 校验器不是 JSON Schema 实现

手写的原因只有一个，但很实在：**错误消息要指向具体字段、用中文说人话**。

通用 schema 校验器会报：

```
instance.search.fields requires property "title"
```

本项目报：

```
search.fields.title: 必填字段缺失
```

后者能让不写代码的人直接定位。代价是校验器本身要维护，且不支持 `$ref`、`oneOf` 之类的组合能力——目前也不需要。

---

## 十六、完整示例

一个真实的、可直接导入的书源（`sources/bqg5555.json` 摘要）：

> 仓库里的 `sources/bqg5555.json` 是**唯一权威版本**，本文的副本只用于讲解。逐步拆解见 [`book-sources.md`](book-sources.md) 第八节。

```jsonc
{
  "schemaVersion": 1,
  "id": "bqg5555",
  "name": "笔趣阁 bqg5555",
  "version": "1.0.0",
  "homepage": "https://www.bqg5555.cc/",
  "type": "novel",
  "enabled": true,

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
    "fields": {
      "title": "css:",
      "url": "css:@href"
    },
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

这个源用到的主要特性：

| 特性 | 用在 |
|---|---|
| POST 搜索 + body 占位符 | `search.method` / `search.body` |
| 表头行自动跳过 | `fields.title` 取不到 → 跳过该条 |
| 兄弟选择器限定章节区 | `detail.list` 的 `~` |
| og meta 取书名 | `detail.title` |
| 空选择器取元素自身 | `detail.fields.title` 的 `css:` |
| 当前元素属性 | `detail.fields.url` 的 `css:@href` |
| 只取段落排除导航 | `chapter.content` 的 `css:#content p` |
| 章节分页跟随 | `chapter.nextUrl` |

---

## 附：相关文档

| 文档 | 内容 |
|---|---|
| [`book-sources.md`](book-sources.md) | 设计取舍、安全模型、界面 |
| [`project-overview.md`](project-overview.md) | 项目整体架构 |
| [`viewer-contract.md`](viewer-contract.md) | 查看器契约（对照书源的选择器分派） |

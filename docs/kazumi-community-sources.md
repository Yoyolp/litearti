# Kazumi 社区规则的实测记录

> 记录时间：2026-11-15
>
> 目的：P4/P5 需要一个**真实**的番剧源来验证 `xpath:` 选择器与流代理，
> 而不是拿公开测试流跑一个验不到防盗链的空壳。这里记录了社区规则的实际可用性。

---

## 一、规则从哪来

Kazumi 的规则是社区维护的，代码里的默认仓库地址在
`lib/request/config/api_endpoints.dart`：

```dart
static const String pluginShop =
    'https://raw.githubusercontent.com/Predidit/KazumiRules/main/';
```

拉取方式（`RulesRepositoryConfig`）：

| 用途 | 地址 |
|---|---|
| 目录 | `<repo>index.json` —— 一个 JSON 数组 |
| 单条规则 | `<repo><name>.json` |

目录里每条是 `{ name, version, useNativePlayer, antiCrawlerEnabled, author, lastUpdate }`。
litearti 若要「从社区导入」，就是照这个格式读 `index.json` 再按 name 取单条 —— 与现有的
`RulesRepositoryConfig.normalizeForStorage` 的校验思路一致（只允许 http/https、必须目录或
`index.json` 结尾）。

**当前目录共 18 条规则**（2026-11-15）：

```
7sefun  aafun  AGE  akianime  baimao  dalvdm  DM84  ezdmw  giriGiriLove
LMM  mgnacg  moonci  mutefun  MXdm  sorani  TvTFun  xfdmneo  xfdmnext
```

---

## 二、这些规则长什么样

三种形态，按 `api` 版本号区分难度：

### 2.1 最简形态（api 5，AGE / MXdm / DM84）

只有 XPath，没有请求头配置，播放靠 WebView 嗅探：

```json
{
  "api": "5",
  "name": "MXdm",
  "baseURL": "https://www.dcc3.com",
  "searchURL": "https://www.dcc3.com/search/?wd=@keyword",
  "searchList": "//div[contains(@class, 'search')]/ul/li",
  "searchName": "//h3/a",
  "searchResult": "//h3/a",
  "chapterRoads": "//div[@class='playlist']/div[@class='row']/ul",
  "chapterResult": "//li/a"
}
```

**关键观察**：`searchResult` 选中的是 `<a>` **元素本身**，不是属性。
Kazumi 内部取 `attributes['href']`；litearti 的 XPath 必须用 `::attr(href)` 显式取。

### 2.2 带 referer / 反爬（api 8–9，ezdmw / xfdmnext）

多了 `referer`、`searchMode`、`chapterMode`、`antiCrawlerConfig`。
`ezdmw` 的 `chapterResult` 用了 `following-sibling::` 轴 —— litearti 走浏览器原生 XPath，
这类轴是支持的，Kazumi 自己的实现未必全支持（README 里也承认只支持 `//` 开头）。

### 2.3 完全无法解析（dalvdm / TvTFun / LMM / giriGiriLove）

**没有 `searchURL`**，或规则结构完全不同（api 9 那批）。这几条不是「转换」能解决的，
需要 Kazumi 新的规则引擎语义，不在本期范围。

---

## 三、站点可达性实测

| 规则 | 站点 | 可达 | 说明 |
|---|---|---|---|
| AGE | www.agedm.io | ✅ 200 | 搜索、详情均正常 |
| MXdm | www.dcc3.com | ✅ 200 | **播放页能直取 m3u8 直链** |
| DM84 | dmbus.cc | ✅ 200 | 搜索、详情正常；播放走加密 iframe |
| akianime | www.akianime.cc | ✅ 200 | 搜索有结果，但详情页是 SPA 壳，剧集不在 HTML 里 |
| baimao | www.baimaodm.com | ✅ 200 | 搜索页可达 |
| ezdmw | m.ezdmw.org | ✅ 200 | 搜索页可达 |
| 7sefun | www.7sefun.top | ✅ 200 | 搜索页可达 |
| xfdmneo | dm1.xfdm.pro | ✅ 200 | 搜索页可达 |
| TvTFun | www.tvtfun.net | ✅ 200 | 但无 `searchURL`，规则不可用 |
| moonci | www.moonci.com | ❌ 403 | 需要验证或地区限制 |
| sorani | www.sorani.net | ❌ DNS 失败 | 域名不存在 |
| mgnacg | www.mgnacg.com | ❌ 超时 | 不可达 |

---

## 四、XPath 在真实页面上的验证结果

用浏览器原生 `document.evaluate` 对下载下来的真实 HTML 跑规则里的 XPath。

### 4.1 MXdm（dcc3）—— 唯一能直取 m3u8 的源

| 阶段 | XPath | 结果 |
|---|---|---|
| 搜索列表 | `//div[contains(@class,'search')]/ul/li` | 命中 |
| 搜索标题 | `//h3/a` | 5 条，`孤独摇滚(上) /detail/17065/` 等 |
| 详情剧集 | `//div[@class='playlist']/div[@class='row']/ul/li/a` | 48 个 `<a>` |
| 取流 | 播放页内联 JS | **`url: 'https://yzzy.play-cdn7.com/20221009/21929_100d2320/index.m3u8'`** |

验证到了什么：

```
master.m3u8   97 B   #EXTM3U / #EXT-X-STREAM-INF BANDWIDTH=800000 RESOLUTION=1080x608
  └ 1000k/hls/mixed.m3u8   19,853 B   VOD，EXTINF 4.17s，约 4000+ 分片
      └ f3f1ba...ts        188,000 B  video/mp2t
```

**防盗链结论：这个 CDN 完全不校验。**

| 请求头 | 结果 |
|---|---|
| 带 UA + Referer | 200，188000 B |
| 只带 UA，无 Referer | 200，188000 B |
| 完全不带任何头 | 200，188000 B |
| 伪造 `Referer: https://evil.example.com/` | 200，188000 B |

**这意味着它不能用来验证流代理的防盗链逻辑。** 它只能验证「代理能转发、m3u8 能重写、
分片能播」。真正的 Referer 校验要用别的源，或者自建一个校验 Referer 的测试服务器
（更可控，且能确定性复现 403）。

### 4.2 DM84（dmbus.cc）—— 解析通，播放不通

| 阶段 | XPath | 结果 |
|---|---|---|
| 搜索列表 | `//div/div[3]/ul/li` | 命中 1 条 |
| 搜索标题/链接 | `//div/a[2]` | `孤独摇滚！` → `/v/2961.html` |
| 详情剧集 | `//div/div[4]/div/ul` | 1 条线路，12 集 |
| 剧集链接 | `//li/a` | `/p/2961-1-1.html` … `/p/2961-1-12.html` |
| 取流 | 播放页 | **无 m3u8**，只有一个加密第三方 iframe |

播放页的 iframe：

```
https://hhjx.hhplayer.com/?url=CBB95FDF27DE451FC0A1164B95EC610C136C7919BA0214...
```

这是「解析站」模式：地址经过加密，必须由第三方播放器解密。litearti 没有 WebView 嗅探，
**这条规则只能解析到剧集，不能播放**。它是验证「错误说得清不清楚」的好样本 —— 用户会看到
「这个源需要浏览器嗅探，当前不支持」而不是白屏。

### 4.3 AGE（agedm.io）—— 多线路样本

| 阶段 | XPath | 结果 |
|---|---|---|
| 搜索 | `//div[2]/div/section/div/div/div/div` | 命中 |
| 搜索标题 | `//div/div[2]/h5/a` | `孤独摇滚！` → `http://www.agedm.io/detail/20220121` |
| 详情剧集 | `//ul/li/a` | 24 集（2 条线路 × 12） |
| 取流 | 播放页 | 无 m3u8，走 `jx.wuzhoupai.com` 第三方解析 |

这条的价值是**多线路**：`chapterRoads` 命中多个 div，每个是一路播放源。

---

## 五、对 litearti 的影响

### 5.1 结论：`xpath:` 前缀必须支持，而且属性要用 `::attr()`

这是把社区规则利用率从 0 提到「大部分」的唯一前提。
`searchResult` 这类字段在 Kazumi 里指向元素、隐式取 `href`，litearti 必须显式，
否则会把整个 `<a>` 的 textContent 当成 URL。

已在 `sources/kazumi-community.json` 里按这个约定写了三条转换后的源：

| id | 用途 | 播放 |
|---|---|---|
| `kazumi-mxdm` | 主测试源 | ✅ 直取 m3u8 |
| `kazumi-dm84` | 错误处理样本 | ❌ 需嗅探 |
| `kazumi-age` | 多线路样本 | ❌ 需嗅探 |

### 5.2 流代理的测试策略要改

原计划「用社区源验证防盗链」**不成立** —— 唯一能直取 m3u8 的源不校验 Referer。

改为：

1. **m3u8 重写与分片转发**：用 `kazumi-mxdm` 的真实 master/media playlist 验证
   （相对地址解析、`EXT-X-KEY`、分片路径拼接都能覆盖）。
2. **Referer 校验**：**自建一个 fixture 服务器**，对不带正确 Referer 的请求返回 403。
   这比依赖真实站更可控、能确定性复现，也不会因为站点改策略而失效。
3. **Range / 206**：fixture 服务器上实现 Range，验证 mp4 拖进度。

这三条都在 `verify-m3u8-rewrite.mjs` 与 Rust 单测里做，不需要联网。

### 5.3 「WebView 嗅探」的缺口是真实的

18 条社区规则里，`useWebview` **全部为 true**。这意味着：

- 能纯 HTTP 解析出剧集的：MXdm、DM84、AGE 等少数几条；
- 能纯 HTTP 拿到**可播放直链**的：**只有 MXdm 一条**（且它不校验防盗链）；
- 其余的播放链路都依赖第三方解析站或 WebView 嗅探。

所以 §4.4 的「本期不做 WebView 嗅探」**意味着大量源只能看到剧集、点播放会失败**。
这个限制必须在 UI 上说清楚，而不是等用户点了播放才报一个含糊的错。

### 5.4 社区规则导入器（P4 的可选扩展）

有了 `index.json` + 单条 JSON 的格式，写一个「从社区导入」只要：

1. `GET <repo>index.json`，列出可选规则（带版本、是否反爬）；
2. 选中后 `GET <repo><name>.json`；
3. 跑 `convert-kazumi-plugin.mjs` 的转换；
4. 用 `validateSource` 校验，失败则逐条报告。

`antiCrawlerEnabled: true` 的规则（目前只有 `mutefun`）应当导入时给出明确警告：
litearti 不支持验证码流程，这条规则大概率不可用。

---

## 六、复现方式

```powershell
# 目录
Invoke-WebRequest "https://raw.githubusercontent.com/Predidit/KazumiRules/main/index.json"

# 单条
Invoke-WebRequest "https://raw.githubusercontent.com/Predidit/KazumiRules/main/MXdm.json"
```

站点结构变化会导致上面的 XPath 失效 —— 这是抓取类项目的常态，不是本项目的 bug。
`docs/kazumi-rule-conversion.md` 里会写清楚「规则失效如何自查」。

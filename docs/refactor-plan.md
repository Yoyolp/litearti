# litearti 重构方案（第二版）

> 状态：**方案待确认，尚未写代码**
>
> 本文件**取代** [`anime-section.md`](anime-section.md)。上一版把番剧当成并联的新板块，
> 方向错了：真正要动的是**书源模块与资料库模块本身**，番剧只是它们能力扩展后的一个结果。

---

## 一、这次要改的三件事

| # | 改什么 | 为什么 |
|---|---|---|
| 1 | **资料库从「列表」升级为「有查询模型的资源库」** | 只有列表、不能切卡片、不能排序筛选分组、不能改名、不能批量 —— 这些是日常使用的硬摩擦 |
| 2 | **书源从「JSON 文件列表」升级为「源管理 + 源编辑器 + 聚合检索」** | 现在改个规则必须去外部编辑器；想找一本书要在几个源之间手动重搜 |
| 3 | **在 2 之上接入视频源与播放** | 番剧不是新板块，是「源」多了一种 type、「资料库」多了一种可打开的东西 |

一句话：**先把两个已有模块的骨架补上，番剧才有地方长。**

---

## 二、现状诊断（带位置）

### 2.1 资料库

| 问题 | 位置 | 后果 |
|---|---|---|
| 只有一种视图 | `LibraryView.vue:290` `.entries` 单列 `<ul>` | 无法按封面/视觉扫读，找东西靠读标题 |
| 排序写死 | `stores/library.ts:40` `sorted` | 「按名称找」「按大小清」都做不到 |
| 无筛选/分组 | 无 | 100 个文件里找 3 个 PDF，只能搜标题 |
| 进度解析在视图里 | `LibraryView.vue:112` `progressLabel()` | 新增查看器就要改这个视图；违反 `Entry.progress` 的「后端不解析、查看器自治」约定 |
| 无重命名 | `lib.rs:284` 命令清单无 rename | `model.rs:13` 注释承诺「editable later」，实际做不到 |
| 无批量删除 | `LibraryView.vue:104` 单条确认 | 清理十个文件点十次 |
| 全量渲染 | `LibraryView.vue:291` `v-for` | 上千条时首屏明显变慢 |
| 无元信息 | `model.rs:11` Entry | 卡片视图需要「作者/标签/系列」才有意义，现在一个都没有 |

### 2.2 书源

| 问题 | 位置 | 后果 |
|---|---|---|
| 不能编辑 | `SourcesView.vue:73` 只有 import | 改一个选择器要重写整份 JSON 再导入 |
| 模板硬编码 | `SourcesView.vue:38` `TEMPLATE` | 只能复制到外部编辑器 |
| 列表无组织 | `SourcesView.vue:192` `v-for` 平铺 | 20 个源就是 20 行，不能按类型分组、不能搜 |
| 无批量启用/删除 | `SourcesView.vue:206` 单条 toggle | 同上 |
| 单源检索 | `SourceBrowseView.vue:87` `search()` 只打当前源 | 找一本书要开 5 个源试 5 次 |
| 换源回到列表 | `App.vue:209` `browseSource` | 每次换源丢失关键词 |
| 无调试 | 无 | 规则错在哪只能猜 |
| 无更新检查 | 无 | 源失效了才发现 |
| video 类型是空壳 | `schema.ts:29` 有枚举，无实现 | 「视频」标签能选但什么也做不了 |

### 2.3 播放

上一版的结论保留（WebView `<video>` + hls.js + Rust 流代理），但**降级为最后两个阶段**：
它依赖源与规则层，先做没有意义。

---

## 三、模块新划分

```
┌─ 外壳 ──────────────────────────────────────────────────────┐
│  侧栏：看板 · 资料库 · 源 · 设置                              │
└─────────────────────────────────────────────────────────────┘
        │                    │                      │
        ▼                    ▼                      ▼
┌───────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ 资料库         │   │ 源                │   │ 播放              │
│               │   │                  │   │                  │
│ 本地条目       │   │ 源管理（CRUD）     │   │ <video>+hls.js   │
│ 列表/卡片双视图 │   │ 源编辑器（表单）    │   │ kazumi-stream:// │
│ 排序/筛选/分组  │   │ 聚合检索           │   │ Rust 流代理       │
│ 批量操作       │   │ 单源浏览/详情      │   │ 进度记忆          │
│ 重命名         │   │ 规则试跑           │   │                  │
└───────────────┘   └──────────────────┘   └──────────────────┘
     │                      │                       │
     └──────── 共用：查询模型、进度注册表、i18n、设计系统 ────────┘
```

**关键变化**：把「书源」这一概念泛化为**源（Source）**。小说、漫画、听书、视频都是源，
差别只在 `type` 与用哪套字段。侧栏文案从「书源」改为「源」。

---

## 四、资料库重构

### 4.1 数据模型

`Entry` 增加两个**可选**字段（都是元信息，不参与打开逻辑）：

```rust
/// 用户手动改的显示名。为空时用 `title`。
/// 单独存一个字段而不是覆盖 `title`，是为了保留「原文件名」这条线索，
/// 也为了重命名可以撤销（清空即回退）。
pub rename: Option<String>,

/// 归属分组。本地文件默认 None；从源下载导入的条目填源名，
/// 这样「资料库」和「源」之间看得见联系。
pub group: Option<String>,
```

> 不加 `author` / `tags` / `cover`。本地文件没有这些数据，加了只能是空字段或假数据。
> 这符合 `design-system.md` 第十一节的「不用假数据」原则。

### 4.2 查询模型（核心新增）

新建 `src/library/query.ts`，纯函数、无副作用、可单测：

```ts
export type SortKey = 'recent' | 'title' | 'size' | 'added' | 'progress'
export type FormatGroup = 'text' | 'pdf' | 'epub' | 'audio' | 'other'
export type ReadStatus = 'unread' | 'reading' | 'finished'

export interface LibraryQuery {
  text: string                  // 分词后 every(contains)，与 Kazumi 的 _match 同策略
  format: FormatGroup | null
  status: ReadStatus | null
  group: string | null
  sort: SortKey
  direction: 'asc' | 'desc'
}

export function applyQuery(entries: Entry[], q: LibraryQuery): Entry[]
export function countsByFormat(entries: Entry[]): Record<FormatGroup, number>
export function countsByStatus(entries: Entry[]): Record<ReadStatus, number>
```

为什么独立成模块：Kazumi 把这段逻辑放在 `collect_library_query.dart`，是一个纯类，
所以「筛选 + 计数 + 排序」能被测试直接驱动。litearti 现在这段是散在 store 与视图里的，
重构的第一步就是把它抽出来。

### 4.3 进度注册表（修掉架构错误）

新建 `src/library/progress.ts`：

```ts
export interface ProgressInfo {
  /** 0–1，用于进度条。未知时为 null。 */
  ratio: number | null
  /** 人类可读："已读 42%" / "第 12 页" / "第 3 章" / "听到 3:24"。 */
  label: string | null
}

/** 由查看器注册自己 progress 形状的解释方式，与 viewers/registry 同构。 */
export function registerProgressReader(id: string, read: (progress: unknown) => ProgressInfo | null): void
export function readProgress(entry: Entry): ProgressInfo
```

内置三种解释（文本 ratio / PDF page+total / 音频 time / EPUB chapter），
**放在各自查看器目录下**，由 `viewers/builtins.ts` 一并注册。
`LibraryView` 从此只调 `readProgress(entry)`，加新格式不用碰视图。

### 4.4 双视图

| | 列表（默认） | 卡片 |
|---|---|---|
| 适用 | 大量文本条目，扫读标题最快 | 视觉识别（PDF 封面感、有声书） |
| 一屏信息 | 标题 + 大小 + 时间 + 进度 | 生成式封面 + 标题 + 进度条 |
| 选择 | 左侧复选框 | 封面右上角勾选角标 |

**封面怎么办**：本地文件没有封面，**不造假图**。卡片封面是「排版式书脊」：

```
┌──────────┐
│          │
│   PDF    │   ← 扩展名，--text-xs，--ink-tertiary
│          │
│  线性代数  │   ← 标题前两行，--text-sm，--ink-primary
│  及其应用  │
│          │
│ ▓▓▓▓░░░░ │   ← 2px 进度条，--ink-secondary / --line-subtle
└──────────┘
```

背景用 `--surface-sunken`，靠 `--line-subtle` 一档分出边界，**不加阴影、不加圆角以外的装饰**。
这一点必须写进文档，否则下一个贡献者一定会去接豆瓣封面 API。

### 4.5 视图与状态持久化

存 `localStorage`（与 `litearti.sidebar-collapsed` 同一套约定）：

```
litearti.library.view      'list' | 'grid'
litearti.library.query     { sort, direction, format, status }
```

**不进 `library.json`** —— 和主题一样，这是界面偏好，不是资料内容。

### 4.6 批量与重命名

新增 Rust 命令（保持一个命令一件事，不做「万能 batch」）：

```rust
library_rename(id, title: Option<String>) -> Entry   // None 清空，回退原名
library_remove_many(ids: Vec<String>) -> { removed: usize, failed: Vec<(String, String)> }
```

批量删除的 UI：选择模式复用现有 `stores/export.ts` 的机制（已经有一套 selecting / count /
selectAll），**扩展成通用选择模式**，导出与删除共用。

> 这是个重构点：现在 `useExportStore` 拥有「选择」这件事，但它其实是资料库的通用能力。
> 建议把选择状态上移到 `stores/library.ts`，`export.ts` 只消费它。

---

## 五、源模块重构

### 5.1 概念与命名

| 现在 | 之后 |
|---|---|
| 书源 / BookSource | **源 / Source**（`type` 区分小说/漫画/听书/视频） |
| 书源页 = 平铺列表 | 源页 = 分组 + 搜索 + 批量 + 新建/编辑 |
| 「浏览」= 单源搜索 | 「浏览」= 单源搜索；新增**聚合检索**作为源页主入口 |

`schemaVersion` **保持 1**：新增字段全部可选，旧文件不迁移、不破坏。
`id` 沿用 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`。

### 5.2 源管理页（重做 `SourcesView.vue`）

```
┌ 源                                    12 个 · 9 个启用 ┐
│ [搜索源…]        [新建] [导入] [批量]                  │
│                                                      │
│ 视频  ▾  4 个                                         │
│   樱花动漫        v2.1.0   已启用  →                   │
│   ...                                                │
│ 小说  ▾  6 个                                         │
│   ...                                                │
└──────────────────────────────────────────────────────┘
```

新增能力：

1. **按 `type` 分组**，组头可折叠（折叠状态存 localStorage）
2. **搜索**：按名称 / id / homepage 匹配
3. **批量模式**：启用、禁用、删除、导出选中
4. **新建**：进入源编辑器（不再是复制模板）
5. **每条的操作**：编辑、启用、删除（删除有确认，与资料库一致）、「试跑」（见 5.4）

### 5.3 源编辑器（新增，最大的工作量）

现在是「手写 JSON 或别用」。Kazumi 有 1114 行的 `plugin_editor_page.dart`，把规则拆成表单。
litearti 不必那么大，但要覆盖：

```
分节（左侧锚点导航，右侧表单）
  1. 基本信息     id / 名称 / 版本 / 主页 / 类型 / 启用
  2. 请求         headers（键值对表格）/ timeoutMs / delayMs
  3. 搜索         url 模板 / method / body / list / 字段映射
  4. 详情         list / 字段映射 / tocUrl
  5a. 章节（文本） content / nextUrl
  5b. 剧集（视频） roads / episodes / 取流方式
  6. 高级         登录（auth）/ 反爬（暂不实现，明确灰掉理由）
```

三条设计约束：

- **表单与 JSON 双向**：顶部有「表单 / 原文」切换。原文模式是带行号的 `<textarea>`，
  提交时跑同一套校验器；表单模式只是结构化编辑同一份对象。**没有第二份真相**。
- **每个选择器字段旁有「试一下」**：拿当前 URL 请求一次，把选择器命中的前 3 条结果
  就地显示。这是 Kazumi `plugin_test_page` 的核心价值，也是规则作者最缺的东西。
- **校验器即提示**：失焦时跑字段级校验（不整份校验），错误显示在字段下方，
  用 `--tone-danger`；提交时才跑整份。

### 5.4 聚合检索（新增）

源页顶部一个搜索框，输入关键词后**并发打所有已启用的同类型源**：

```
结果（按源分组，可切「合并视图」）
  樱花动漫                      4 条   ✓
    [卡片] [卡片] [卡片] [卡片]
  AGE 动漫                      0 条   ✓
  某源                          —      ✗ 超时（12s）
```

实现要点：

- 并发上限 4（与 `net.rs` 的礼貌原则一致），每源独立超时，**一个源失败不影响其他源**
- 结果按 `detailUrl` 去重（跨源同作品不同地址，**不做自动合并** —— 合并需要标题相似度，
  容易错，宁可让用户看到两个条目）
- 失败的源以一行说明呈现（超时 / 403 / 选择器错误），可点开看原始错误
- 「合并视图」：所有源的结果混排，每条标注来源源名，方便比较哪个源的内容全

### 5.5 浏览页改造

- 换源从「回列表再进」改成**顶部下拉就地切换**，保留关键词，切完自动重搜
- 加「在本源内筛选」：按标题过滤已加载结果（纯前端，不发请求）
- 卡片显示类型标签、来源、简介摘要

### 5.6 规则试跑页

一个独立的小页（可从编辑器与源页进入）：

```
输入：源 + URL 或 关键词 + 阶段（搜索/详情/章节/剧集）
输出：请求 URL（脱敏后）、HTTP 状态、耗时、命中条数、每条前 80 字符、
      失败节点的诊断信息（"第 3 条缺少名称，已跳过"）
```

诊断信息这一点是**从 Kazumi 的 `diagnostics` 学来的**：
`sources/engine.ts` 现在是「跳过就跳过」，静默丢数据；改成收集诊断并返回。

---

## 六、视频源（番剧）接入

在源模块完成之后，视频只是「第四种 type 有了一套更复杂的字段」。

### 6.1 新增 `xpath:` 选择器前缀

`SELECTOR_PREFIXES` 加 `'xpath:'`。浏览器原生 `document.evaluate`，零依赖。

**属性取值不能用 `@attr` 后缀** —— XPath 谓词里本来就有 `@`（`//div[@class="x"]`），
`lastIndexOf('@')` 会切错。改用函数式：

| 写法 | 含义 |
|---|---|
| `xpath://div[@class="item"]` | 节点文本 |
| `xpath://a[@class="title"]/::attr(href)` | 节点属性 |
| `xpath:` | body 文本（与 `css:` 空选择器对齐） |

这条差异**必须写进规则文档**，否则写规则的人百分之百会踩。

### 6.2 `video` 配置块

```ts
export interface VideoConfig {
  /** 线路（播放源）列表。省略 = 单线路。 */
  roads?: string
  /** 线路名，在 roads 元素内取；省略则「线路 1」「线路 2」。 */
  roadsName?: string
  /** 剧集列表。有 roads 时在每条线路元素内取。 */
  episodes: string
  episodeTitle?: string
  episodeUrl: string
  /** 取流方式，四选一，覆盖绝大多数站点。 */
  playback: PlaybackConfig
}

export type PlaybackConfig =
  | { kind: 'direct'; url: string }                                     // 剧集页里直接有 m3u8/mp4
  | { kind: 'page'; pageUrl: string; url: string }                      // 先进播放页再取
  | { kind: 'regex'; pattern: string; group?: number }                  // 从源码正则捞
  | { kind: 'api'; url: string; method: 'GET' | 'POST'; body?: string; urlPath: string }  // JSON 接口
```

校验：`type: video` 必须有 `video`；`type != video` 不许有 `video`（报「`video` 只用于视频源」）。

### 6.3 引擎扩展

`SourceEngine` 加两个方法（不新建 engine，避免两套 sandbox 生命周期）：

```ts
async videoDetail(detailUrl: string): Promise<VideoDetail>   // 元信息 + 线路 + 剧集
async episodeVideoUrl(episodeUrl: string): Promise<string>   // 剧集页 → 视频地址
```

`detail()` 不动，文本源行为与现有测试完全不受影响。

### 6.4 UI

**详情页**（视觉上向 Kazumi 靠拢，但皮肤仍是 litearti）：

```
┌ 返回                                                     ┐
│ ┌──────┐  标题（--text-xl，600）                          │
│ │ 封面  │  原名 / 年份 / 状态（--ink-tertiary，--text-xs） │
│ │ 2:3  │  简介（最多 3 行，可展开）                        │
│ └──────┘  [开始观看] [访问网站]                           │
│                                                          │
│ 线路  ○ 线路1   ○ 线路2   ○ 线路3                          │
│ ─────────────────────────────────────────────            │
│ 01  02  03  04  05  06  07  08  …                        │
│ ↑选中=反白  已看=--ink-tertiary  未看=--ink-primary        │
└──────────────────────────────────────────────────────────┘
```

**借 Kazumi 的**：线路/剧集的网格排布、封面上压暗保证文字可读、已看的弱化表达。
**不借的**：彩色 pill 标签、彩色评分、品牌色、卡片浮起阴影 —— 与设计系统冲突。

---

## 七、播放与流代理

（与上一版一致，这里只留要点；细节见 §7.3 的差异）

### 7.1 形态

`<video>` + hls.js。原生 HLS（Safari/部分 Android WebView）直接 `src`；
其余 `Hls.isSupported()` → `attachMedia()`；mp4 不碰 hls.js。

### 7.2 自定义 scheme

```
kazumi-stream://localhost/stream?u=<b64url>&r=<b64url>&ua=<b64url>
```

**为什么不用 IPC**：HLS 一个视频几百个分片，`invoke` 的序列化往返是主要开销，
而且 `<video src>` 根本走不了 `invoke`。

**为什么 header 编码在 URL 里**：播放是纯函数式的，一个 URL 自带全部上下文，
不会「切了剧集但后端还留着上一集 header」。代价是 URL 变长，可接受。

### 7.3 必须做对的四件事

1. **逐跳校验**：只允许 http/https，重定向每一跳重校验（抽 `net.rs` 的 `ensure_web_url` 复用）
2. **m3u8 重写**：分片、master 子 playlist、`EXT-X-KEY:URI`、`EXT-X-MAP:URI`、`EXT-X-MEDIA:URI`
   全改写成回流代理；**相对地址先按 playlist 自身 URL 解析成绝对地址再重写**（最容易出 bug 的地方）
3. **Range 透传**：mp4 拖进度靠 206，转发 `Range`、回传 `Content-Range`
4. **上限**：playlist 2 MB / 分片 64 MB / 并发 4 / 单请求 30 s

### 7.4 边界透明化

README 现在写着「网络只走 Rust、仅 GET/POST、仅 http(s)、10 MB 上限、不维持 cookie」。
新增通道后要**主动改写这句话**，说清楚：体积上限在这条通道上放到分片 64 MB，
其余约束一条没松，仍然不接 cookie（所以登录态专属的播放地址本期不支持）。

---

## 八、设计系统扩展

`design-system.md` 现在明确写着 **「❌ 卡片网格布局」**。加卡片视图**是对已有约定的修改**，
不能悄悄做。建议的改法是把那条反模式改写成有条件的规则：

> **原**：❌ 卡片网格布局 —— 列表更省空间，也更容易扫读
>
> **改**：列表是默认。**当条目的主要识别特征是视觉对象（封面）时，允许卡片网格**；
> 纯文本条目仍用列表。判定标准是「有没有一张图能让你一眼认出它」，不是「好不好看」。
> 本地文件的卡片封面是排版生成的，不接任何外部封面源。

新增 token（尽量少，先加 6 个）：

```css
/* 卡片网格。列宽是"最小可读宽度"，不是固定列数——窗口变化时列数自然增减。 */
--card-min-width: 148px;
--card-cover-aspect: 2 / 3;
--grid-gap: var(--space-4);
--grid-gap-roomy: var(--space-5);

/* 工具条：筛选/排序/视图切换共处一行，高度固定避免切换时跳动 */
--toolbar-height: var(--control-lg);

/* 分节线：比 --line-subtle 更有存在感，用于源分组之间，不用 border */
--line-section: #e2e2e2;   /* dark: #303030 */
```

---

## 九、数据模型与迁移

| 文件 | 变化 | 兼容性 |
|---|---|---|
| `library.json` | `Entry` 加 `rename` / `group`（均可选） | `#[serde(default)]`，旧文件直接可读 |
| `sources.json` | `BookSource` 加可选 `video` 块；`selector` 支持 `xpath:` | schemaVersion 仍为 1，旧源全部有效 |
| `source-progress.json` | 不变 | — |
| `anime-progress.json` | **新增**，存 `(sourceId, episodeUrl) → {time, duration}` | 与书本进度分开，避免污染 |
| `litearti.library.view` / `.query` / `.sources.collapsed` | localStorage | 界面偏好，不进数据文件 |

**迁移脚本**：`library.json` 加字段是纯增量，无需迁移代码。
`sources.json` 同理。这一点要在文档里写明，避免有人写多余的 migration。

---

## 十、分阶段计划

原则：**每个阶段结束都能跑、能验、能回退**。不跨阶段合并大改动。

### P0 · 播放技术验证（1 天，可砍）

只验一件事：hls.js 能否通过 `kazumi-stream://` 播放**带 Referer 校验**的真实 m3u8。

- Rust 最小 scheme handler：不做 m3u8 重写，只代理一个固定 m3u8 与它的分片
- 临时页面 `<video>` + hls.js
- **判定**：能播 → 继续；不能播 → 停下来重新选底座（外部播放器 / libmpv），
  不要在错误地基上盖三层楼

> 这一阶段可以放到最后做，但它决定 §7 是否成立，所以先花一天排除风险更划算。
> 需要你提供一个可用测试源（见 §12 问题 2）。

### P1 · 查询与进度基础设施（1–2 天）

- `src/library/query.ts` + 单测（`scripts/verify-library-query.mjs`）
- `src/library/progress.ts` + 各查看器注册自己的解释
- `LibraryView` 改用 `readProgress()`
- 此时**界面上还没有新东西**，但重复逻辑消失

### P2 · 资料库重构（3–4 天）

- 列表/卡片双视图 + 持久化
- 排序 / 格式筛选 / 状态筛选 / 分组
- 选择模式上移到 `stores/library.ts`，导出改为消费它
- `library_rename` / `library_remove_many`（Rust + IPC + UI）
- 大列表按可视区渲染（`content-visibility: auto` 起步，不够再上窗口化）
- 空状态、搜索无结果的文案补齐

### P3 · 源模块重构（4–5 天）

- 源管理页：分组、搜索、批量、新建入口
- **源编辑器**：表单 + 原文双模式、字段级校验、选择器「试一下」
- 聚合检索：并发、超时、失败源呈现、合并视图
- 浏览页：就地换源、结果内筛选
- 规则试跑页 + 引擎诊断信息

> 这是工作量最大的一段，也是**收益最大**的一段。建议 P3 再拆两次提交评审：
> P3a = 管理与聚合检索；P3b = 编辑器与试跑。

### P4 · 视频源规则层（3 天）

- `xpath:` 前缀 + 求值 + `::attr()` + 校验
- `video` 块类型与校验
- `videoDetail()` / `episodeVideoUrl()` + 引擎诊断
- `scripts/verify-video-schema.mjs`、`verify-xpath-selector.mjs`

### P5 · 流代理与播放器（4 天）

- `stream.rs`：m3u8 重写、Range、上限、错误
- `proto.rs`：scheme 注册、CORS
- `AnimePlayerView`：控制条、线路显示、进度记忆、键盘、Esc 互斥
- Rust 单测 + `scripts/verify-m3u8-rewrite.mjs`

### P6 · 收尾（2 天）

- `scripts/convert-kazumi-plugin.mjs` + `docs/kazumi-rule-conversion.md`
- 文档同步：`README.md`（依赖数、网络边界）、`design-system.md`（卡片规则）、
  `project-overview.md`、`viewer-contract.md`（进度注册）
- 全量回归：`pnpm build`（含 `vue-tsc`）、`cargo test`、全部离线 verify 脚本
- 手工验收清单（§11）

**合计约 18–20 个工作日。** 如果时间紧，P0/P1/P2 是「立刻能感知的改善」，
P3 是「长期杠杆」，P4/P5 才是「番剧」。这个顺序可以按你的优先级调整。

---

## 十一、验收清单

**资料库**
- [ ] 列表 / 卡片可切换，重开应用保持上次选择
- [ ] 能按名称、大小、导入时间、进度排序，方向可切
- [ ] 能按格式与阅读状态筛选，计数正确
- [ ] 重命名生效，重开应用后保持；清空重命名回到原文件名
- [ ] 多选删除有确认，显示成功数与失败数
- [ ] 1000 条时滚动流畅（首屏 ≤ 200ms）
- [ ] 新增一种查看器后，进度显示不需要改 `LibraryView.vue`

**源**
- [ ] 按类型分组、组头折叠、搜索源名
- [ ] 新建源走表单，能保存、能再编辑、能删除
- [ ] 表单与原文模式切换不丢数据，校验错误定位到字段
- [ ] 选择器「试一下」能显示命中结果
- [ ] 聚合检索并发打多源，一个源超时不影响其他源
- [ ] 聚合结果点进去能到详情，来自哪个源一目了然
- [ ] 浏览页换源保留关键词并自动重搜

**视频 / 播放**
- [ ] 视频源能搜到、能进详情、能看到线路与剧集
- [ ] 切换线路剧集列表正确变化
- [ ] 能起播，mp4 与 m3u8 各验一次；能拖进度
- [ ] 进度记忆准确，退出重进能续播
- [ ] 播完自动下一集，最后一集停在播完态
- [ ] `Esc` 从播放页回详情，不直接跳回列表

**整体**
- [ ] `pnpm build` 零 TS 错误；`cargo test` 全绿
- [ ] 所有新增文案走 i18n
- [ ] 断网时看板 / 资料库 / 本地阅读完全不受影响
- [ ] 文档已同步，包括被放宽的网络约束与被修改的设计反模式

---

## 十二、需要你先拍板

1. **「书源」改名为「源」吗？** 支持视频后再叫「书源」就名不副实了。改名会牵动
   UI 文案、i18n key、部分文档；不改则文案别扭。我倾向改，且用一次提交集中做完。

2. **P0 的测试源。** 需要你给一个真实、稳定、要求 Referer 的番剧源（网址或 Kazumi 规则）。
   没有的话 P0 只能拿公开测试流跑，防盗链这一环验不到，结论要打折。

3. **卡片的封面从哪来？** 我的方案是「排版生成的书脊，不接外部封面源」。
   如果你希望本地 PDF/EPUB 显示真实封面（PDF 首页、EPUB cover），技术上可行但需要
   渲染管线（后台把首页渲染成缩略图并缓存），是**额外一个阶段**的量。

4. **分组（`Entry.group`）要不要做？** 它可以让你把「从某源下载的书」归成一组。
   不做也能跑，做了资料库才真正接得上源的语义。建议做，但可以延到 P3 之后。

5. **反爬/验证码要不要碰？** Kazumi 的 `antiCrawlerConfig` + WebView 验证流程是它能
   覆盖一批站点的关键。litearti 的 `net.rs` 不维持 cookie，要做就得引入 WebView 会话，
   与现有安全边界冲突。我的建议是**本期明确不做**，并在转换器里对依赖它的源给出警告。
   如果你认为这块必须有，我们再单独讨论边界。

6. **优先级确认。** §10 的顺序是「基础设施 → 资料库 → 源 → 视频 → 播放」。
   如果你的实际痛点是「资料库不能切卡片」，那 P2 可以提到 P1 前面（两者无依赖）。

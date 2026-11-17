# 目录结构：每个文件夹干什么

> 判断一个文件该放哪，看它**需要知道什么**，而不是它叫什么名字。
> 一个文件如果同时需要知道"库条目长什么样"和"HTTP 怎么发"，它放错了地方。

---

## 顶层

```
litearti/
├── src/                 Vue 前端
├── src-tauri/           Rust 后端 + Tauri 配置
├── scripts/             验证脚本与生成工具
├── docs/                文档
├── sources/             源文件样本
├── importable-sources/  可导入的示例源
├── public/              静态资源
├── demo/                测试样例文件
├── index.html           前端入口
├── vite.config.ts       构建配置
├── tsconfig.json        TS 配置（含 @/ 路径别名）
└── package.json         前端依赖与脚本
```

### `src/` — Vue 前端

13 个子目录，按**职责**划分，不按文件类型。

### `src-tauri/` — Rust 后端

```
src-tauri/
├── src/                 18 个 Rust 模块
├── Cargo.toml           依赖（7 个直接依赖）
├── tauri.conf.json      窗口、权限、asset 协议 scope
└── build.rs             Tauri 构建脚本
```

### `scripts/` — 验证与工具（**不打包进应用**）

```
scripts/
├── verify-*.mjs     34 个：断言行为，失败则 exit 1
├── shots-*.mjs       4 个：只生成截图，供人目视
├── fixtures/         真实抓取的页面与 JSON（测试数据）
├── stubs/            测试时替掉 @tauri-apps 的假模块
└── *.mjs             生成工具（样例 EPUB/PDF、图标、legado 转换）
```

**`verify-` 和 `shots-` 的分工是刻意的**：断言能证明"功能对"，证明不了"看着对"。一个卡片可以逻辑全对但布局塌成 0 高度，只有眼睛能发现。

**`fixtures/` 必须是真的**。手写的 fixture 只能证明"解析器能解析作者想象中的结构"，而真实 API 经常不按想象来（`bgm-calendar.json` 和 `bgm-popular.json` 的两个端点字段就不一致）。

### `docs/` — 文档

按主题分文件，一个主题一个文件。`project-map/` 是这一套。

### `sources/` — 源文件样本

**注意：这不是运行时数据目录。** 运行时源存在 `app_data_dir()/sources/sources.json`（由 Rust 的 `sources_root()` 决定）。这里的文件只是样本和测试素材。

### `importable-sources/` — 可直接导入的源

给用户拿的。有 README 说明怎么用，`scripts/verify-importable-sources.mjs` 用**应用自己的校验器**保证它们真的能导入。

### `public/` — 静态资源

主要是 pdfjs 的 worker、cmaps、字体。构建时原样拷贝到 `dist/`。`scripts/copy-pdfjs-assets.mjs` 负责从 node_modules 同步。

### `demo/` — 样例文件

`sample.epub` / `sample.pdf`，给测试和手工验证用。

---

## `src/` 逐目录

### `src/api/` — Tauri 适配层（**边界**）

```
api/library.ts
```

**唯一的职责：把 Tauri 的 `invoke` 包成有类型的函数。**

这里的每个函数都对应一个 Rust `#[tauri::command]`。视图和 store 调这里，不直接调 `invoke`。

为什么重要：桌面 → 移动端迁移时，文件选择、字节读取、进度存储的底层原语全都不一样。**只有这一层需要长第二份实现**，其余代码不用动。

`api/library.ts` 里有 `pickFiles`、`readText`、`entryUrl`、`sourceFetch` 等约 34 个函数。

---

### `src/components/` — 可复用组件

```
AppSidebar.vue       侧栏（4 项 + 折叠）
LibraryCard.vue      资料库卡片（排版书脊）
SourceCard.vue       源浏览结果卡片
SubjectCard.vue      发现页番宇卡片（含封面缓存）
EmptyLibrary.vue     空状态
ExportMenu.vue       导出入口
ExportFeedback.vue   导出结果提示
ImportFeedback.vue   导入结果提示
SourceFormFeedback.vue 源表单校验提示
```

**判定标准**：被两个以上视图用，或者自身有独立状态（如封面加载失败回落）才放这里。只用一次的留在视图里。

---

### `src/discover/` — 发现的业务逻辑

```
subject.ts   Bangumi subject 的宽容解析（两套端点形状）
collect.ts   本地收藏状态（想看/在看/看过/搁置）
match.ts     标题相似度匹配（Dice + 续作标记剥离）
api.ts       发现功能的 Tauri 适配（含封面缓存）
```

**为什么不放 `sources/`**：`sources/` 是"从源里取内容"，`discover/` 是"决定要看什么"。两者都会联网，但数据源和生命周期不同。

---

### `src/export/` — 导出

```
registry.ts      目标格式注册表
builtins.ts      内置目标（原样复制等）
pipeline.ts      导出流水线
naming.ts        文件名规则
pickDirectory.ts 目录选择（Tauri 适配）
```

**注册表模式**：加一种导出格式 = 注册一个 descriptor，不改流水线。

---

### `src/library/` — 资料库的纯逻辑

```
query.ts         查询模型（筛选/排序，无框架依赖）
progress.ts      进度读取器注册表（按扩展名）
builtinProgress.ts 内置进度读取器
viewPrefs.ts     视图偏好持久化（localStorage，逐字段校验）
readingPrefs.ts  阅读偏好（字号/行距/页宽/翻页方式，两端共用）
rematch.ts       标题标准化 + 完全相等匹配
```

**这个目录是纯函数为主**，不 import Vue 组件、不碰 Tauri。所以它能被 Node 直接测试（`verify-library-query.mjs`）。

**`query.ts` 的关键约束**：它不做 reactivity，只接收 `LibraryQuery` 返回值。视图持有状态，纯函数负责计算。这样测试不需要模拟 Vue。

---

### `src/sources/` — 源引擎

```
schema.ts        源文件校验（结构/类型/枚举/选择器前缀）
selector.ts      选择器实现（$. / css: / xpath: / @js:）
sandbox.ts       JS 沙箱（iframe + allow-scripts，无 allow-same-origin）
engine.ts        引擎：search → detail → chapter → video
aggregate.ts     多源并发检索
download.ts      章节拼接下载
stream.ts        流代理 URL 构造（平台相关 origin）
playbackProgress.ts 番剧播放进度（localStorage）
mirror.ts        规则镜像（Tauri 适配）
```

**分层**：`schema` → `selector`/`sandbox` → `engine` → `aggregate`。上层不知道下层怎么实现，`engine` 不关心选择器是 CSS 还是 XPath。

---

### `src/stores/` — Pinia 状态

```
library.ts    库条目、导入、删除、重命名、进度
sources.ts    源配置、启用状态、登录态
selection.ts  选择模式（导出与批量删除共用）
export.ts     导出流程状态
theme.ts      主题（浅色/深色/跟随系统）
```

**5 个 store，只有两个是真状态**（library, sources）。`selection` 是从 export 里抽出来的，因为批量删除也要用同一套选择逻辑。

**store 不互相 import**。`sources.ts` 需要刷新资料库时用动态 `import()`，避免循环依赖。

---

### `src/styles/`

```
tokens.css   设计 token（唯一来源）
base.css     全局重置与基础样式
```

**组件里不允许出现硬编码的间距/字号/颜色**。所有数值来自 token。

---

### `src/types/viewer.ts` — 查看器契约

壳与查看器之间的唯一接口。壳不知道 PDF 是什么，只问注册表"谁认领 `pdf`"。

---

### `src/utils/` — 无依赖工具

```
format.ts   字节数、相对时间、扩展名标签
```

只放**不依赖任何项目内模块**的函数，否则会变成隐藏的耦合点。

---

### `src/viewers/` — 内容查看器

```
registry.ts      扩展名 → 查看器映射
host.ts          查看器能用的能力（受控 surface）
builtins.ts      注册内置查看器
TextReader.vue   TXT/MD
PdfReader.vue    PDF
EpubReader.vue   EPUB
AudioPlayer.vue  音频
txt/chapters.ts  章节切分
epub/            解包、资源、主题（zip.ts / package.ts / resources.ts / theme.ts）
```

**查看器拿不到文件系统、拿不到 Tauri、拿不到库**——只能通过 `host` 暴露的方法。这是为了让未来加插件时边界已经很硬。

---

### `src/views/` — 页面（13 个）

```
LibraryView.vue        资料库（列表/卡片、筛选、批量）
ReaderView.vue         本地阅读器外壳
SourcesView.vue        源列表
SourceBrowseView.vue   源内搜索
SourceDetailView.vue   源条目详情（小说/漫画/听书）
SourceReaderView.vue   源章节阅读
SourceEditorView.vue   源编辑器（表单/原文双模式）
SourceTrialView.vue    源试跑（分阶段）
SourceAggregateView.vue 聚合检索
AnimeDetailView.vue    番剧详情（多线路/剧集）
AnimePlayerView.vue    播放器（video + hls.js）
DiscoverView.vue       发现（推荐/时间表）
SettingsView.vue       设置（6 个分类）
```

**视图只做三件事**：取数据、组织布局、转交事件。业务逻辑在 `library/`、`sources/`、`discover/` 里。

---

### `src/i18n/`

```
index.ts   所有文案（一个文件，键是闭合联合类型）
```

用闭合联合类型而不是模板字符串，这样**缺 key 是编译错误**，不是运行时显示成 key 本身。

---

## `src-tauri/src/` 逐模块

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `lib.rs` | 应用入口、命令注册、状态管理 | 所有 `#[tauri::command]` 在这里注册 |
| `model.rs` | `Entry` 等数据结构 | 加字段必须带 `#[serde(default)]`，否则旧数据读不出来 |
| `library.rs` | 库文件读写、导入、删除、重命名 | 元数据单次原子写 |
| `error.rs` | `AppError` / `AppResult` | 错误信息直接面向用户，要能读懂 |
| `sources.rs` | 源配置读写、原子 JSON 写 | `sources_root()` 是运行时数据根 |
| `credentials.rs` | 登录凭证（加密存储） | **没有任何命令把 cookie 交给前端** |
| `crypto.rs` | cookie 加解密 | |
| `login.rs` | 辅助 webview 抓 cookie | **Windows 专用**（WebView2 cookie manager） |
| `net.rs` | 源抓取（唯一给源的 HTTP 通道） | 仅 GET/POST、仅 http(s)、10MB、无 cookie jar |
| `text.rs` | 文本解码（编码检测） | |
| `download.rs` | 下载字节落地 | |
| `export.rs` | 导出写盘 | |
| `external.rs` | 系统浏览器打开 | 应用窗口不能导航走 |
| `stream.rs` | 流代理（HLS 重写、Range 透传） | 仅 GET、64MB/分片、逐跳校验重定向 |
| `proto.rs` | 自定义 scheme handler | **只服务 `main` 窗口**（防 SSRF） |
| `bangumi.rs` | Bangumi 元数据 + 封面缓存 | 镜像、1 req/s、磁盘缓存、负缓存 |
| `rules_mirror.rs` | 社区规则镜像 | **镜像编在 Rust 里，前端只传 id** |
| `sniff/` | WebView 嗅探（CDP） | **仅 Windows**；`pick.rs` 是纯判断层 |

**`sniff/` 的三层**：
```
sniff/mod.rs      接口与抽象（平台无关）
sniff/pick.rs     纯函数：从观测里挑 URL（可测，无平台依赖）
sniff/windows.rs  CDP 采集（COM，仅 Windows，不进测试二进制）
```

---

## 不属于任何目录的约定

| 约定 | 在哪强制 |
|---|---|
| 组件不写死数值 | code review + `tokens.css` |
| 视图不 import Tauri | 只有 4 个适配模块 import（见 02-architecture） |
| 前端不 `fetch` | 全局搜索为空 |
| 加 crate 要理由 | `Cargo.toml` 注释 |

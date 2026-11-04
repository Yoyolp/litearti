# EPUB 查看器

这份文档说明 EPUB 是怎么接进来的、为什么这样接，以及哪些事情**故意**没做。

想看怎么加一种新格式，看 [`viewer-contract.md`](viewer-contract.md)；想看整体架构，看 [`project-overview.md`](project-overview.md)。

---

## 一、它没有改外壳

EPUB 完全落在已有的查看器契约里：

```ts
// src/viewers/builtins.ts
registerViewer({
  id: 'epub',
  label: 'EPUB',
  extensions: ['epub'],
  priority: 0,
  component: EpubReader,
})
```

`App.vue`、`LibraryView.vue`、`ReaderView.vue` 一行没动。Rust 侧也一行没动——解压、解析、渲染全在前端。这是第 3.2 节那条设计（格式归属由前端注册表决定）第一次被真正兑现。

---

## 二、解压：零依赖

EPUB 就是一个 ZIP。项目只有 5 个运行时依赖，为了一件事引入一个压缩库不值得，所以 `epub/zip.ts` 自己读 ZIP：

- 从文件尾向前找 **EOCD**（end of central directory），兼容末尾注释；
- 读**中央目录**，不是本地文件头——中央目录是权威来源，即使条目用了 data descriptor（本地头里长度为 0）也能正确读；
- 支持 **ZIP64**：漫画类大 EPUB 会触发 32 位字段溢出，不处理就会读错偏移；
- 解压交给浏览器原生的 `DecompressionStream('deflate-raw')`，不写 JS 解压循环。

**为什么用 `deflate-raw`**：ZIP 存的是裸 DEFLATE 流，没有 zlib/gzip 包装。`DecompressionStream` 的 `deflate-raw` 正好对应。

**代价**：要求 WebView2 是 Chromium 103+。Win10/11 的 WebView2 是自动更新的，所以实际不是问题；万一不支持，会给出明确提示而不是白屏。

---

## 三、解析：两条历史路径都要走

EPUB 2 和 EPUB 3 的目录结构不一样，市面上的书两种都有，所以两条都实现：

| | EPUB 3 | EPUB 2 |
|---|---|---|
| 目录 | `<nav epub:type="toc">` | `<spine toc="ncx">` 指向 NCX |
| 覆盖 | 优先 | 兜底 |

解析顺序是 `META-INF/container.xml` → OPF → manifest/spine/metadata → 目录。**所有 href 在这里一次性解析成包内绝对路径**，不让相对路径泄漏到后面的模块——相对路径是 EPUB 里最容易出错的地方（它相对于"声明它的那个文档"，不是包根）。

几个容易踩的点，都已经处理：

- `linear="no"` 的 spine 项不是线性阅读顺序（答案页、弹注），跳过；
- `dc:creator` 可以出现多次，用「、」连接；
- 封面有两种约定：EPUB 3 的 `properties="cover-image"` 和 EPUB 2 的 `<meta name="cover">`；
- 命名空间前缀（`dc:title`）一律按 localName 匹配。

---

## 四、渲染：iframe 是安全边界

书的内容是**不可信输入**，还自带 CSS。所以每章渲染进一个 iframe：

```html
<iframe sandbox="allow-same-origin" srcdoc="...">
```

- **有** `allow-same-origin`：父页面要能测量它、给它设高度、往里面挂点击监听；
- **没有** `allow-scripts`：文档不能执行任何代码。

如果直接注入到主 DOM，出版商的 `body { }` 会污染整个应用界面。iframe 是唯一能同时做到「保留原书样式」和「不污染外壳」的边界。

### 布局：外层滚动，iframe 自适应高度

iframe 被撑到内容高度，滚动条在外层容器上。这不是随意的：

- 如果让 iframe 自己滚，章末的「下一章」按钮会被挤到可视区外；
- 进度比率要按外层容器算，外壳才看得见。

高度由一个 `ResizeObserver` 维持——图片加载完、字号改变都会让文档变高。

### 两种模式

| | 原版（默认） | 重排 |
|---|---|---|
| CSS | 书自己的 | 应用的阅读栏 |
| 用途 | 尊重出版方设计 | 排版差的书也能读 |
| 字号 | 固定 | 13–28px 可调 |

**默认原版**，因为一本书的设计是它的一部分。重排是逃生舱，不是默认路径。

重排模式下 `reflowStructure()` 只保留语义标签（`h1`–`h6`、`p`、`blockquote`、列表、表格、图片），丢掉所有表现属性，未知容器替换成子节点——文字活下来，样式不跟过来。

### 固定版式（FXL）

`rendition:layout = pre-paginated` 的书（画册、漫画）走另一条路径：一章就是一页，不滚动，方向键翻页，`page-progression-direction="rtl"` 会反转左右键。

---

## 五、断网与消毒

这是应用的核心承诺之一：**不联网**。所以：

1. **远程资源一律拦掉**，不是「让它加载失败」——失败也是一次连接尝试。CSS 里的远程 `url()` 替换成 `url("data:,")`，`<img src>` 指向远程的直接删属性。
2. **脚本一律删掉**：`<script>`、`<noscript>`、`<iframe>`、`<object>`、`<embed>`、`<base>`、`<meta>` 整类移除；`on*` 事件属性和 `javascript:` URL 逐属性清理。
3. 样式表**内联**成 `<style>`，而不是 `<link>`：文档是 `srcdoc` 喂进去的，相对 URL 没有基准可解析，内联顺带解决了加载顺序问题。
4. 图片、字体通过 blob URL 提供，`ResourceStore` 做缓存——一章四十张插图只解压一次，翻回已读章节不重复解压。

内部链接不保留 `href`，改成 `data-epub-href` 由父页面拦截：让 iframe 自己导航会把整个阅读器换成书的一页。

---

## 六、进度

```ts
{ version: 1, chapter: 3, ratio: 0.42, fontSize: 17, mode: 'original' }
```

`chapter` 是 spine 下标（从 0 开始），`ratio` 是**当前章内**的滚动比率。两个都要：

- 只有章号 → 换个字号，位置就飘了；
- 只有比率 → 跨章没法定位。

`mode` 记住原版/重排的选择。资料库列表读 `chapter` 显示「第 N 章」，看板读它判断「在读」。

---

## 七、DRM

检测，不解密。

`META-INF/encryption.xml` 存在**不等于**有 DRM——字体混淆（`idpf.org/2008/embedding`、`ns.adobe.com/pdf/enc#RC`）是合法的，书照样能读。只有出现非混淆算法才判定为 DRM 保护，显示一段说明，说清楚为什么不支持、也不打算绕过。

---

## 八、明确没做的

| 未做 | 原因 |
|---|---|
| 解密 DRM | 做不到，也不该做 |
| 超过 200 MB 的书 | 整包要读进内存，再大会让应用假死。明确拒绝并说明原因，好过卡死 |
| 分页模式（按屏幕翻页而非按章） | 需要重新实现排版引擎的换行逻辑，收益不足以支撑 |
| 书内搜索 | 要建立全书索引，是另一个量级的工作 |
| 笔记 / 高亮 / 书签 | 需要数据模型，MVP 没挣到 |
| 自定义字体嵌入 | 出版商字体走 blob URL 能渲染，但用户没法换字体 |
| 阅读统计 | 不做假数据 |

## 九、已知技术限制

| 限制 | 影响 | 可能的解法 |
|---|---|---|
| 整包读进内存 | 大漫画包吃内存 | Rust 侧按条目流式读取，`ViewerHost` 加 `readArchiveEntry()` |
| 一章一屏 | 长章节内滚动，不是全书连续 | 需要动态测量多章高度 |
| 重排丢弃出版商 CSS | 特殊排版（首字下沉、多栏）丢失 | 可考虑做样式映射层 |
| 固定版式按页缩放 | 极小字号的页面在窄窗口下偏小 | 加缩放控制 |
| 只处理单页展开 | 双页跨页（spread）未合并 | 读 `rendition:page-spread-*` 做拼页 |

## 十、验证状态

| 项 | 状态 |
|---|---|
| `vue-tsc --noEmit` | ✅ 无错误 |
| `vite build` | ✅ 通过，EPUB 单独成块 26.9 KB（懒加载） |
| `tauri build` | ✅ 通过，release 5.81 MB |
| `scripts/verify-zip.mjs` | ✅ 12 项（stored/deflate/二进制/损坏/ZIP64 边界） |
| `scripts/verify-epub-package.mjs` | ✅ 34 项（EPUB 2 / EPUB 3 / FXL / 破损回退） |
| `scripts/verify-epub-e2e.mjs` | ✅ 24 项（真实字节流全链路） |
| `scripts/verify-ui-epub.mjs` | ✅ 34 项（打包后应用，CDP 断言真实 DOM） |

UI 验证覆盖：应用外壳 → 资料库 → 打开 EPUB → 章节正文/标题/图片 → 无脚本残留 → iframe 高度 → 原版 CSS 生效 → 目录（含嵌套）→ 切到重排 → 重排保留结构且丢弃出版商字体 → 翻章 → 进度落盘 → 重载后恢复。

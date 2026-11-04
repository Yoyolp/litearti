# 查看器接口契约

这份文档面向"想给 litearti 加一种新格式"的人——包括未来的你。

核心承诺只有一句：**加一种格式不需要改外壳代码**。外壳（`App.vue` / `LibraryView` / `ReaderView`）完全不知道 TXT、PDF、MP3 是什么，它只会问注册表"这个扩展名归谁"，然后挂载那个组件。

---

## 一、最小可用示例

下面这个查看器能打开 `.nfo` 文件并把内容居中显示。它可以工作，就这么多：

```ts
// src/viewers/plugins/nfo.ts
import { defineAsyncComponent } from 'vue'
import { registerViewer } from '@/viewers/registry'

registerViewer({
  id: 'nfo',
  label: 'NFO 文本',
  extensions: ['nfo'],
  component: defineAsyncComponent(() => import('./NfoReader.vue')),
})
```

```vue
<!-- src/viewers/plugins/NfoReader.vue -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Entry, ViewerHost } from '@/types/viewer'

const props = defineProps<{ entry: Entry; host: ViewerHost }>()
const text = ref('')

onMounted(async () => {
  const decoded = await props.host.readText(props.entry.id)
  text.value = decoded.text
})
</script>

<template>
  <pre class="nfo">{{ text }}</pre>
</template>
```

然后在 `src/viewers/builtins.ts` 的 `registerBuiltinViewers()` 里 `import './plugins/nfo'` 即可。

---

## 二、`ViewerDescriptor` 全部字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | 稳定标识符，用于日志和排查。不要改，改了等于换了一个查看器。 |
| `label` | `string` | ✅ | 给人看的名字。 |
| `extensions` | `string[]` | 条件必填 | 小写、不带点。与 `probe` 至少提供一个。 |
| `priority` | `number` | | 数值越大越优先。内置的都在 `0`。用户自定义查看器可以靠更高的 priority 抢走某个扩展名。 |
| `probe` | `(bytes, entry) => boolean \| Promise<boolean>` | | 字节级探测。用于"多个查看器抢同一个扩展名"或"文件没有扩展名"的情况。 |
| `component` | `Component` | ✅ | 要挂载的组件。**用 `defineAsyncComponent`**，否则它的引擎会被打进首屏包。 |

### 解析规则

1. 按扩展名筛出候选，按 `priority` 降序。
2. 第一个没有 `probe` 的候选直接胜出。
3. 有 `probe` 的候选按顺序调用，第一个返回 `true` 的胜出。
4. 都不认领 → 返回 `null`，外壳显示"没有查看器"的空状态。

`probe` 抛异常等于"不认领"，不会中断解析。

---

## 三、`ViewerHost`：查看器能做的全部事情

**这是全部能力面**。查看器拿不到文件系统、拿不到 Tauri、拿不到库。

| 方法 | 返回 | 说明 |
|---|---|---|
| `readBinary(entryId)` | `Promise<ArrayBuffer>` | 读原始字节。 |
| `readText(entryId, encoding?)` | `Promise<DecodedText>` | 读并解码为文本。`encoding` 是 WHATWG 标签（`utf-8`、`gb18030`、`big5`…），省略则自动嗅探。 |
| `entryPath(entryId)` | `Promise<string>` | 存储副本的绝对路径。**仅桌面有意义**，且**不能直接喂给 `<img>` / `<audio>`**——webview 拒绝加载裸文件路径。 |
| `entryUrl(entryId)` | `Promise<string>` | 可被 webview 加载的 URL（走 Tauri 的 asset 协议）。要显示图片或播放音频，用这个。 |
| `saveProgress(entryId, progress)` | `Promise<void>` | 存续读位置。外壳原样保存，不解释内容。 |

`DecodedText` 的字段：

```ts
{
  text: string        // 解码后的文本
  encoding: string    // 实际使用的编码名，如 'UTF-8' / 'GB18030'
  hadBom: boolean     // 是否发现并剥离了 BOM
  lossy: boolean      // 是否出现了替换字符（即猜测可能错了）
}
```

`lossy` 是你判断"要不要提示用户手动换编码"的依据。

---

## 四、进度（resume state）的约定

`progress` 是**查看器自己的**数据，外壳只负责存取，不解释。

约定三条：

1. **带版本号。** 你的 payload 第一版写 `{ version: 1, ... }`。将来结构变了，读到旧版本就知道该怎么迁移或丢弃。
2. **存比率，不存像素。** 窗口大小、字号、缩放都会变。存 `scrollTop / (scrollHeight - clientHeight)`，下次乘回去。
3. **能丢。** 进度是 best-effort。丢失进度绝不能导致打不开文件。

内置查看器的实际 payload：

```ts
// 文本：{ version: 1, ratio: 0.42, fontSize: 17 }
// PDF： { version: 1, page: 12 }
// 音频：{ version: 1, time: 214.5, rate: 1.25 }
// EPUB：{ version: 1, chapter: 3, ratio: 0.42, fontSize: 17, mode: 'original' }
```

EPUB 的 `chapter` 是 spine 下标（从 0 开始），`ratio` 是**当前章内**的滚动比率。两者缺一不可：只有章号会在换字号后跳位置，只有比率则跨章无法定位。`mode` 记住「原版 / 重排」的选择。

资料库列表会读这些字段来显示"已读 42%"之类的提示。你的自定义查看器如果沿用 `ratio` / `page` / `time` / `chapter` 这四个字段名，提示会自动生效；用别的字段名则只是不显示提示，不影响功能。

---

## 五、自定义容器格式（漫画包）

你提到的场景——"压缩固定文件结构的压缩包，当作自制漫画文件"——落在同一套接口里。

### 格式约定

建议扩展名 `.lac`（litearti archive comic），实际上任何扩展名都可以。

**方式一：带清单（推荐）**

压缩包根目录放 `litearti.json`：

```json
{
  "version": 1,
  "kind": "comic",
  "title": "示例作品",
  "author": "某人",
  "readingDirection": "rtl",
  "pages": ["001.jpg", "002.jpg", "003.jpg"]
}
```

- `readingDirection`：`"rtl"`（日漫）或 `"ltr"`（默认）。
- `pages`：显式页序。省略则按文件名自然排序（`2.jpg` 排在 `10.jpg` 前面）。

**方式二：无清单回退**

没有 `litearti.json` 时，按目录约定处理：解压后所有图片按文件名自然排序即为页序，标题取压缩包文件名。

### 实现路径

**ZIP 解压能力已经有了**，不需要新增依赖。EPUB 查看器自带一个零依赖的 ZIP 读取器：

```
src/viewers/epub/zip.ts
  ZipArchive.open(bytes)   → 读中央目录（含 ZIP64）
  archive.text(name)       → 解压一个条目为 UTF-8 文本
  archive.read(name)       → 解压一个条目为原始字节
  archive.names()          → 全部条目名
```

它用浏览器原生 `DecompressionStream('deflate-raw')` 解压，不是 JS 解压循环。漫画包直接复用它即可：

```ts
import { ZipArchive } from '@/viewers/epub/zip'

registerViewer({
  id: 'litearti-comic',
  label: '漫画包',
  extensions: ['lac', 'cbz'],
  priority: 10,
  // EPUB 也是 ZIP，所以 `probe` 要能区分两者：有 mimetype 文件的是 EPUB。
  probe: async (bytes) => {
    const head = new Uint8Array(bytes.slice(0, 4))
    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
    if (!isZip) return false
    try {
      return !ZipArchive.open(new Uint8Array(bytes)).has('mimetype')
    } catch {
      return false
    }
  },
  component: defineAsyncComponent(() => import('./ComicReader.vue')),
})
```

页序解析、清单读取、图片渲染仍在查看器组件里完成——`zip.ts` 只负责"给我这个条目的字节"。

**注意**：将来如果包里出现超大文件，整包读进内存会痛。那时应该在 Rust 侧加"按条目读取"的命令，并给 `ViewerHost` 加一个 `readArchiveEntry(entryId, path)`——接口留在这里就是为了那种时刻。EPUB 查看器目前用 200 MB 上限兜住这个问题。

---

## 六、设计约束（给查看器的作者）

查看器是应用的一部分，不是嵌入的网页。所以：

1. **不要引入 UI 组件库。** 用 `src/styles/tokens.css` 里的 token。
2. **不要硬编码数值。** 间距、字号、圆角、阴影都从 token 取。需要新值就先加 token。
3. **工具栏放查看器内部**，紧挨它影响的内容。外壳顶栏只负责"我在哪 / 怎么离开"。
4. **空状态要写清楚**。加载中、出错、格式不支持，三种状态都要有话说，不要只放"暂无数据"。
5. **正文允许选中**，界面元素不允许。`body` 已经设了 `user-select: none`，正文区域记得覆盖成 `text`。
6. **别抢 Esc。** 外壳用 Esc 返回资料库。如果你的查看器开了模态框，先 `preventDefault` 再处理。

---

## 七、安卓移植备忘

这套接口之所以能跨平台，是因为它只依赖四个能力，且**都不假设文件系统路径**（`entryPath` 除外，已标注为桌面限定）。

| 能力 | 桌面 | 安卓将来需要 |
|---|---|---|
| 选文件 | `@tauri-apps/plugin-dialog` 返回路径 | Storage Access Framework，返回 content URI |
| 读字节 | 直接 `fs::read` | `ContentResolver.openInputStream` |
| 解码文本 | Rust `encoding_rs` | 同一套 Rust 代码可直接复用 |
| 存进度 | `library.json` | 同一份 JSON，位置换成 app 私有目录 |
| 音频播放 | `convertFileSrc` → asset 协议 URL | 需要对应的内容 URI 或把字节转 blob URL |

要改的只有 `src/api/library.ts` 这一个文件（见文件头注释）。查看器、状态管理、设计系统、路由逻辑一行都不用动。

`entryPath` 在安卓上会返回一个 content URI 或者干脆抛错，所以**新查看器尽量不要依赖它，改用 `entryUrl`**。`entryUrl` 的实现只有一行 `convertFileSrc`，移植时它是最容易替换成"blob URL"的地方。

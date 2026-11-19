# Android 移植

> 这份文档记录**一个桌面 Tauri 应用变成能装进手机的 APK** 的完整过程，包括所有踩过的坑。
>
> 每个坑都写清了「现象 → 根因 → 修法」。**根因部分不要跳过**——有几处是框架层缺陷，看起来的修法（比如"再加个 polyfill"）都是错的。

---

## 目录

- 1. 环境准备 —— 版本对照表、必装的 SDK 包、Rust targets
- 2. 构建 —— 首次初始化、日常构建、签名、装到手机
- 3. 平台差异：必须改代码的地方 —— 六处分叉点
- 4. 六个真实踩过的坑 —— **每条的根因都要看**
- 5. 未解决的问题
- 6. 上手清单

**如果你只想记一件事**：改了 Rust 代码后要 `cargo test --lib`，加了插件后要检查 Kotlin 侧真的进了 dex（见坑 3）。

---

## 1. 环境准备

### 版本对照表（本项目实测可用）

| 组件 | 版本 | 说明 |
|---|---|---|
| Rust | 1.96.0 | 需要 `aarch64-linux-android` 等 target |
| tauri-cli | 2.12.4 | `@tauri-apps/cli` |
| tauri crate | 2.12.5 | |
| JDK | **21**（Temurin） | **不建议 25**，Gradle 9 + Kotlin 2.2 会有兼容警告 |
| Gradle | 9.6.1 | 由 `tauri android init` 生成 |
| AGP | 9.3.1 | 同上 |
| Kotlin | 2.2.10 | 同上 |
| NDK | 27.2.12479018 | |
| compileSdk / targetSdk | **37** | 模板要求，必须装 `platforms;android-37.0` |
| minSdk | 24 | |
| build-tools | 37.0.0（或 34+） | |

### 需要装的 SDK 包

```powershell
$sdk='C:\Users\<you>\AppData\Local\Android\Sdk'
$sdkm='<cmdline-tools>\bin\sdkmanager.bat'

# 接受许可（一次就好）
& $sdkm --sdk_root=$sdk --licenses

# 平台 + 构建工具 + NDK
& $sdkm --sdk_root=$sdk 'platforms;android-37.0' 'build-tools;37.0.0' 'ndk;27.2.12479018'
```

> **注意**：`platforms;android-37.0` 有个 `.0` 后缀，不是 `android-37`。名字写错会提示包不存在。

### Rust targets

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

只需要 `aarch64` 也能出包（绝大多数手机），其余按需。

### 环境变量

构建脚本会自己找，但手工调试时需要：

```powershell
$env:ANDROID_HOME='C:\Users\<you>\AppData\Local\Android\Sdk'
$env:NDK_HOME="$env:ANDROID_HOME\ndk\27.2.12479018"
$env:JAVA_HOME='D:\programfiles\jdk21\jdk-21.0.13+9'
$env:PATH="$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
```

---

## 2. 构建

### 首次初始化

```powershell
pnpm tauri android init
```

生成 `src-tauri/gen/android/`。**这个目录之后要手工维护**（改 manifest、gradle、加 plugin 依赖都在里面）。

### 日常构建

```powershell
pwsh scripts/build-android.ps1 -Release      # 出签名 APK
pwsh scripts/build-android.ps1               # 出 debug APK（可连 DevTools）
pwsh scripts/build-android.ps1 -Target armv7 -Release
```

产物：`release-android/litearti-<version>-<abi>.apk`

### 为什么不用 `pnpm tauri android build`

**在 Windows 上它会失败**，而且是在付完整个 Rust 编译代价之后：

```
Failed to create a symbolic link ... jniLibs/arm64-v8a/liblitearti_lib.so
Creation symbolic link is not allowed for this system
```

Tauri CLI 把编译好的 `.so` 以**符号链接**放进 jniLibs，这需要开发者模式或 `SeCreateSymbolicLinkPrivilege`。

两条路：

1. **开 Windows 开发者模式** → `pnpm tauri android build --apk --target aarch64` 直接可用（推荐）
2. **用 `scripts/build-android.ps1`** → 改用普通文件复制，不需要任何特权

脚本做的事（和 CLI 一致，只是绕开链接）：

```
再生成 Gradle 工程  →  pnpm build  →  cargo build --features custom-protocol
                    →  copy .so 到 jniLibs  →  gradlew assemble<Abi><Profile>
                    →  apksigner 签名
```

### 签名

`scripts/build-android.ps1` 默认用 `D:\Myproject\litearti-keys\litearti-release.jks`（alias `litearti`，口令 `litearti2026`）。

**这是自签名证书**。正式分发请生成自己的：

```powershell
keytool -genkeypair -v -keystore my-release.jks -alias myapp `
  -keyalg RSA -keysize 2048 -validity 10950 `
  -storepass <pass> -keypass <pass> -dname "CN=..., O=..., C=CN"
```

然后用环境变量覆盖：

```powershell
$env:TAURI_ANDROID_KEYSTORE='D:\path\to\my-release.jks'
$env:TAURI_ANDROID_KEY_ALIAS='myapp'
$env:TAURI_ANDROID_KEY_PASSWORD='<pass>'
```

### 装到手机

```powershell
$adb='C:\Users\<you>\AppData\Local\Android\Sdk\platform-tools\adb.exe'

# 首次需要手机点「允许 USB 调试」
& $adb devices -l                    # 状态必须是 device，不能是 unauthorized

& $adb install -r release-android\litearti-0.1.0-arm64-v8a.apk
& $adb shell am start -n app.litearti.reader/.MainActivity

# 看日志
& $adb logcat -s RustStdoutStderr:* AndroidRuntime:E
& $adb logcat -d -b crash            # 崩溃专用缓冲区
```

---

## 3. 平台差异：必须改代码的地方

### 3.1 文件选择返回的是 `content://` 而不是路径

**桌面**：`open()` 返回 `C:\...`，`fs::copy` 直接用。

**Android**：返回 `content://com.android.providers.media.documents/document/123`。字节属于 ContentProvider，文件系统上没有这个路径。

处理分两件事：

| 事 | 怎么做 | 在哪 |
|---|---|---|
| **拿字节** | `tauri-plugin-fs` 的 `Fs::open` 在 Android 上把 URI 解析成 fd | `android_fs.rs::open_for_read` |
| **拿文件名** | 文件名在 ContentResolver 的 `DISPLAY_NAME` 列，没有 Rust 绑定 → **JNI** | `android_fs.rs::display_name` |

文件名不是装饰：扩展名决定用哪个查看器，词干是书名。

```rust
// 判定
pub fn is_content_uri(raw: &str) -> bool {
    raw.trim_start().starts_with("content://")
}
```

`import_stream` 用闭包写入而不是传 `&[u8]`：一个无损音频几百 MB，全读进内存会被系统杀。

**踩坑**：`FilePath` 没有 `From<&str>`。必须显式构造：

```rust
let target = if is_content_uri(location) {
    FilePath::Url(Url::parse(location)?)
} else {
    FilePath::Path(PathBuf::from(location))
};
```

### 3.2 TLS 必须绕开平台验证器

见第 4 节「坑 2」。所有出站 HTTP 走 `tls::builder()`，**不要**直接 `reqwest::Client::builder()`。

### 3.3 打开外部链接

`rundll32` / `xdg-open` 在 Android 上不存在。用 `tauri-plugin-opener`，它映射到 `startActivity` Intent。

```rust
app.opener().open_url(target, None::<&str>)
```

### 3.4 明文 HTTP

书源大量是 http。Android 从 API 28 起默认禁明文，release 包会静默失败（报"网络错误"）。

`gen/android/app/build.gradle.kts`：

```kotlin
defaultConfig {
    manifestPlaceholders["usesCleartextTraffic"] = "true"   // 模板默认 false
}
```

模板只在 debug 里设 `true`，所以**正好是正式包装上才出问题**。

### 3.5 文件夹选择器不可用

Android 没有「选一个可写目录」的机制（分区存储只给单文件授权）。插件直接抛：

```
Folder picker is not implemented on mobile
```

`src/export/pickDirectory.ts` 提前拦住，给中文提示。

### 3.6 布局断点

`src/styles/tokens.css` 里有两个断点，都基于 719px：

| 断点 | 作用 |
|---|---|
| `@media (max-width: 719px)` | 侧栏默认折叠成 56px 图标栏（`App.vue` 的 `readCollapsed`）、内边距收窄 |
| `@media (pointer: coarse)` | 触控目标放大到 44px（按**指针类型**而非宽度，触屏笔记本也受益） |

安全区用 `env(safe-area-inset-*)`，前提是 `index.html` 里有 `viewport-fit=cover`。

---

## 4. 六个真实踩过的坑

### 坑 1：APK 装上了，打开是白屏

**现象**

```
Failed to request http://localhost:1420/: error sending request
```

**根因**

`cargo build --release` 默认**不带** `custom-protocol` feature。Tauri 靠它判断正式模式：

- 没有 → `tauri-build` 发 `cfg(dev)`，生成的 context 保留 `build.devUrl`，**前端资源根本不嵌进二进制**
- 有 → 资源内嵌，走 `tauri://localhost`

这也解释了为什么包只有 9.3 MB——它压根没装前端。

**修法**

```toml
# src-tauri/Cargo.toml
[features]
custom-protocol = ["tauri/custom-protocol"]
```

构建时加 `--features custom-protocol`。包变成 11.9 MB，多出来的就是前端。

**防线**：脚本会检查 `.so` 里有没有**当前 hash 的前端 bundle**，没有就报错。

> **检查逻辑的坑**：第一版是「二进制里不能出现 `localhost:1420`」，结果**误报**——配置结构体在 release 包里也保留 `devUrl` 字符串。判据改成「资源在不在」才对。

---

### 坑 2：rustls 平台验证器导致进程 abort

**现象**

网络请求一来就闪退到桌面：

```
Abort message: 'Expect rustls-platform-verifier to be initialized'
signal 6 (SIGABRT) in tid (tokio-rt-worker)
```

**根因**

reqwest 的 `rustls` feature 在 Android 上走 `rustls-platform-verifier`，它要调 JVM 的 `TrustManager`。不经初始化就发请求 → **进程级 abort**，不是可捕获异常。

官方方案要往 Gradle 里加一个 AAR，而那个 AAR 只发布在 GitHub 的 Maven 仓库里。

**修法**

新建 `tls.rs`，用 `webpki-roots`（内置 Mozilla 根证书）自建 `ClientConfig`：

```rust
reqwest::Client::builder().tls_backend_preconfigured(webpki_roots_config())
```

reqwest 会直接用这个配置，完全不碰平台验证器。**所有 6 处 `Client::builder()` 都要改**，漏一处就前功尽弃。

**代价**：静态根证书列表，用户自建的企业 CA 不再被信任。对公网书源够用。

**测试的坑**：`client_config()` 在非 Android 返回 `None`，所以最初那个测试**根本没测到预配置分支**，等于假通过。补了一个直接断言 `build()` 成功的测试——因为 reqwest 类型不匹配时不会当场报错，而是静默退化成 `UnknownPreconfigured`，只在 `build()` 时才炸。

---

### 坑 3：插件编进了 Rust，Kotlin 侧却没进包

**现象**

构建成功、安装成功、启动成功，但调用插件时报「plugin not found」。

**根因**

`tauri.settings.gradle` 和 `app/tauri.build.gradle.kts` 是从 `Cargo.toml` **派生**的。加了插件（`tauri-plugin-fs`）它们就过期了。

而脚本为了绕开符号链接跳过了 CLI——**生成步骤也跟着被跳过**。

**修法**

构建前跑一次 `tauri android build` 触发再生成（它会在符号链接处失败，正好是脚本要绕的那步，忽略即可），然后交叉校验：

```powershell
$declared = [regex]::Matches($cargoToml, '(?m)^(tauri-plugin-[a-z0-9-]+)\s*=') | ...
$missing = $declared | Where-Object { $settings -notmatch [regex]::Escape(":$_") }
if ($missing) { throw "Gradle project is missing plugin module(s): ..." }
```

**验证方法**：解压 APK 的 dex，搜插件类名。

```powershell
# 注意 fs 插件的包名是 com.plugin.fs，不是 app.tauri.fs
foreach($t in 'FsPlugin','OpenerPlugin','DialogPlugin','com/plugin/fs'){ ... }
```

---

### 坑 4：PDF 打不开（两轮，两代 API）

**第一轮**：`a.toHex is not a function`

**第二轮**：`i(...) getOrInsertComputed is not a function`

**根因**

pdf.js 6.x 用了很新的 JS 内置方法：

| API | 出现次数 | Chrome 版本要求 |
|---|---|---|
| `Map.getOrInsertComputed` | 33 | 140+ |
| `Promise.withResolvers` | 42 | 119+ ✓ |
| `Uint8Array.toHex/toBase64/fromBase64` | 各 2 | 较新 |

测试机 WebView 是 **134**，所以 `getOrInsertComputed` 必然缺失。

**补 polyfill 是死路**：逐个补永远补不完。而且 `legacy/` 构建也用了 22 次——legacy 只转译**语法**，不补**内置方法**。

**修法：降级到 pdf.js 4.10.38**

```powershell
pnpm add pdfjs-dist@4.10.38
```

验证：`getOrInsertComputed` **0 处**，且 `toHex`/`toBase64`/`fromBase64` 它自己做了 feature-detect（有原生就用，没有就纯 JS 回退），**不需要任何 polyfill**。

同时要改两处 API 差异：

```ts
// 4.x 没有 wasmUrl / iccUrl
pdfjs.getDocument({ data, cMapUrl, cMapPacked, standardFontDataUrl })

// 4.x 用 canvasContext，6.x 才有 canvas 参数
const context = canvas.getContext('2d')
await page.render({ canvasContext: context, viewport, transform }).promise
```

**教训**：升级 pdf.js 前先在目标 WebView 上验证。检查方法：

```powershell
Select-String -Path 'node_modules\pdfjs-dist\build\pdf.worker.mjs' -Pattern 'getOrInsertComputed' -AllMatches
```

---

### 坑 5：全屏按钮完全没反应

**现象**

点全屏，什么都不发生，也不报错。

**根因**

wry 的 Android 实现里，`RustWebChromeClient.onShowCustomView` 第一行就是：

```kotlin
override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    callback.onCustomViewHidden()   // 请求全屏的瞬间就被取消
    super.onShowCustomView(view, callback)
}
```

所以 `requestFullscreen()` 在 Android WebView 上**必然无效**，而且不抛错（promise 照常 resolve）。

**修法**

加 CSS 伪全屏兜底：

```ts
try {
  await shell.requestFullscreen()
  // 不能只看 promise：浏览器即使立刻取消也会 resolve
  if (document.fullscreenElement) return
} catch { /* 落到 CSS 模式 */ }
pseudoFullscreen.value = true
```

```css
.player.is-pseudo-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #000;
}
```

桌面走真全屏，手机走 CSS，按钮总有反应。

---

### 坑 6：封面迟迟不显示

**现象**

发现页卡片一直是占位符，等很久也不出来。

**根因（两层）**

1. **DNS 污染**（环境问题，代码修不了）

   设备实测：

   | 域名 | 解析到 | 结果 |
   |---|---|---|
   | `api.bgm.tv` | 172.67.73.67 | 有时通 |
   | `lain.bgm.tv`（**所有封面**）| 31.13.87.9（Facebook）| 100% 丢包 |

   每次解析结果都不同，且都是无关服务的 IP。典型污染。

2. **并发雪崩**（代码问题，已修）

   80 张卡片同时发 80 个请求，把连接池占满，**每一张都等满超时**。

**修法**

- 并发上限 6（`COVER_CONCURRENCY`），用原子计数而不是 `tokio::sync::Semaphore`（tokio 是 dev-dependency）
- 连接超时 3s、总超时 6s（黑洞域名会一直卡在 `connect`）

```rust
static COVER_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
const COVER_CONCURRENCY: usize = 6;
```

**注意 `system-proxy`**：`reqwest` 的 `default-features = false` 会丢掉它，导致**桌面**不读系统代理。已加回。但它只读环境变量，**Android 拿不到系统代理设置**，所以对手机没用。

---

## 5. 未解决的问题

### 5.1 手机上的封面（DNS 污染）

代码层面已优化（并发 + 短超时），但域名被污染这件事代码解决不了。可选方向：

1. 应用内加代理设置（自己填地址）——需要新增配置面板
2. 用户自备能通的路由/DNS
3. 封面失败时给明确提示，而不是静默占位

### 5.2 嗅探仅 Windows

`sniff/` 只实现了 Windows CDP。Android 的 `shouldInterceptRequest` 其实更强，但这是新功能。`sniff/mod.rs` 的 gate 很干净，其他平台会返回「不支持」而不是失败。

### 5.3 自动抓登录 Cookie 仅 Windows

`login.rs:340` 有非 Windows 兜底，返回友好错误，不会崩。

### 5.4 导出无文件夹选择

见 3.5。Android 的存储模型不支持「选目录批量写」。

---

## 6. 上手清单

### 改了 Rust 代码

```powershell
cd src-tauri; cargo test --lib          # 176 个测试
pwsh scripts/build-android.ps1 -Release
```

### 改了前端

```powershell
pnpm build                               # 含 vue-tsc 类型检查
pwsh scripts/build-android.ps1 -Release
```

### 加了新插件（最容易踩坑）

1. `Cargo.toml` 加依赖
2. `lib.rs` 加 `.plugin(...)`
3. `capabilities/default.json` 加权限
4. **重新跑一次 `pnpm tauri android init` 或让脚本的再生成步骤生效**
5. **解压 APK 检查插件类进了 dex**（坑 3）

### 升级前端依赖

- **pdfjs-dist**：先在目标 WebView 上验证新 API（坑 4）
- **hls.js**：注意 `hls.light` 体积更小

### 构建后必查

```powershell
# 1. 前端真的嵌进去了吗
#    脚本会自动检查，手工验证看 .so 大小（~10 MB 说明有前端）

# 2. 明文设置对吗
& $bt\aapt2.exe dump xmltree --file AndroidManifest.xml $apk | Select-String cleartext

# 3. 签名对吗
& $bt\apksigner.bat verify --print-certs $apk

# 4. 装上去会不会崩
& $adb logcat -d -b crash
```

---

## 附：Android 工程里哪些文件可以改

`src-tauri/gen/android/` 是 `tauri android init` 生成的，但**之后就是你的工程**，可以改：

| 文件 | 可以改什么 |
|---|---|
| `app/build.gradle.kts` | `usesCleartextTraffic`、依赖、sdk 版本 |
| `app/src/main/AndroidManifest.xml` | 权限、Activity 配置 |
| `app/src/main/java/.../MainActivity.kt` | 启动逻辑 |
| `gradle.properties` | JVM 参数、构建开关 |

**不要改**（会被重新生成覆盖）：

- `tauri.settings.gradle`
- `app/tauri.build.gradle.kts`
- `app/tauri.properties`

`pnpm tauri android init` 会覆盖整个目录。**改过的内容要先备份**，或者干脆别重跑 init（用 `-f` 之外的方式让脚本再生成）。

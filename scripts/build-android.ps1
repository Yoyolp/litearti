# Build an Android APK for litearti.
#
# ## Why this script exists
#
# The normal entry point is `pnpm tauri android build`. On Windows that fails at the
# very last step before Gradle: the CLI publishes the freshly built Rust library into
# `gen/android/app/src/main/jniLibs/<abi>/` as a *symbolic link*, and creating one
# needs either Developer Mode or SeCreateSymbolicLinkPrivilege. Without that the build
# dies with "Creation symbolic link is not allowed for this system" — after paying for
# the whole Rust compile first.
#
# The link is only an optimisation: Gradle just needs the .so to be present in jniLibs
# before it merges native libraries. So this script performs the same steps by hand,
# using a plain copy, and never requires the privilege.
#
# Prefer `pnpm tauri android build` if you have Developer Mode enabled; use this when
# you don't, or on a locked-down machine.
#
# ## Usage
#
#   pwsh scripts/build-android.ps1                    # arm64 debug APK
#   pwsh scripts/build-android.ps1 -Release           # arm64 release APK, signed
#   pwsh scripts/build-android.ps1 -Target armv7 -Release
#
# Environment: ANDROID_HOME / ANDROID_SDK_ROOT and JAVA_HOME are honoured when set;
# otherwise the usual per-user SDK location and the JDK under D:\programfiles are used.
# Signing needs a keystore: set TAURI_ANDROID_KEYSTORE / _ALIAS / _PASSWORD, or accept
# the defaults below.

[CmdletBinding()]
param(
  [ValidateSet('aarch64', 'armv7', 'i686', 'x86_64')]
  [string]$Target = 'aarch64',
  [switch]$Release,
  [string]$Keystore = $env:TAURI_ANDROID_KEYSTORE,
  [string]$KeyAlias = $(if ($env:TAURI_ANDROID_KEY_ALIAS) { $env:TAURI_ANDROID_KEY_ALIAS } else { 'litearti' }),
  [string]$StorePassword = $(if ($env:TAURI_ANDROID_KEY_PASSWORD) { $env:TAURI_ANDROID_KEY_PASSWORD } else { 'litearti2026' })
)

$ErrorActionPreference = 'Stop'

# --- target tables ---------------------------------------------------------------
# Rust triple, Gradle product flavor (arch), and the ABI directory Gradle expects.
$targets = @{
  'aarch64' = @{ Triple = 'aarch64-linux-android';     Arch = 'arm64';  Flavor = 'Arm64' }
  'armv7'   = @{ Triple = 'armv7-linux-androideabi';   Arch = 'arm';    Flavor = 'Arm'   }
  'i686'    = @{ Triple = 'i686-linux-android';        Arch = 'x86';    Flavor = 'X86'   }
  'x86_64'  = @{ Triple = 'x86_64-linux-android';      Arch = 'x86_64'; Flavor = 'X86_64' }
}
$abiDirs = @{
  'aarch64' = 'arm64-v8a'; 'armv7' = 'armeabi-v7a'; 'i686' = 'x86'; 'x86_64' = 'x86_64'
}
$t = $targets[$Target]
$abi = $abiDirs[$Target]

$repo = Split-Path -Parent $PSScriptRoot
$crateDir = Join-Path $repo 'src-tauri'
$androidDir = Join-Path $crateDir 'gen\android'
$buildProfile = if ($Release) { 'release' } else { 'debug' }
$profileName = $buildProfile.Substring(0, 1).ToUpper() + $buildProfile.Substring(1)

# --- toolchain discovery ---------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) { throw "Android SDK not found. Set ANDROID_HOME (tried '$sdk')." }

$ndk = $env:NDK_HOME
if (-not $ndk) {
  $ndkRoot = Join-Path $sdk 'ndk'
  if (-not (Test-Path $ndkRoot)) { throw "No NDK under '$ndkRoot'. Install one with sdkmanager 'ndk;<version>'." }
  # Highest installed version wins; side-by-side naming sorts lexically well enough here.
  $ndk = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName
}

$javaHome = $env:JAVA_HOME
if (-not $javaHome -or -not (Test-Path (Join-Path $javaHome 'bin\java.exe'))) {
  # Gradle 9 / AGP 9 need a JDK in the 17..25 range; JDK 25 is deliberately avoided
  # because Kotlin 2.2's compiler warns on it.
  $candidates = @(
    'D:\programfiles\jdk21\jdk-21.0.13+9'
  )
  $javaHome = $candidates | Where-Object { Test-Path (Join-Path $_ 'bin\java.exe') } | Select-Object -First 1
}
if (-not $javaHome) { Write-Warning 'JAVA_HOME is not set; falling back to whatever java is on PATH.' }

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:NDK_HOME = $ndk
if ($javaHome) { $env:JAVA_HOME = $javaHome; $env:PATH = "$javaHome\bin;$env:PATH" }
$env:PATH = "$sdk\platform-tools;$env:PATH"

$ndkBin = Join-Path $ndk 'toolchains\llvm\prebuilt\windows-x86_64\bin'
if (-not (Test-Path $ndkBin)) { throw "NDK toolchain not found at '$ndkBin'." }

# The linker wrapper is per-API-level; take minSdk straight from the generated Gradle
# config so the two cannot drift apart.
$appGradle = Get-Content (Join-Path $androidDir 'app\build.gradle.kts') -Raw
$apiLevel = if ($appGradle -match 'minSdk\s*=\s*(\d+)') { $Matches[1] } else { '24' }
$clangTriple = $t.Triple.Replace('-', '_')
$clang = Join-Path $ndkBin "$($t.Triple)$apiLevel-clang.cmd"
if (-not (Test-Path $clang)) { throw "NDK linker wrapper missing: '$clang'." }

# Cargo reads the linker per target; the cc/ar vars are what ring and other C deps use.
Set-Item -Path "env:CARGO_TARGET_$($t.Triple.ToUpper() -replace '-', '_')_LINKER" -Value $clang
Set-Item -Path "env:CC_$clangTriple" -Value $clang
Set-Item -Path "env:CXX_$clangTriple" -Value (Join-Path $ndkBin "$($t.Triple)$apiLevel-clang++.cmd")
Set-Item -Path "env:AR_$clangTriple" -Value (Join-Path $ndkBin 'llvm-ar.exe')
Set-Item -Path "env:RANLIB_$clangTriple" -Value (Join-Path $ndkBin 'llvm-ranlib.exe')
$env:TAURI_ENV_TARGET_TRIPLE = $t.Triple
$env:TAURI_ENV_PLATFORM = 'android'
$env:TAURI_ENV_ARCH = $Target
$env:TAURI_ENV_DEBUG = if ($Release) { 'false' } else { 'true' }

Write-Host "==> target $Target ($($t.Triple)), profile $buildProfile" -ForegroundColor Cyan
Write-Host "    SDK $sdk"
Write-Host "    NDK $ndk (API $apiLevel)"
Write-Host "    JDK $javaHome"

# --- 0. keep the generated Gradle graph in sync -----------------------------------
# `tauri android build` writes two files the Gradle build cannot work without:
#
#   tauri.settings.gradle        which plugin Gradle modules to include
#   app/tauri.build.gradle.kts   the matching implementation(...) entries
#
# They are derived from Cargo.toml, so adding a plugin makes them stale. Skipping
# this step (as the first version of this script did, because it skipped the CLI
# entirely) produces an APK that builds and installs but silently lacks the
# plugin's Kotlin side — the Rust half is present, so calls fail at runtime with
# "plugin not found" instead of failing the build. That is a nasty way to be
# wrong, so the regeneration is not optional.
#
# The CLI cannot be asked to regenerate these on its own: `tauri android
# android-studio-script` needs an IPC server that only a running `tauri android
# build` provides. Running the real command is therefore the way — it does the
# generation first and fails later at the symlink step, which is exactly the part
# this script works around. The failure is expected and ignored.
Push-Location $repo
try {
  Write-Host '==> regenerating Android project files' -ForegroundColor Cyan
  $regenArgs = @('tauri', 'android', 'build', '--apk', '--target', $Target)
  if ($Release) { $regenArgs += '--release' } else { $regenArgs += '--debug' }
  # pnpm's Windows shim writes its own banner and progress to stderr, which
  # PowerShell would otherwise promote to a terminating error under 'Stop' —
  # killing the script on output that is not a failure. The exit code is what
  # matters here, and the failure at the symlink step is expected anyway.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & pnpm @regenArgs 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
} finally { Pop-Location }

$settingsGradle = Join-Path $androidDir 'tauri.settings.gradle'
if (-not (Test-Path $settingsGradle)) { throw "Missing '$settingsGradle'; Android project is not initialised (run 'pnpm tauri android init')." }

# Cross-check Cargo.toml's tauri plugins against what Gradle will include. A
# plugin present in Rust but absent here is the silent-runtime-failure case
# above, so it is worth failing loudly instead of shipping it.
$cargoToml = Get-Content (Join-Path $crateDir 'Cargo.toml') -Raw
$settings = Get-Content $settingsGradle -Raw
$declared = [regex]::Matches($cargoToml, '(?m)^(tauri-plugin-[a-z0-9-]+)\s*=') |
  ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$missing = $declared | Where-Object { $settings -notmatch [regex]::Escape(":$_") }
if ($missing) {
  throw "Gradle project is missing plugin module(s): $($missing -join ', '). The regeneration step did not pick them up."
}
Write-Host "    plugins: $($declared -join ', ')"

# --- 1. frontend -----------------------------------------------------------------
# What `tauri android build` would have run via build.beforeBuildCommand.
Push-Location $repo
try {
  Write-Host '==> building frontend' -ForegroundColor Cyan
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed ($LASTEXITCODE)." }
} finally { Pop-Location }

# --- 2. Rust library -------------------------------------------------------------
# `--features custom-protocol` is not optional. Without it `tauri-build` reports
# `cfg(dev)`, and the generated context embeds `build.devUrl` — so the APK ships
# pointing at http://localhost:1420 and shows "Failed to request ..." on a phone
# with no dev server. The frontend bundle is then not embedded at all, which is
# why the APK also comes out suspiciously small. `tauri android build` adds this
# feature itself; a hand-rolled cargo invocation has to pass it explicitly.
Push-Location $crateDir
try {
  Write-Host '==> building Rust library' -ForegroundColor Cyan
  $cargoArgs = @('build', '--lib', '--target', $t.Triple, '--features', 'custom-protocol')
  if ($Release) { $cargoArgs += '--release' }
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)." }
} finally { Pop-Location }

# The crate's [lib] name decides the .so name the Kotlin side loads.
$libName = if ((Get-Content (Join-Path $crateDir 'Cargo.toml') -Raw) -match '\[lib\][\s\S]*?name\s*=\s*"([^"]+)"') { $Matches[1] } else { throw 'Cannot read [lib] name from Cargo.toml.' }
$soPath = Join-Path $crateDir "target\$($t.Triple)\$buildProfile\lib$libName.so"
if (-not (Test-Path $soPath)) { throw "Built library missing: '$soPath'." }

# A release build must have the frontend embedded. Without `custom-protocol` the
# library still compiles cleanly and the APK still installs — it just opens to
# "Failed to request http://localhost:1420/".
#
# The test is "are the assets inside?", not "is the dev URL absent": the config
# struct keeps `build.devUrl` as a string even in a release build, so grepping for
# localhost always matches and would reject a perfectly good binary. Embedded
# assets are the thing that actually decides whether the webview can render.
if ($Release) {
  $text = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($soPath))
  if (-not $text.Contains('index.html')) {
    throw 'Built library has no embedded frontend (index.html not found in the binary); the APK would open to a blank error page.'
  }
  # A hashed bundle name from `dist/assets` only exists if the real frontend was
  # compiled in, so this catches a stale dev build that happens to contain an
  # index.html string.
  $bundleStem = Get-ChildItem (Join-Path $repo 'dist\assets') -Filter 'index-*.js' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($bundleStem -and -not $text.Contains($bundleStem.BaseName)) {
    throw "Built library is missing the current frontend bundle ($($bundleStem.Name)). Run with --features custom-protocol so the assets are embedded."
  }
  Write-Host ("    embedded frontend: {0:N1} MB library" -f ((Get-Item $soPath).Length / 1MB))
}

# --- 3. publish the .so where Gradle looks for it --------------------------------
$jniDir = Join-Path $androidDir "app\src\main\jniLibs\$abi"
New-Item -ItemType Directory -Force -Path $jniDir | Out-Null
Copy-Item $soPath (Join-Path $jniDir "lib$libName.so") -Force
Write-Host ("==> copied lib{0}.so ({1:N1} MB) into jniLibs\{2}" -f $libName, ((Get-Item $soPath).Length / 1MB), $abi) -ForegroundColor Cyan

# --- 4. Gradle -------------------------------------------------------------------
# The rustBuild<Flavor><Profile> task would shell back out to `tauri android
# android-studio-script`, which is where the symlink comes from — so it is excluded.
$gradleTask = "assemble$($t.Flavor)$profileName"
$excluded = "rustBuild$($t.Flavor)$profileName"

Push-Location $androidDir
try {
  Write-Host "==> gradle $gradleTask (excluding $excluded)" -ForegroundColor Cyan
  & (Join-Path $androidDir 'gradlew.bat') $gradleTask `
    "-x" $excluded `
    "-ParchList=$($t.Arch)" "-PtargetList=$Target" `
    '--console=plain'
  if ($LASTEXITCODE -ne 0) { throw "Gradle failed ($LASTEXITCODE)." }
} finally { Pop-Location }

$apkDir = Join-Path $androidDir "app\build\outputs\apk\$($t.Arch)\$buildProfile"
$built = Get-ChildItem $apkDir -Filter '*.apk' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built) { throw "No APK produced in '$apkDir'." }

# --- 5. sign ---------------------------------------------------------------------
$version = (Get-Content (Join-Path $crateDir 'tauri.conf.json') -Raw | ConvertFrom-Json).version
$outDir = Join-Path $repo 'release-android'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$finalName = "litearti-$version-$abi$(if ($Release) { '' } else { '-debug' }).apk"
$final = Join-Path $outDir $finalName

if (-not $Release) {
  # AGP signs debug builds with the local debug keystore; nothing to do.
  Copy-Item $built.FullName $final -Force
} else {
  if (-not $Keystore) { $Keystore = 'D:\Myproject\litearti-keys\litearti-release.jks' }
  if (-not (Test-Path $Keystore)) { throw "Release build needs a keystore; '$Keystore' not found. Set TAURI_ANDROID_KEYSTORE." }

  $buildTools = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory |
    Sort-Object { [version]($_.Name -replace '(-.*)$', '') } -Descending | Select-Object -First 1 -ExpandProperty FullName
  $apksigner = Join-Path $buildTools 'apksigner.bat'
  if (-not (Test-Path $apksigner)) { throw "apksigner not found in '$buildTools'." }

  # AGP leaves release APKs unsigned when no signingConfig is present; sign explicitly.
  Write-Host '==> signing' -ForegroundColor Cyan
  & $apksigner sign --ks $Keystore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$StorePassword" --key-pass "pass:$StorePassword" `
    --v1-signing-enabled true --v2-signing-enabled true `
    --out $final $built.FullName
  if ($LASTEXITCODE -ne 0) { throw "apksigner failed ($LASTEXITCODE)." }

  & $apksigner verify $final
  if ($LASTEXITCODE -ne 0) { throw 'Signature verification failed.' }
}

Write-Host ''
Write-Host "APK: $final" -ForegroundColor Green
Write-Host ("     {0:N1} MB" -f ((Get-Item $final).Length / 1MB)) -ForegroundColor Green
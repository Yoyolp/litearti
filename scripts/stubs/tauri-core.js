/**
 * Stub for `@tauri-apps/api/core`, for verify scripts that bundle app code and
 * run it in a plain browser context.
 *
 * These scripts exercise the source engine, which imports the API module
 * transitively through its default fetcher. Nothing on the paths under test calls
 * into Tauri, so a stub that throws is both honest and useful: if a test ever does
 * reach IPC, it fails loudly instead of silently making a network call.
 */

export function invoke(command) {
  throw new Error(`Tauri IPC is not available in this test context (invoked "${command}")`)
}

export function convertFileSrc(path) {
  return path
}

/**
 * Verifies the JS sandbox's isolation properties.
 *
 * Run with: node scripts/verify-source-sandbox.mjs
 *
 * This cannot run in Node: the whole point of the sandbox is a browser iframe,
 * and a shim would test the shim rather than the boundary. So this script
 * inspects the *source* for the properties that matter and reports which ones
 * require a real browser to prove:
 *
 *   - the frame is created with `allow-scripts` and NOT `allow-same-origin`
 *   - no network API is exposed to the expression
 *   - a timeout tears the frame down
 *   - messages are only accepted from the sandbox's own window
 *
 * A companion check in `verify-ui-sources.mjs` exercises it live in the packaged
 * app. Keeping the static check separate means a regression in the sandbox
 * attributes fails fast, without needing a build.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = 'D:/Myproject/litearti'

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

async function main() {
  const sandbox = await readFile(join(root, 'src/sources/sandbox.ts'), 'utf8')
  const schema = await readFile(join(root, 'src/sources/schema.ts'), 'utf8')

  console.log('frame attributes')
  {
    check(
      'sandbox attribute is allow-scripts',
      /setAttribute\(\s*'sandbox'\s*,\s*'allow-scripts'\s*\)/.test(sandbox),
      'the sandbox attribute must be exactly allow-scripts',
    )
    check(
      'allow-same-origin is NOT granted',
      !/allow-same-origin'/.test(sandbox.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
      'allow-same-origin would let the frame reach __TAURI_INTERNALS__',
    )
    check(
      'frame is loaded from srcdoc, not a URL',
      sandbox.includes('frame.srcdoc'),
      'srcdoc avoids a network bootstrap',
    )
    check(
      'frame is not attached to the visible layout',
      /width:0;height:0/.test(sandbox),
      'the host must not affect layout',
    )
  }

  console.log('what the expression can reach')
  {
    // The expression body must not reference the parent, storage, or network.
    const body = sandbox.slice(sandbox.indexOf('const SANDBOX_HTML'))
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'localStorage', 'indexedDB', 'importScripts']) {
      // These may appear in comments explaining their absence; only flag actual
      // code use inside the sandbox document.
      const codeOnly = body
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      check(`sandbox does not expose ${forbidden}`, !codeOnly.includes(forbidden), forbidden)
    }
    check(
      'expression is wrapped so globals are limited',
      sandbox.includes("with (SAFE_GLOBALS)"),
      'the with-block scopes what an expression can name',
    )
    check(
      'results are normalised before crossing the boundary',
      sandbox.includes('function normalise'),
      'objects must not cross postMessage',
    )
  }

  console.log('message handling')
  {
    check(
      'messages are checked against the frame window',
      sandbox.includes('event.source !== frame.contentWindow'),
      'without this, any frame could forge a result',
    )
    check(
      'messages are tagged to avoid collisions',
      // Both spellings are legitimate: the tag appears as an object literal on
      // the sending side and as a comparison on the receiving side.
      /__sandbox:\s*'eval'/.test(sandbox) &&
        /__sandbox:\s*'result'/.test(sandbox) &&
        /__sandbox === 'result'/.test(sandbox),
      'each direction must tag its messages',
    )
    check('there is a ready handshake', sandbox.includes("__sandbox === 'ready'"))
  }

  console.log('runaway protection')
  {
    check(
      'evaluation has a timeout',
      /EVAL_TIMEOUT_MS\s*=\s*\d+/.test(sandbox),
      'an infinite loop must not hang the app',
    )
    check(
      'timeout destroys the frame rather than just rejecting',
      sandbox.includes('this.teardownFrame()'),
      'a busy loop cannot be interrupted from outside; the frame must go',
    )
    check(
      'pending evaluations are rejected on teardown',
      sandbox.includes('沙箱被重建'),
    )
    check('dispose is implemented', sandbox.includes('dispose(): void'))
  }

  console.log('validation-time defence in depth')
  {
    check(
      'schema bans network identifiers',
      schema.includes("'fetch'") && schema.includes("'XMLHttpRequest'"),
    )
    check(
      'schema bans tauri internals',
      schema.includes('__TAURI_INTERNALS__'),
    )
    check(
      'schema bans parent access',
      schema.includes("'parent'") && schema.includes("'window'"),
    )
  }

  console.log('')
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
  console.log('')
  console.log('note: these are static checks. The live boundary is exercised by')
  console.log('      scripts/verify-ui-sources.mjs against the packaged app.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

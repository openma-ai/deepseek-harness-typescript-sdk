/** Shared helpers for the SDK test suite. */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the scripted fake runtime. */
export const FAKE_RUNTIME = join(dirname(fileURLToPath(import.meta.url)), 'fake-runtime.mjs')

/** Launch args that run the fake runtime under the current Node. */
export const FAKE_LAUNCH = { command: process.execPath, args: [FAKE_RUNTIME] }

/** A per-test temp directory (realpathed) registered for recursive removal. */
export function tempDir(cleanups: (() => void)[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sdk-test-')))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Child env for the fake runtime: the parent env plus scripted knobs. */
export function fakeEnv(knobs: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...knobs }
}

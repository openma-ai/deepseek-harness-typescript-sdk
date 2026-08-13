/**
 * Default runtime launch resolution — the TypeScript equivalent of the Python
 * SDK's `deepseek_harness_runtime.resolve_bundled_launch_args`. Resolution
 * order for a launch with no explicit command:
 *
 * 1. `DSH_RUNTIME_BIN` — an explicit runtime executable path.
 * 2. An installed npm package that ships the `dsh-jsonrpc-agent` bin
 *    (`@deepseek-ai/dsh-sdk-jsonrpc-demo`), launched as `node <bin.js>`.
 *
 * When the npm package also ships a default Cordis composition
 * (`runtime/cordis.yml` or `cordis.yml`), its path is reported so the client
 * can inject `DSH_CORDIS_CONFIG` for zero-config runs — the runtime itself
 * always demands an explicit config and exits loudly without one.
 *
 * @module @openma/deepseek-harness-sdk/runtime
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RuntimeResolutionError } from './errors.js'

/** npm package expected to carry the runtime bin. */
export const RUNTIME_PACKAGE = '@deepseek-ai/dsh-sdk-jsonrpc-demo'
/** The runtime bin name inside {@link RUNTIME_PACKAGE}. */
export const RUNTIME_BIN_NAME = 'dsh-jsonrpc-agent'
/** Environment variable naming an explicit runtime executable. */
export const RUNTIME_BIN_ENV_VAR = 'DSH_RUNTIME_BIN'

/** A resolved default launch: argv plus an optional bundled default config. */
export interface ResolvedLaunch {
  /** The executable to spawn. */
  command: string
  /** Arguments passed to {@link command}. */
  args: string[]
  /**
   * A default Cordis composition shipped next to the resolved runtime, when
   * one exists. Injected as `DSH_CORDIS_CONFIG` only when the caller set no
   * non-empty config of their own.
   */
  defaultConfigPath?: string
}

/**
 * Resolve the argv for a default runtime launch.
 * @param env - environment consulted for {@link RUNTIME_BIN_ENV_VAR}
 * (defaults to `process.env`).
 * @param resolveBase - extra directory to resolve {@link RUNTIME_PACKAGE}
 * from, tried before the process cwd (a test/embedding seam).
 * @returns the launch argv and any bundled default config.
 * @throws {@link RuntimeResolutionError} when no runtime can be located; the
 * message names every acquisition route.
 */
export function resolveDefaultLaunch(env: NodeJS.ProcessEnv = process.env, resolveBase?: string): ResolvedLaunch {
  const explicit = env[RUNTIME_BIN_ENV_VAR]
  if (explicit !== undefined && explicit !== '') return { command: explicit, args: [] }

  const packageJsonPath = resolveRuntimePackageJson(resolveBase)
  if (packageJsonPath === undefined) {
    throw new RuntimeResolutionError(
      'Unable to locate a DeepSeek Harness SDK runtime. Provide one of: '
      + '`runtimeBin`/`launchArgsOverride` (or `command` on HarnessClient), '
      + `the ${RUNTIME_BIN_ENV_VAR} environment variable, `
      + `or an installed \`${RUNTIME_PACKAGE}\` package (ships the \`${RUNTIME_BIN_NAME}\` bin; `
      + 'pass its Cordis composition via the `cordis` option or `DSH_CORDIS_CONFIG`).',
    )
  }
  const packageDir = dirname(packageJsonPath)
  const binRelative = runtimeBinEntry(packageJsonPath)
  const binPath = join(packageDir, binRelative)
  if (!existsSync(binPath)) {
    throw new RuntimeResolutionError(
      `${RUNTIME_PACKAGE} is installed but its ${RUNTIME_BIN_NAME} bin is missing at ${binPath}; reinstall the package.`,
    )
  }
  const launch: ResolvedLaunch = { command: process.execPath, args: [binPath] }
  for (const candidate of ['runtime/cordis.yml', 'cordis.yml']) {
    const configPath = join(packageDir, candidate)
    if (existsSync(configPath)) return { ...launch, defaultConfigPath: configPath }
  }
  return launch
}

/** Read the runtime bin path out of the resolved package manifest. */
function runtimeBinEntry(packageJsonPath: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    throw new RuntimeResolutionError(
      `${RUNTIME_PACKAGE} has an unreadable package.json at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const bin = (manifest as { bin?: unknown } | null)?.bin
  const entry = bin !== null && typeof bin === 'object' ? (bin as Record<string, unknown>)[RUNTIME_BIN_NAME] : undefined
  if (typeof entry !== 'string' || entry === '') {
    throw new RuntimeResolutionError(
      `${RUNTIME_PACKAGE} declares no ${RUNTIME_BIN_NAME} bin in ${packageJsonPath}; install a version that ships the runtime bin.`,
    )
  }
  return entry
}

/**
 * Locate the runtime package's manifest from the caller-supplied base, the
 * process cwd, and this module's own location, in that order.
 */
function resolveRuntimePackageJson(resolveBase?: string): string | undefined {
  const bases: string[] = []
  if (resolveBase !== undefined) bases.push(pathToFileURL(join(resolveBase, 'noop.js')).href)
  bases.push(pathToFileURL(join(process.cwd(), 'noop.js')).href, import.meta.url)
  for (const base of bases) {
    try {
      return createRequire(base).resolve(`${RUNTIME_PACKAGE}/package.json`)
    } catch {
      continue
    }
  }
  return undefined
}

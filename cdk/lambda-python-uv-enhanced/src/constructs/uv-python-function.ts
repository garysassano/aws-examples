import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Architecture,
  Code,
  type FunctionOptions,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { type BundlingOptions, DockerImage, type ILocalBundling } from "aws-cdk-lib/core";
import type { Construct } from "constructs";

// Matches the uv version mise installs, so both bundling paths install with the same uv.
const DEFAULT_UV_VERSION = "0.13.0";

// Lambda's Python 3.12+ runtimes run on Amazon Linux 2023, which ships glibc 2.34.
const MANYLINUX = "manylinux_2_34";

// Lambda's code directories are read-only and CDK zips every file with the same fixed mtime, so
// timestamp-based pycs never match their source there. Hash-based pycs skip that check.
const PYC_INVALIDATION_MODE = "UNCHECKED_HASH";

const SOURCE_EXCLUDES = [".venv", "**/__pycache__", ".ruff_cache", ".pytest_cache", "tests"];

export interface UvPythonFunctionProps extends FunctionOptions {
  /** Directory of the uv project or workspace root, holding `pyproject.toml` and `uv.lock`. */
  readonly entry: string;
  /** Handler in `module.function` form, importable from the installed project. */
  readonly handler: string;
  /** @default Runtime.PYTHON_3_14 */
  readonly runtime?: Runtime;
  /** @default Architecture.ARM_64 */
  readonly architecture?: Architecture;
  /** @default true */
  readonly compileBytecode?: boolean;
  /** uv version for the Docker fallback, used when uv is not on the PATH. */
  readonly uvVersion?: string;
}

/**
 * A Python function built from a uv project.
 *
 * The project, its workspace members and their third-party dependencies go into one zip, like the
 * official construct's. uv cross-installs wheels for the function's runtime and architecture, so
 * the host's CPU does not matter.
 */
export class UvPythonFunction extends LambdaFunction {
  constructor(scope: Construct, id: string, props: UvPythonFunctionProps) {
    const {
      entry,
      compileBytecode = true,
      uvVersion = DEFAULT_UV_VERSION,
      runtime = Runtime.PYTHON_3_14,
      architecture = Architecture.ARM_64,
      ...functionProps
    } = props;
    if (runtime.family !== RuntimeFamily.PYTHON) {
      throw new Error(`UvPythonFunction needs a Python runtime, got ${runtime.name}`);
    }
    const target: Target = {
      python: runtime.name.replace(/^python/, ""),
      platform: `${architecture === Architecture.ARM_64 ? "aarch64" : "x86_64"}-${MANYLINUX}`,
      compileBytecode,
      uvVersion,
    };

    super(scope, id, {
      ...functionProps,
      runtime,
      architecture,
      code: Code.fromAsset(entry, {
        exclude: SOURCE_EXCLUDES,
        bundling: bundling(entry, target),
      }),
    });
  }
}

interface Target {
  readonly python: string;
  readonly platform: string;
  readonly compileBytecode: boolean;
  readonly uvVersion: string;
}

/**
 * The uv commands that fill the asset, run from the project directory.
 *
 * `uv export --locked` fails when `uv.lock` no longer matches `pyproject.toml`, rather than
 * silently resolving again. Dependencies are wheels only and hash-checked against the lockfile;
 * the project's own packages are built from source, which is pure Python, and installed next to
 * them. uv reuses a local package's cached build until its `pyproject.toml` changes, so
 * `--refresh` rebuilds them from the current source.
 */
function commands(target: Target, outputDir: string, tmpDir: string): string[][] {
  const dependencies = `${tmpDir}/requirements-dependencies.txt`;
  const project = `${tmpDir}/requirements-project.txt`;
  const install = (requirements: string) => [
    "uv",
    "pip",
    "install",
    "--requirements",
    requirements,
    "--python",
    target.python,
    "--python-platform",
    target.platform,
    "--no-installer-metadata",
    "--link-mode",
    "copy",
    ...(target.compileBytecode ? ["--compile-bytecode"] : ["--no-compile-bytecode"]),
    "--target",
    outputDir,
  ];
  // Without --python, uv export picks the newest Python that requires-python allows, downloading it
  // when there is no project environment, as in the Docker fallback.
  const exportBase = [
    "uv",
    "export",
    "--locked",
    "--no-dev",
    "--no-editable",
    "--python",
    target.python,
  ];
  return [
    [...exportBase, "--no-emit-local", "--output-file", dependencies],
    [...install(dependencies), "--no-build", "--require-hashes"],
    [...exportBase, "--only-emit-local", "--no-hashes", "--output-file", project],
    [...install(project), "--no-deps", "--refresh"],
  ];
}

function environment(target: Target): Record<string, string> {
  return target.compileBytecode ? { PYC_INVALIDATION_MODE } : {};
}

function bundling(entry: string, target: Target): BundlingOptions {
  const env = environment(target);
  const local: ILocalBundling = {
    tryBundle(outputDir) {
      if (spawnSync("uv", ["--version"]).status !== 0) return false;
      const tmpDir = mkdtempSync(join(tmpdir(), "uv-python-function-"));
      try {
        for (const [command, ...args] of commands(target, outputDir, tmpDir)) {
          const result = spawnSync(command as string, args, {
            cwd: entry,
            env: { ...process.env, ...env },
            stdio: ["ignore", process.stderr, "inherit"],
          });
          if (result.status !== 0) {
            throw new Error(
              `${command} ${args.slice(0, 2).join(" ")} exited with ${result.status}`,
            );
          }
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      return true;
    },
  };
  return {
    local,
    // The plain uv image, without a system Python: uv downloads a managed CPython for the runtime,
    // also for versions not yet on Docker Hub. Its patch release can differ from the host's, but
    // both share the minor version's bytecode magic number, so Lambda loads the pycs from either.
    image: DockerImage.fromRegistry(`ghcr.io/astral-sh/uv:${target.uvVersion}-trixie-slim`),
    command: [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      commands(target, "/asset-output", "/tmp")
        .map((args) => args.map(shellQuote).join(" "))
        .join(" && "),
    ],
    // CDK runs the container as the host user, whose home directory is not writable there, so uv
    // keeps its cache and the Python it downloads under /tmp.
    environment: { ...env, UV_CACHE_DIR: "/tmp/uv-cache", UV_PYTHON_INSTALL_DIR: "/tmp/uv-python" },
  };
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

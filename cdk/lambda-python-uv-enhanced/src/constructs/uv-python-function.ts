import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Architecture,
  Code,
  type FunctionOptions,
  Function as LambdaFunction,
  LayerVersion,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import {
  AssetHashType,
  type BundlingOptions,
  DockerImage,
  type ILocalBundling,
} from "aws-cdk-lib/core";
import type { Construct } from "constructs";

// Matches the uv version mise installs for local bundling, so both paths build the same output.
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
 * Third-party dependencies go into a layer whose asset hash comes from `uv.lock` alone, and the
 * project with its workspace members goes into the function's own code. uv cross-installs wheels
 * for the function's runtime and architecture, so the host's CPU does not matter.
 */
export class UvPythonFunction extends LambdaFunction {
  public readonly dependenciesLayer: LayerVersion;

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
        bundling: bundling(entry, target, "project"),
      }),
    });

    this.dependenciesLayer = new LayerVersion(this, "Dependencies", {
      code: Code.fromAsset(entry, {
        // Only the lockfile and the target decide which wheels get installed.
        assetHashType: AssetHashType.CUSTOM,
        assetHash: hash(readFileSync(join(entry, "uv.lock")), JSON.stringify(target)),
        bundling: bundling(entry, target, "dependencies"),
      }),
      compatibleRuntimes: [runtime],
      compatibleArchitectures: [architecture],
      description: `Third-party dependencies of ${this.node.path}`,
    });
    this.addLayers(this.dependenciesLayer);
  }
}

interface Target {
  readonly python: string;
  readonly platform: string;
  readonly compileBytecode: boolean;
  readonly uvVersion: string;
}

type Part = "dependencies" | "project";

function hash(...parts: (string | Buffer)[]): string {
  const sha = createHash("sha256");
  for (const part of parts) sha.update(part);
  return sha.digest("hex");
}

/**
 * The uv commands that fill one asset, run from the project directory.
 *
 * `uv export --locked` fails when `uv.lock` no longer matches `pyproject.toml`, rather than
 * silently resolving again. Dependencies are wheels only and hash-checked against the lockfile;
 * the project's own packages are built from source, which is pure Python.
 */
function commands(target: Target, part: Part, outputDir: string, tmpDir: string): string[][] {
  const requirements = `${tmpDir}/requirements-${part}.txt`;
  const install = [
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
  ];
  const exportBase = ["uv", "export", "--locked", "--no-dev", "--no-editable"];
  if (part === "dependencies") {
    return [
      [...exportBase, "--no-emit-local", "--output-file", requirements],
      // Lambda adds /opt/python, the layer's python directory, to sys.path.
      [...install, "--target", `${outputDir}/python`, "--no-build", "--require-hashes"],
    ];
  }
  return [
    [...exportBase, "--only-emit-local", "--no-hashes", "--output-file", requirements],
    [...install, "--target", outputDir, "--no-deps"],
  ];
}

function environment(target: Target): Record<string, string> {
  return target.compileBytecode ? { PYC_INVALIDATION_MODE } : {};
}

function bundling(entry: string, target: Target, part: Part): BundlingOptions {
  const env = environment(target);
  const local: ILocalBundling = {
    tryBundle(outputDir) {
      if (spawnSync("uv", ["--version"]).status !== 0) return false;
      const tmpDir = mkdtempSync(join(tmpdir(), "uv-python-function-"));
      try {
        for (const [command, ...args] of commands(target, part, outputDir, tmpDir)) {
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
    image: DockerImage.fromRegistry(
      `ghcr.io/astral-sh/uv:${target.uvVersion}-python${target.python}-trixie-slim`,
    ),
    command: [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      commands(target, part, "/asset-output", "/tmp")
        .map((args) => args.map(shellQuote).join(" "))
        .join(" && "),
    ],
    environment: { ...env, UV_CACHE_DIR: "/tmp/uv-cache", UV_PYTHON_DOWNLOADS: "never" },
  };
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

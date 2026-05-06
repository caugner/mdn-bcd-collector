//
// mdn-bcd-collector: scripts/update-bcd-runtime.ts
// Generate runtime-compat reports for two Node.js versions via nvm,
// then merge them into the local browser-compat-data checkout.
//
// See the LICENSE file for copyright details
//

import path from "node:path";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import fs from "fs-extra";

import chalk from "chalk-template";
import esMain from "es-main";
import yargs from "yargs";
import {hideBin} from "yargs/helpers";

const execFileP = promisify(execFile);

const RUNTIME_DATA_DELIMITER = "RUNTIME_DATA_START";

interface Options {
  runtimeCompat: string;
  from: string;
  to: string;
  outputDir: string;
  skipUpdate: boolean;
}

/**
 * Run a command under a specific Node.js version managed by nvm.
 * @param version - The nvm version specifier (e.g. "25", "26.0.0", "lts/jod").
 * @param cmd - The shell command to run after `nvm use`.
 * @param cwd - Working directory for the command.
 * @returns stdout from the command (nvm's own output is redirected to stderr).
 */
const runUnderNvm = async (
  version: string,
  cmd: string,
  cwd: string,
): Promise<string> => {
  // nvm is a shell function, so it must be sourced inside the subshell.
  const script = `
    set -e
    export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
      echo "nvm not found at $NVM_DIR/nvm.sh — set NVM_DIR or install nvm" >&2
      exit 1
    fi
    . "$NVM_DIR/nvm.sh"
    nvm install "${version}" >&2
    nvm use "${version}" >&2
    ${cmd}
  `;
  const {stdout} = await execFileP("bash", ["-c", script], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Extract the JSON payload that runtime-compat's run.ts emits after the
 * RUNTIME_DATA_START marker (mirrors generator/scripts/strip-delimiters.sh).
 */
const stripDelimiters = (raw: string): string => {
  const idx = raw.indexOf(RUNTIME_DATA_DELIMITER);
  if (idx < 0) {
    throw new Error(
      `Missing ${RUNTIME_DATA_DELIMITER} marker in runtime-compat output`,
    );
  }
  return raw.slice(idx + RUNTIME_DATA_DELIMITER.length).trim();
};

const buildRuntimeCompat = async (runtimeCompat: string) => {
  const nodeRuntimeDir = path.join(
    runtimeCompat,
    "generator",
    "runtimes",
    "node",
  );
  console.log(
    chalk`{cyan Installing runtime-compat dependencies (node-runtime only)...}`,
  );
  // Workspace contains 12 projects (Bun, workerd, Fastly, Wasmer, ...).
  // We only need the node runtime, so filter to skip ~1500 unrelated packages.
  await spawnInherit(
    "pnpm",
    ["install", "--filter", "node-runtime..."],
    runtimeCompat,
  );
  console.log(chalk`{cyan Building runtime-compat node generator...}`);
  await spawnInherit("pnpm", ["run", "build"], nodeRuntimeDir);
};

const spawnInherit = (cmd: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, stdio: "inherit"});
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`${cmd} ${args.join(" ")} exited with code ${code}`),
          ),
    );
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" && cmd === "pnpm") {
        reject(
          new Error(
            "pnpm not found in PATH. Run `corepack enable` (or install pnpm) before re-running.",
          ),
        );
        return;
      }
      reject(err);
    });
  });

const generateReport = async (
  runtimeCompat: string,
  version: string,
  outputDir: string,
): Promise<string> => {
  const nodeRuntimeDir = path.join(
    runtimeCompat,
    "generator",
    "runtimes",
    "node",
  );
  console.log(
    chalk`{cyan Running runtime-compat under Node {bold ${version}}...}`,
  );
  const raw = await runUnderNvm(version, "node dist/run.mjs", nodeRuntimeDir);
  const data = JSON.parse(stripDelimiters(raw));
  const reportPath = path.join(outputDir, `node-${version}.json`);
  await fs.writeFile(reportPath, JSON.stringify(data, null, 2) + "\n");
  console.log(chalk`{green Wrote ${reportPath}}`);
  return reportPath;
};

const runUpdateBcd = async (reportPaths: string[]) => {
  console.log(
    chalk`{cyan Running update-bcd against ${String(reportPaths.length)} report(s)...}`,
  );
  await spawnInherit(
    "npm",
    ["run", "update-bcd", "--", ...reportPaths],
    process.cwd(),
  );
};

const main = async (opts: Options) => {
  const nodeRuntimeDir = path.join(
    opts.runtimeCompat,
    "generator",
    "runtimes",
    "node",
  );
  if (!(await fs.pathExists(nodeRuntimeDir))) {
    throw new Error(
      `Could not find ${nodeRuntimeDir}. ` +
        `Pass --runtime-compat with the path to a unjs/runtime-compat checkout.`,
    );
  }

  await fs.mkdirp(opts.outputDir);
  await buildRuntimeCompat(opts.runtimeCompat);

  const fromPath = await generateReport(
    opts.runtimeCompat,
    opts.from,
    opts.outputDir,
  );
  const toPath = await generateReport(
    opts.runtimeCompat,
    opts.to,
    opts.outputDir,
  );

  if (opts.skipUpdate) {
    console.log(
      chalk`{yellow Skipping update-bcd. Reports written to ${opts.outputDir}.}`,
    );
    return;
  }

  await runUpdateBcd([fromPath, toPath]);
};

/* c8 ignore start */
if (esMain(import.meta)) {
  const {argv}: {argv: any} = yargs(hideBin(process.argv))
    .usage(
      "$0 --runtime-compat <path> --from <version> --to <version>\n\n" +
        "Generate runtime-compat reports for two Node.js versions via nvm and update BCD.",
    )
    .option("runtime-compat", {
      describe: "Path to a unjs/runtime-compat checkout",
      type: "string",
      demandOption: true,
    })
    .option("from", {
      describe: "Baseline Node.js version (nvm specifier, e.g. 25, 25.5.0)",
      type: "string",
      demandOption: true,
    })
    .option("to", {
      describe: "New Node.js version (nvm specifier, e.g. 26, 26.0.0)",
      type: "string",
      demandOption: true,
    })
    .option("output-dir", {
      describe: "Where to write the generated runtime-compat data.json files",
      type: "string",
      default: "./generated/runtime-compat",
    })
    .option("skip-update", {
      describe: "Generate the reports but do not run update-bcd",
      type: "boolean",
      default: false,
    });

  await main({
    runtimeCompat: path.resolve(argv.runtimeCompat as string),
    from: argv.from as string,
    to: argv.to as string,
    outputDir: path.resolve(argv.outputDir as string),
    skipUpdate: argv.skipUpdate as boolean,
  });
}
/* c8 ignore stop */

export default main;

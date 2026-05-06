//
// mdn-bcd-collector: scripts/update-bcd-runtime.ts
// Generate runtime-compat reports for two Node.js versions via nvm,
// then merge them into the local browser-compat-data checkout.
//
// See the LICENSE file for copyright details
//

import os from "node:os";
import path from "node:path";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import fs from "fs-extra";

import chalk from "chalk-template";
import {
  compare as compareVersions,
  compareVersions as compareVersionsSort,
} from "compare-versions";
import esMain from "es-main";
import {Octokit} from "@octokit/rest";
import yargs from "yargs";
import {hideBin} from "yargs/helpers";

import {getBCDDir} from "../lib/constants.js";

const execFileP = promisify(execFile);

const RUNTIME_DATA_DELIMITER = "RUNTIME_DATA_START";
const FEATURE_RELEASE_TAG = /^v(\d+\.\d+\.0)$/;

interface Options {
  runtimeCompat: string;
  from: string;
  to: string;
  outputDir: string;
  skipExisting: boolean;
  skipUpdate: boolean;
  concurrency: number;
}

/**
 * Run an async task over each item with at most `limit` in flight.
 * Workers share a single iterator, so each one pulls the next pending item
 * as it finishes — no synchronization needed beyond JS's single-threaded
 * execution between awaits. Results preserve input order.
 */
const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  const queue = items.entries();
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({length: workerCount}, async () => {
      for (const [i, item] of queue) {
        results[i] = await task(item);
      }
    }),
  );
  return results;
};

/**
 * List Node.js feature releases (X.Y.0) between two versions inclusive,
 * sorted ascending. Hits the public GitHub API; honors GITHUB_TOKEN for
 * higher rate limits if set.
 */
const enumerateFeatureReleases = async (
  octokit: Octokit,
  from: string,
  to: string,
): Promise<string[]> => {
  if (compareVersions(from, to, ">")) {
    throw new Error(`--from (${from}) must be <= --to (${to})`);
  }
  const releases = await octokit.paginate(octokit.repos.listReleases, {
    owner: "nodejs",
    repo: "node",
    per_page: 100,
  });
  const versions = releases
    .map((r) => r.tag_name.match(FEATURE_RELEASE_TAG)?.[1])
    .filter((v): v is string => Boolean(v))
    .filter(
      (v) =>
        compareVersions(v, from, ">=") && compareVersions(v, to, "<="),
    )
    .sort(compareVersionsSort);
  if (versions.length === 0) {
    throw new Error(
      `No Node.js feature releases found between ${from} and ${to}`,
    );
  }
  return versions;
};

interface NodeReleaseMeta {
  release_date: string;
  release_notes: string;
  status: string;
  engine: string;
  engine_version: string;
}

/**
 * Add any of `versions` that are missing from BCD's browsers/nodejs.json.
 * Release date and V8 version are pulled from GitHub release metadata; if a
 * release body doesn't mention V8, the engine version is inherited from the
 * highest existing release below the new one (V8 majors are stable within
 * a Node major). After insertion, the highest release across the whole map
 * is marked "current" and any other "current" entries are demoted.
 */
const ensureBcdReleases = async (
  octokit: Octokit,
  bcdDir: string,
  versions: string[],
): Promise<void> => {
  const filePath = path.join(bcdDir, "browsers", "nodejs.json");
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  const releases = data.browsers.nodejs.releases as Record<
    string,
    NodeReleaseMeta
  >;

  const missing = versions.filter((v) => !releases[v]);
  if (missing.length === 0) {
    console.log(
      chalk`{gray All ${String(versions.length)} release(s) already in BCD.}`,
    );
    return;
  }

  console.log(
    chalk`{cyan Adding ${String(missing.length)} missing release(s) to BCD: ${missing.join(", ")}}`,
  );

  for (const v of missing) {
    const {data: release} = await octokit.repos.getReleaseByTag({
      owner: "nodejs",
      repo: "node",
      tag: `v${v}`,
    });
    const body = release.body ?? "";
    const v8Match = body.match(/V8 (\d+\.\d+)/);
    const engineVersion = v8Match
      ? v8Match[1]
      : inheritEngineVersion(releases, v);
    if (!release.published_at) {
      throw new Error(`Release v${v} has no published_at on GitHub`);
    }
    releases[v] = {
      release_date: release.published_at.slice(0, 10),
      release_notes: `https://nodejs.org/en/blog/release/v${v}`,
      status: "retired",
      engine: "V8",
      engine_version: engineVersion,
    };
  }

  // Re-sort the releases map by semver so the file stays canonically ordered.
  data.browsers.nodejs.releases = Object.fromEntries(
    Object.entries(releases).sort(([a], [b]) => compareVersionsSort(a, b)),
  );

  // Highest version overall is "current"; demote any other "current" entries.
  const sortedVersions = Object.keys(data.browsers.nodejs.releases);
  const highest = sortedVersions[sortedVersions.length - 1];
  for (const [v, meta] of Object.entries(
    data.browsers.nodejs.releases as Record<string, NodeReleaseMeta>,
  )) {
    if (v === highest) {
      meta.status = "current";
    } else if (meta.status === "current") {
      meta.status = "retired";
    }
  }

  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(chalk`{green Wrote ${filePath}}`);
};

const inheritEngineVersion = (
  releases: Record<string, NodeReleaseMeta>,
  version: string,
): string => {
  const lower = Object.keys(releases)
    .filter((v) => compareVersions(v, version, "<"))
    .sort(compareVersionsSort);
  if (lower.length === 0) {
    throw new Error(
      `Cannot determine engine_version for ${version}: release notes did not mention V8 and no prior release exists in BCD to inherit from`,
    );
  }
  return releases[lower[lower.length - 1]].engine_version;
};

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

  const octokit = new Octokit({auth: process.env.GITHUB_TOKEN});
  const versions = await enumerateFeatureReleases(
    octokit,
    opts.from,
    opts.to,
  );
  console.log(
    chalk`{cyan Found ${String(versions.length)} feature release(s) in [${opts.from}, ${opts.to}]: ${versions.join(", ")}}`,
  );

  await ensureBcdReleases(octokit, getBCDDir(), versions);

  const reportPaths: string[] = [];
  const toGenerate: string[] = [];
  for (const version of versions) {
    const reportPath = path.join(opts.outputDir, `node-${version}.json`);
    if (opts.skipExisting && (await fs.pathExists(reportPath))) {
      console.log(
        chalk`{gray Reusing existing report for ${version}: ${reportPath}}`,
      );
      reportPaths.push(reportPath);
    } else {
      toGenerate.push(version);
    }
  }

  if (toGenerate.length > 0) {
    await buildRuntimeCompat(opts.runtimeCompat);
    console.log(
      chalk`{cyan Generating ${String(toGenerate.length)} report(s) with concurrency ${String(opts.concurrency)}...}`,
    );
    const generated = await runWithConcurrency(
      toGenerate,
      opts.concurrency,
      (version) =>
        generateReport(opts.runtimeCompat, version, opts.outputDir),
    );
    reportPaths.push(...generated);
  }

  if (opts.skipUpdate) {
    console.log(
      chalk`{yellow Skipping update-bcd. Reports written to ${opts.outputDir}.}`,
    );
    return;
  }

  await runUpdateBcd(reportPaths);
};

/* c8 ignore start */
if (esMain(import.meta)) {
  const {argv}: {argv: any} = yargs(hideBin(process.argv))
    .usage(
      "$0 --runtime-compat <path> --from <version> --to <version>\n\n" +
        "Generate runtime-compat reports for every Node.js feature release " +
        "(X.Y.0) between --from and --to (inclusive) and update BCD. Releases " +
        "are discovered via the GitHub API.",
    )
    .option("runtime-compat", {
      describe: "Path to a unjs/runtime-compat checkout",
      type: "string",
      demandOption: true,
    })
    .option("from", {
      describe:
        "Lowest Node.js feature release to include (e.g. 25.0.0). " +
        "Pass the highest version BCD already has data for so update-bcd can " +
        "pinpoint version_added.",
      type: "string",
      demandOption: true,
    })
    .option("to", {
      describe: "Highest Node.js feature release to include (e.g. 26.0.0)",
      type: "string",
      demandOption: true,
    })
    .option("output-dir", {
      describe: "Where to write the generated runtime-compat data.json files",
      type: "string",
      default: "./generated/runtime-compat",
    })
    .option("skip-existing", {
      describe: "Reuse reports already present in --output-dir",
      type: "boolean",
      default: false,
    })
    .option("concurrency", {
      describe: "Number of runtime-compat runs to execute in parallel",
      type: "number",
      default: os.cpus().length,
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
    skipExisting: argv.skipExisting as boolean,
    skipUpdate: argv.skipUpdate as boolean,
    concurrency: argv.concurrency as number,
  });
}
/* c8 ignore stop */

export default main;

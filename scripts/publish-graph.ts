import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { PACKAGES, PUBLISHER_HOST, TTL, type GraphPackage } from "./graph.config.ts";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

type Manifest = {
  name?: string;
  [section: string]: string | Record<string, string> | undefined;
};

type PackedPackage = GraphPackage & {
  tarball: string;
  size: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`Command failed in ${cwd}: ${command.join(" ")}`);
  }
  return result.stdout.toString().trim();
}

function checkoutStatus(checkout: string): string {
  return run(
    ["git", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
    checkout,
  );
}

function graphUrl(name: string, sha: string, parent?: string): string {
  const url = `https://${PUBLISHER_HOST}/${name}/${sha}`;
  // Bun 1.3.14 repro: add the published AWS + Core URLs together, then Alchemy.
  // error: @distilled.cloud/core@https://pkg-pkgworker-prod-3h2ug3xkdl7e2fr4.patrikduksin.workers.dev/@distilled.cloud/core/7125b54be7eb9ab0f54a0480839c0e5c8c0a7d3d failed to resolve
  // error: @distilled.cloud/cloudflare-rolldown-plugin@https://pkg-pkgworker-prod-3h2ug3xkdl7e2fr4.patrikduksin.workers.dev/@distilled.cloud/cloudflare-rolldown-plugin/7125b54be7eb9ab0f54a0480839c0e5c8c0a7d3d failed to resolve
  const needsIdentity =
    parent !== undefined &&
    ((name === "@distilled.cloud/core" && parent !== "alchemy") ||
      (name === "@distilled.cloud/cloudflare-rolldown-plugin" &&
        parent === "@distilled.cloud/cloudflare-vite-plugin"));
  return needsIdentity ? `${url}?from=${encodeURIComponent(parent)}` : url;
}

async function rewriteManifest(path: string, sha: string): Promise<Map<string, string>> {
  const manifest = JSON.parse(await readFile(path, "utf8")) as Manifest;
  const configured = new Set(PACKAGES.map(({ name }) => name));
  const rewritten = new Map<string, string>();
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies === "string") continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (configured.has(name) && value.startsWith("workspace:")) {
        const url = graphUrl(name, sha, manifest.name);
        dependencies[name] = url;
        rewritten.set(name, url);
      }
    }
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return rewritten;
}

function packedManifest(tarball: string, cwd: string): Manifest {
  return JSON.parse(run(["tar", "-xOf", tarball, "package/package.json"], cwd)) as Manifest;
}

function validateManifest(
  pkg: GraphPackage,
  manifest: Manifest,
  rewritten: Map<string, string>,
): void {
  const configured = new Set(PACKAGES.map(({ name }) => name));
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = manifest[section];
    if (!dependencies || typeof dependencies === "string") continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (!configured.has(name)) continue;
      if (value.startsWith("workspace:")) {
        fail(`${pkg.name}: packed ${section}.${name} still uses ${value}`);
      }
      if (rewritten.has(name) && value !== rewritten.get(name)) {
        fail(`${pkg.name}: packed ${section}.${name} is not the same-SHA URL`);
      }
    }
  }
}

async function upload(pkg: PackedPackage, sha: string, token: string): Promise<void> {
  const project = pkg.name.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`https://${PUBLISHER_HOST}/projects/${project}/packages`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/gzip",
      "Content-Length": String(pkg.size),
      "X-Tags": JSON.stringify([sha]),
      "X-TTL": TTL,
    },
    body: Bun.file(pkg.tarball),
  });
  if (!response.ok) {
    fail(
      `Upload failed for ${pkg.name} (${response.status} ${response.statusText}): ${await response.text()}`,
    );
  }
  console.log(`${pkg.name} ${pkg.size} bytes`);
}

if (process.argv.length > 3) {
  fail("Usage: bun run publish-graph [alchemy-checkout]");
}

const checkout = resolve(process.argv[2] ?? "../alchemy");
const initialStatus = checkoutStatus(checkout);
if (initialStatus) fail(`Alchemy checkout is dirty:\n${initialStatus}`);
const sha = run(["git", "rev-parse", "HEAD"], checkout);
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`Expected a full git SHA, got ${sha}`);

for (const pkg of PACKAGES) {
  const manifestPath = join(checkout, pkg.path, "package.json");
  if (!(await Bun.file(manifestPath).exists())) {
    fail(`${pkg.name}: package is missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (manifest.name !== pkg.name) {
    fail(`${pkg.path}: expected package ${pkg.name}, found ${manifest.name ?? "none"}`);
  }
}

const token = (await readFile(resolve(".auth-token"), "utf8")).trim();
if (!token) fail(".auth-token is empty; run bun run token first");

for (const pkg of PACKAGES) {
  run(["bun", "run", "build"], join(checkout, pkg.path));
}

const staging = await mkdtemp(join(tmpdir(), "alchemy-package-graph-"));
await cp(join(checkout, "package.json"), join(staging, "package.json"));
await cp(join(checkout, "bun.lock"), join(staging, "bun.lock"));
const rootManifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as {
  workspaces: { packages: string[] };
};
for (const pattern of rootManifest.workspaces.packages) {
  for await (const manifest of new Bun.Glob(`${pattern}/package.json`).scan({
    cwd: checkout,
    onlyFiles: true,
  })) {
    await mkdir(dirname(join(staging, manifest)), { recursive: true });
    await cp(join(checkout, manifest), join(staging, manifest));
  }
}
for (const workspace of ["distilled", "cloudflare-tools"]) {
  await mkdir(join(staging, workspace), { recursive: true });
  await cp(join(checkout, workspace, "package.json"), join(staging, workspace, "package.json"));
  await cp(join(checkout, workspace, "bun.lock"), join(staging, workspace, "bun.lock"));
}

const packed: PackedPackage[] = [];
for (const pkg of PACKAGES) {
  const source = join(checkout, pkg.path);
  const staged = join(staging, pkg.path);
  await mkdir(dirname(staged), { recursive: true });
  await cp(source, staged, {
    recursive: true,
    filter: (path) => basename(path) !== "node_modules" && !path.endsWith(".tgz"),
  });
  const rewritten = await rewriteManifest(join(staged, "package.json"), sha);

  const readme = resolve(source, "../../README.md");
  if (await Bun.file(readme).exists()) await cp(readme, join(staged, "README.md"));

  const tarballDir = join(staging, "tarballs", String(packed.length));
  await mkdir(tarballDir, { recursive: true });
  run(["bun", "pm", "pack", "--destination", tarballDir], staged);
  const tarballs = (await readdir(tarballDir)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`${pkg.name}: expected one tarball, found ${tarballs.length}`);
  }
  const tarball = join(tarballDir, tarballs[0]!);
  const size = (await stat(tarball)).size;
  if (size < 1024) fail(`${pkg.name}: tarball is unexpectedly small (${size} bytes)`);
  validateManifest(pkg, packedManifest(tarball, staging), rewritten);
  packed.push({ ...pkg, tarball, size });
}

const finalStatus = checkoutStatus(checkout);
if (finalStatus) fail(`Packaging mutated the Alchemy checkout:\n${finalStatus}`);

for (const pkg of packed.slice(0, -1)) await upload(pkg, sha, token);
await upload(packed.at(-1)!, sha, token);

const completedStatus = checkoutStatus(checkout);
if (completedStatus) fail(`Publishing mutated the Alchemy checkout:\n${completedStatus}`);

console.log(`Published ${packed.length} packages at ${sha}`);
console.log(`bun add alchemy@https://${PUBLISHER_HOST}/alchemy/${sha}`);

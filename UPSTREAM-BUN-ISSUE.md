# `bun install` fails when an identical HTTP tarball URL is discovered directly and transitively

## Environment

| Bun build | Platform | Zero-latency result | 50 ms leaf latency |
| --- | --- | --- | --- |
| `1.3.14+0d9b296af` (latest stable) | macOS 15.7.7 arm64 | Fails 3/3 | Passes 3/3 |
| `1.4.0-canary.1+6b6fb1a33` | macOS 15.7.7 arm64 | Fails 3/3 | Passes 3/3 |

## Description

When the root package and one of its HTTP-tarball dependencies refer to the same leaf package using the exact same URL, `bun install` can leave the later occurrence unresolved:

```text
error: leaf@http://127.0.0.1:<port>/leaf/research-local failed to resolve
```

The failure is timing-dependent. With a 24 MiB parent tarball and a 189 KiB leaf tarball served immediately from localhost, the reproduction below fails every run. Adding 50 ms of latency only to the leaf response makes the same graph and URLs pass every run.

## Reproduction

Save the following as `repro.ts` and run `bun repro.ts`. It has no npm dependencies and cleans up its temporary files. Set `BUN_BIN` to test a different Bun executable while using any Bun installation to run the fixture server:

```sh
BUN_BIN=/path/to/bun bun repro.ts
```

```ts
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "bun-url-race-"));
const bun = process.env.BUN_BIN || process.execPath;
const tarballs = new Map<string, { file: string; leaf: boolean }>();
let leafDelayMs = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/parent/research-local") {
      return Response.redirect(new URL("/projects/parent/packages/1", server.url), 301);
    }
    if (pathname === "/leaf/research-local") {
      return Response.redirect(new URL("/projects/leaf/packages/1", server.url), 301);
    }
    const artifact = tarballs.get(pathname);
    if (!artifact) return new Response("not found", { status: 404 });
    if (artifact.leaf && leafDelayMs) await Bun.sleep(leafDelayMs);
    return new Response(Bun.file(artifact.file), {
      headers: { "Content-Type": "application/gzip" },
    });
  },
});

const origin = server.url.href.replace(/\/$/, "");
const parentUrl = `${origin}/parent/research-local`;
const leafUrl = `${origin}/leaf/research-local`;

async function pack(
  directory: string,
  manifest: Record<string, unknown>,
  paddingBytes: number,
) {
  const packageDir = join(directory, "package");
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageDir, "index.js"), "export default true;\n");
  if (paddingBytes) {
    await writeFile(join(packageDir, "padding.bin"), randomBytes(paddingBytes));
  }
  const output = `${directory}.tgz`;
  const packed = Bun.spawnSync(["tar", "-czf", output, "-C", directory, "package"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  return output;
}

const leafTarball = await pack(
  join(root, "leaf"),
  { name: "leaf", version: "1.0.0" },
  189 * 1024,
);
const parentTarball = await pack(
  join(root, "parent"),
  { name: "parent", version: "1.0.0", dependencies: { leaf: leafUrl } },
  24 * 1024 * 1024,
);
tarballs.set("/projects/leaf/packages/1", { file: leafTarball, leaf: true });
tarballs.set("/projects/parent/packages/1", { file: parentTarball, leaf: false });

type Result = {
  delayMs: number;
  attempt: number;
  exitCode: number;
  failedToResolve: boolean;
};

async function install(delayMs: number, attempt: number): Promise<Result> {
  leafDelayMs = delayMs;
  const project = join(root, `project-${delayMs}-${attempt}`);
  const cache = join(root, `cache-${delayMs}-${attempt}`);
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "repro",
      version: "1.0.0",
      dependencies: { parent: parentUrl, leaf: leafUrl },
    }),
  );
  const child = Bun.spawn([bun, "install"], {
    cwd: project,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache },
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return {
    delayMs,
    attempt,
    exitCode,
    failedToResolve: stderr.includes("leaf@") && stderr.includes("failed to resolve"),
  };
}

try {
  const revision = Bun.spawnSync([bun, "--revision"], { stdout: "pipe" })
    .stdout.toString().trim();
  console.log(`Bun ${revision}`);
  const results: Result[] = [];
  for (const delayMs of [0, 50]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      results.push(await install(delayMs, attempt));
    }
  }
  console.table(results);
  console.log("Expected on affected Bun: delay=0 fails 3/3; delay=50 passes 3/3.");
  console.log("Expected after the resolver fix: both groups pass 3/3.");
} finally {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
```

## Expected behavior

Both occurrences resolve to the same extracted package, and all six installs exit successfully regardless of response latency.

## Actual behavior

On both tested Bun versions, the zero-latency group exits with `failed to resolve` 3/3 times. Delaying only the leaf response by 50 ms makes the same installs pass 3/3 times. This points to task/callback ordering rather than malformed tarballs, redirects, or network concurrency.

## Relationship to oven-sh/bun#35426

[PR #35426](https://github.com/oven-sh/bun/pull/35426) directly covers this HTTP tarball path, despite its git-focused title:

- `src/install/PackageManager.rs` adds `AppendedTaskPackageMap`, keyed by resolve-task ID, for packages appended after a tarball extract or git checkout.
- `src/install/PackageManager/runTasks.rs`, in the extracted-tarball completion path, stores `task.id -> pkg.meta.id` before taking and draining the task's callback list.
- `src/install/PackageManager/PackageManagerEnqueue.rs`, in the `dependency::version::Tag::Tarball` arm, calculates `Task::Id::for_tarball(url)` and calls `resolve_from_appended_task(...)` before adding a callback. A late identical-URL dependency therefore resolves from the completed task instead of being parked on an already-drained callback list.
- `test/cli/install/bun-install-git-deps.test.ts` adds `installs every tarball-URL dependency that appears directly and transitively`, a dedicated localhost HTTP-tarball regression test for this failure mode.

The PR is still open, and its fix is not present in the canary revision tested above.

## Production workaround

The package graph cannot use one identical URL for every direct and transitive occurrence until the upstream fix ships in a Bun release. The publisher therefore uploads each tarball with its commit-SHA tag plus an additional `graph-<sha>-from-<parent>` tag for every affected duplicate edge. Both tags point to the same immutable package resource, but their distinct alias paths give Bun distinct install-task identities.

Do not put the edge identity in a query string. Bun 1.3.14 preserves the literal `?` in its package-store directory name and later treats that path as a package specifier boundary during runtime module resolution. Installation may succeed, but an installed CLI can then fail to resolve its modules. Path-based tags avoid both the install race and that runtime failure.

Once a released Bun contains oven-sh/bun#35426, remove the per-edge tags, republish the graph, and verify that installation and runtime resolution both pass with one commit-SHA URL per package.

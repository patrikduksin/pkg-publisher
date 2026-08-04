import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (command: string[], cwd: string) => {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
};

const token = (await readFile(".auth-token", "utf8")).trim();
if (!token) throw new Error(".auth-token is empty; run bun run token first");

const root = await mkdtemp(join(tmpdir(), "pkg-publisher-smoke-"));
try {
  const source = join(root, "source");
  const install = join(root, "install");
  await mkdir(source);
  await mkdir(install);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "smoke-pkg", version: "0.0.0", main: "index.js" }),
  );
  await writeFile(join(source, "index.js"), "module.exports = 'alchemy-smoke-ok';\n");
  run(["bun", "pm", "pack"], source);

  const tarballName = (await readdir(source)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("bun pm pack did not create a tarball");
  const tarball = Bun.file(join(source, tarballName));
  const response = await fetch("https://pkg.patrikduksin.com/projects/smoke/packages", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/gzip",
      "Content-Length": String(tarball.size),
      "X-Tags": '["0000000000000000000000000000000000000000"]',
      "X-TTL": "7 days",
    },
    body: tarball,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}): ${await response.text()}`);
  }

  await writeFile(join(install, "package.json"), '{"private":true}');
  run(
    ["bun", "add", "https://pkg.patrikduksin.com/smoke/0000000000000000000000000000000000000000"],
    install,
  );
  const installed = await import(join(install, "node_modules/smoke-pkg/index.js"));
  if (installed.default !== "alchemy-smoke-ok") {
    throw new Error("Installed smoke-pkg did not export the expected value");
  }
  console.log("Smoke test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

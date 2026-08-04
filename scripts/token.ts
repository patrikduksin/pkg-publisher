import { chmod, writeFile } from "node:fs/promises";

const command = Bun.spawnSync(
  [
    "bun",
    "run",
    "alchemy",
    "state",
    "export",
    "--stack",
    "Pkg",
    "--stage",
    "prod",
    "--profile",
    "personal",
    "alchemy.run.ts",
  ],
  { stdout: "pipe", stderr: "pipe" },
);

if (command.exitCode !== 0) {
  process.stderr.write(command.stderr);
  throw new Error("Failed to read the Pkg/prod Alchemy state");
}

const exported = JSON.parse(command.stdout.toString()) as {
  resources: Array<{
    state: {
      logicalId?: string;
      attr?: { text?: { __redacted__?: string } };
    };
  }>;
};
const token = exported.resources.find(({ state }) => state.logicalId === "PrPackageAuthTokenValue")
  ?.state.attr?.text?.__redacted__;

if (!token) {
  throw new Error("Auth token was not found in the Pkg/prod Alchemy state");
}

await writeFile(".auth-token", token, { mode: 0o600 });
await chmod(".auth-token", 0o600);
console.log("Wrote .auth-token with mode 0600");

export const PUBLISHER_HOST =
  // Switch to "pkg.patrikduksin.com" and republish after registration is restored.
  "pkg-pkgworker-prod-3h2ug3xkdl7e2fr4.patrikduksin.workers.dev";

export const TTL = "90 days";

export type GraphPackage = {
  name: string;
  path: string;
};

export const PACKAGES: GraphPackage[] = [
  { name: "@distilled.cloud/core", path: "distilled/packages/core" },
  { name: "@distilled.cloud/aws", path: "distilled/packages/aws" },
  { name: "@distilled.cloud/axiom", path: "distilled/packages/axiom" },
  {
    name: "@distilled.cloud/cloudflare",
    path: "distilled/packages/cloudflare",
  },
  { name: "@distilled.cloud/neon", path: "distilled/packages/neon" },
  {
    name: "@distilled.cloud/planetscale",
    path: "distilled/packages/planetscale",
  },
  {
    name: "@distilled.cloud/cloudflare-rolldown-plugin",
    path: "cloudflare-tools/packages/cloudflare-rolldown-plugin",
  },
  {
    name: "@distilled.cloud/cloudflare-runtime",
    path: "cloudflare-tools/packages/cloudflare-runtime",
  },
  {
    name: "@distilled.cloud/cloudflare-vite-plugin",
    path: "cloudflare-tools/packages/cloudflare-vite-plugin",
  },
  { name: "alchemy", path: "packages/alchemy" },
];

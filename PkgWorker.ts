import * as PrPackage from "@alchemy.run/pr-package";
import * as Cloudflare from "alchemy/Cloudflare";

const parseAliasUrl: PrPackage.ParseAliasUrl = (url) => {
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  if (segments.length === 2) {
    return { pkgName: segments[0]!, tag: segments[1]! };
  }
  if (segments.length === 3 && segments[0]!.startsWith("@")) {
    return { pkgName: `${segments[0]!}/${segments[1]!}`, tag: segments[2]! };
  }
  return null;
};

export default class PkgWorker extends Cloudflare.Worker<PkgWorker>()(
  "PkgWorker",
  {
    main: import.meta.url,
    url: true,
    domain: ["pkg.patrikduksin.com"],
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  PrPackage.handler({ parseAliasUrl }),
) {}

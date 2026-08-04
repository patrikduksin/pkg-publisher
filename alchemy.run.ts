import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as PrPackage from "@alchemy.run/pr-package";
import PkgWorker from "./PkgWorker.ts";

export default Alchemy.Stack(
  "Pkg",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const authToken = yield* PrPackage.AuthTokenValue;
    const worker = yield* PkgWorker;
    return {
      url: worker.url.as<string>(),
      authToken: authToken.text,
    };
  }),
);

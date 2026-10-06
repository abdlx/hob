// Runs backend lint with the selected installed toolchain.
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { main as runOxlintShards } from "./run-oxlint-shards.mts";

await runWithFailedTrailer("lint", async () => {
  process.exitCode = await runOxlintShards();
});

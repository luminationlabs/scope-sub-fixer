/**
 * Entry point of the compiled engine sidecar.
 *
 * `src/cli/main.ts` only runs when it is the script Node was started with, a
 * test that cannot pass inside a single-file executable (there is no script
 * path to compare). So the sidecar calls `main` itself. It is the whole CLI,
 * not just `serve`: `scope-sub-engine doctor` works from a terminal too.
 */
import { main } from "../../src/cli/main.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });

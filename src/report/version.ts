/**
 * Tool identity stamped into every JSON report. Kept as a literal rather than
 * read from package.json at runtime so the compiled CLI has no file lookups;
 * `test/report/version.test.ts` keeps it in step with package.json.
 */
export const TOOL_NAME = "scope-sub";
export const TOOL_VERSION = "0.9.0";

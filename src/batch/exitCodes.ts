/**
 * Exit codes from PRD §20 that `apply` and `revert` can produce.
 *
 * In a module of its own so `apply.ts` can use `revert.ts`'s in-place writer
 * without the two importing each other.
 */
export const APPLY_EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  DEPENDENCY_MISSING: 3,
  FIX_FAILURE: 6,
  VALIDATION_FAILURE: 7,
  OUTPUT_CONFLICT: 8,
} as const;

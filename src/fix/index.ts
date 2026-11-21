export * from "./types.js";
export {
  FIX_EXIT,
  FixError,
  fixFile,
  type FixDeps,
  type FixErrorKind,
  type FixOptions,
} from "./fixFile.js";
export {
  applyPlanToDisplaySets,
  positionFields,
  rewriteSegments,
  type DeltaApplication,
  type PositionField,
} from "./patchPlan.js";
export {
  PatchVerifyError,
  verifyPatchBytes,
} from "./patchFile.js";
export {
  copyWithPatches,
  hashFileChunked,
  DEFAULT_CHUNK_SIZE,
  type CopyWithPatchesOptions,
  type CopyWithPatchesResult,
} from "./copyPatch.js";
export {
  RemuxError,
  SCOPE_FIXED_SUFFIX,
  buildRemuxArgs,
  type CorrectedTrackSpec,
  type RemuxArgsOptions,
  type SourceTrackRef,
} from "./remux.js";

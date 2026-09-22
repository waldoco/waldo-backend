// The sole public ContextComposer seam. Repository, SQL, rendering, provenance, and replay
// mechanics remain private sibling modules behind createContextComposer(...).compose(...).
export { createContextComposer } from './composer';
export { CONTEXT_LAYERS } from './types';
export {
  ContextRecallFailClosedError,
  ContextRecallUnavailableError,
  ContextSourceRejectedError,
  ContextSourceUnavailableError,
} from './faults';
export type {
  ContextComposer,
  ContextComposerDependencies,
  ContextComposerUnexpectedErrorObserver,
  ContextCompositionEvidence,
  ContextCompositionFailureCode,
  ContextCompositionPhase,
  ContextCompositionResult,
  ContextLayer,
  ContextFragment,
  ContextHealthMaterial,
  ContextRecallGateway,
  ContextRecallRequest,
  ContextRecallSnapshot,
  ContextSnapshotAttestation,
  ContextSource,
  ContextSourceKind,
  ContextSourceScope,
  LocalOwnerBinding,
  LocalOwnerBindingResolver,
  ResolvedInvocationInput,
  RuntimeContextMaterials,
  RuntimeContextMaterialsSource,
  RuntimeOwnedContextInputs,
  StagedInputResolver,
  StagedInputSnapshot,
  SystemSkillRepository,
  SystemSkillRuntimeState,
  SystemSkillRuntimeStateSource,
  SystemSkillSnapshot,
} from './types';

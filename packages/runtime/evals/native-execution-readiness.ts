// Concrete supervisor support admission. Bundle completeness declarations alone
// never prove that the actual runtime adapter implements the requested workload.
import type { NativeCaseBundleV1 } from './native-case-bundle';
export type NativeExecutionSupport=Readonly<{source_families:readonly string[];effect_kinds:readonly string[];turn_kinds:readonly NativeCaseBundleV1['turns'][number]['kind'][];production_tools:readonly string[]}>;
export const inspectNativeExecutionSupport=(bundle:NativeCaseBundleV1,support:NativeExecutionSupport):readonly string[]=>{
 const missing:string[]=[];
 for(const family of bundle.required_source_families)if(!support.source_families.includes(family))missing.push(`unimplemented source adapter: ${family}`);
 for(const kind of bundle.required_effect_kinds)if(!support.effect_kinds.includes(kind))missing.push(`unimplemented effect custody: ${kind}`);
 for(const kind of new Set(bundle.turns.map(t=>t.kind)))if(!support.turn_kinds.includes(kind))missing.push(`unimplemented supervisor turn: ${kind}`);
 for(const tool of bundle.manifest.supported_tools)if(!support.production_tools.includes(tool))missing.push(`unavailable actual product tool: ${tool}`);
 return missing;
};

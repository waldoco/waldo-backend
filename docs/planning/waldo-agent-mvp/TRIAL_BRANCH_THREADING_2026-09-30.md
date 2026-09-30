# Trial branch evidence threading

30 September 2026. Fixes #409's evaluator integration gap. No native W/R case is executed or scored by this change.

The trial wrapper formerly called preparation and grading without resolved branch evidence, so W01/W20/W22/W24 remained blocked even when an evaluator had supplied an adjudication. Add an optional branch_adjudications packet on the captured trial: case_id, trial_seed and captured artifact. Reject a foreign case/seed or duplicate packet as harness_error before passing the current-case artifact to both preparation and grading. Missing/digest-invalid artifacts still block; R33 stays blocked on its separately unpinned inputs. No branch data is injected into the model path or interpreted as owner permission.

Case/seed fields and digest are consistency checks, not authenticated reviewer or source truth. The independent reviewer must inspect the artifact's provenance and fixture decision. Existing receipt verification covers the original trial fields, not this additional adjudicator role; the new packet cannot emit an official pass, and candidate_pass_unverified retains external-verification caveats. Do not expand synthetic HMAC roles to imply trust they cannot prove. Manifest readiness/world audit integration (#411) and aggregate-versus-per-response cost evidence remain separate gaps.

Tests cover all four cases, no branch, valid branch with/without independent review, foreign case/seed, duplicate and bad digest. The original wrapper fails the valid-branch regressions; corrected tests pass using synthetic captures/reviews only. Source native-suite statuses remain not_run. Existing callers without adjudication packets preserve their prior behavior.

import { healthSourceSchema, type HealthSource } from '@waldo/contracts';
import type { HealthDemandObservation } from '../../../contracts/src/health/demand';
import { healthCalculationReviewReceiptSchema, validHealthCalculationReview, type HealthCalculationReviewReceipt } from './calculation-review';
import { createHealthDemandProduction } from './demand';
import { createHealthDemandCollector, type HealthDemandCapture, type HealthDemandCollectorHost } from './demand-collector';
import { createHealthProduction, type HealthClock, type HealthResult, type HealthSignedCall } from './production';
import type { HealthCalculationActivation } from './producer';

export type OwnerHealthCurrentScope = Readonly<{
  plane: 'health' | 'health_demand';
  operation: string;
  source?: HealthSource;
  consent_epoch?: number;
  audience?: 'owner' | 'model';
}>;
export type OwnerHealthProductionHost = Pick<HealthDemandCollectorHost, 'accounts' | 'google' | 'ownerEstimates' | 'responses'> & Readonly<{
  call: HealthSignedCall | null;
  // The authenticated signed owner handle is also the calculator owner_ref. A
  // channel subject or app-provided identity must never be substituted here.
  doName: string | null;
  assertCurrent(scope?: OwnerHealthCurrentScope): Promise<void>;
}>;
export type OwnerHealthCalculationConfiguration = Readonly<{
  review_receipt: HealthCalculationReviewReceipt;
  sleep_need?: HealthCalculationActivation['sleep_need'];
}>;
export type OwnerHealthActivation = Readonly<
  | { state: 'inactive'; reason: 'review_receipt_required' | 'review_receipt_invalid' }
  | { state: 'reviewed_candidate'; review_ref: string; versions: HealthCalculationReviewReceipt['versions']; clinical_validation: 'not_established' }
>;

// This composes the existing signed health writer and actual demand suppliers. It
// owns neither provider authority nor a scheduler, and holds no raw health cache.
export const createOwnerHealthProduction = (
  host: OwnerHealthProductionHost,
  clock: HealthClock = { now: () => new Date() },
  configuration?: OwnerHealthCalculationConfiguration,
) => {
  const receipt = healthCalculationReviewReceiptSchema.safeParse(configuration?.review_receipt);
  const admitted = receipt.success && validHealthCalculationReview(receipt.data, receipt.data.review_ref) ? receipt.data : null;
  const activation: OwnerHealthActivation = admitted
    ? { state: 'reviewed_candidate', review_ref: admitted.review_ref, versions: admitted.versions, clinical_validation: 'not_established' }
    : { state: 'inactive', reason: configuration ? 'review_receipt_invalid' : 'review_receipt_required' };
  const call = host.call, doName = host.doName;
  const guardedCall: HealthSignedCall | null = call && doName ? async (fn, message, args) => {
    // A signed request cannot acquire a different owner's custody through this host.
    if (args.p_do_name !== doName || !['health_plane', 'health_demand'].includes(fn)) throw new Error('Health owner scope unavailable.');
    const payload: unknown = JSON.parse(String(args.p_payload));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Health owner scope unavailable.');
    const data = payload as Record<string, unknown>;
    const source = healthSourceSchema.safeParse(data.source);
    const scope: OwnerHealthCurrentScope = {
      plane: fn === 'health_plane' ? 'health' : 'health_demand', operation: String(args.p_operation),
      ...(source.success ? { source: source.data } : {}),
      ...(Number.isSafeInteger(data.consent_epoch) && Number(data.consent_epoch) > 0 ? { consent_epoch: Number(data.consent_epoch) } : {}),
      ...(data.audience === 'owner' || data.audience === 'model' ? { audience: data.audience } : {}),
    };
    // The DB checks consent in its transaction; the host independently fences
    // owner lifecycle, source/account grants and the admitted session around IO.
    await host.assertCurrent(scope);
    const result = await call(fn, message, args);
    await host.assertCurrent(scope);
    return result;
  } : null;
  const healthForCollection = createHealthProduction(guardedCall, doName, clock);
  const demand = createHealthDemandProduction(guardedCall, doName, clock);
  const collector = createHealthDemandCollector({
    owner_ref: doName ?? '', health: healthForCollection, demand,
    assertCurrent: () => host.assertCurrent(),
    accounts: () => host.accounts(), google: account => host.google(account),
    ownerEstimates: () => host.ownerEstimates(), responses: () => host.responses(),
  }, clock);
  const calculations: HealthCalculationActivation | undefined = admitted ? {
    review_ref: admitted.review_ref, review_receipt: admitted, versions: admitted.versions,
    ...(configuration?.sleep_need ? { sleep_need: structuredClone(configuration.sleep_need) } : {}),
    supplemental: collector.supplemental,
  } : undefined;
  const health = createHealthProduction(guardedCall, doName, clock, calculations);
  return {
    health,
    activation,
    // The existing owner scheduler calls this explicitly at a consistent local
    // cutoff. Historical capture is rejected by the collector rather than backdated.
    async capture(input: HealthDemandCapture): Promise<HealthResult<Readonly<{ scopes: readonly Readonly<{ metric: HealthDemandObservation['metric']; source_ref: string; context_ref: string }>[] }>>> {
      if (!guardedCall || !doName) return { ok: false, error: 'not_linked' };
      try {
        const scope: OwnerHealthCurrentScope = { plane: 'health_demand', operation: 'capture', source: input.source, consent_epoch: input.consent_epoch };
        await host.assertCurrent(scope);
        const result = await collector.capture(input);
        await host.assertCurrent(scope);
        return result;
      } catch { return { ok: false, error: 'unavailable' }; }
    },
  };
};
export type OwnerHealthProduction = ReturnType<typeof createOwnerHealthProduction>;

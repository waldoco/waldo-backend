import { iMessageEventSchema, type IMessageEvent } from '@waldo/contracts';
import { admitIMessageOwnerTurn, type IMessageAdmissionDeps } from './admission';
import type { OwnerRoute } from '../../identity/owner-directory';
import type { OwnerTurnEnvelope } from '../owner-turn-envelope';
import type { IMessageMediaStatus } from './media';
export type NotAdmittedReason = 'not_admitted' | 'media_unavailable' | 'media_invalid' | 'media_capacity';
export type RelayAdmitterDeps = Readonly<{
    admission: IMessageAdmissionDeps;
    onAdmittedTurn: (route: OwnerRoute, turn: OwnerTurnEnvelope, media: readonly IMessageMediaStatus[]) => unknown | Promise<unknown>;
    receiptSink: (event: Extract<IMessageEvent, {
        kind: 'receipt';
    }>) => unknown | Promise<unknown>;
    nonTurnSink: (event: IMessageEvent) => unknown | Promise<unknown>;
    onNotAdmitted: (event: IMessageEvent, reason: NotAdmittedReason) => 'acknowledge' | 'hold' | Promise<'acknowledge' | 'hold'>;
}>;
function reasonCode(error: unknown): NotAdmittedReason | null {
    const message = error instanceof Error ? error.message : '';
    if (message === 'iMessage turn not admitted')
        return 'not_admitted';
    if (message === 'iMessage media unavailable')
        return 'media_unavailable';
    if (message === 'iMessage excess media')
        return 'media_capacity';
    if (message === 'iMessage ambiguous media' || message === 'iMessage media mismatch' || message === 'iMessage media ticket rejected')
        return 'media_invalid';
    return null;
}
/** Inert adapter; signed authentication and replay protection belong to SignedRelay.flush. */
export function createRelayAdmitter(deps: RelayAdmitterDeps) {
    for (const fn of [deps.onAdmittedTurn, deps.receiptSink, deps.nonTurnSink, deps.onNotAdmitted])
        if (typeof fn !== 'function')
            throw new Error('relay_admitter_policy_required');
    return async (body: string, _headers: unknown): Promise<{
        admitted: true;
        eventId: string;
        digest: string;
    }> => {
        const event = iMessageEventSchema.parse(JSON.parse(body));
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (event.kind === 'message') {
            let callbackEntered = false;
            try {
                await admitIMessageOwnerTurn(event, deps.admission, (route, turn, media) => { callbackEntered = true; return deps.onAdmittedTurn(route, turn, media); });
            }
            catch (error) {
                const reason = reasonCode(error);
                // Callback and infrastructure failures remain pending; policy cannot silently drop them.
                if (callbackEntered || reason === null)
                    throw error;
                const decision = await deps.onNotAdmitted(event, reason);
                if (decision !== 'acknowledge')
                    throw new Error(decision === 'hold' ? 'relay_admission_held' : 'relay_admission_policy_invalid');
            }
        }
        else if (event.kind === 'receipt')
            await deps.receiptSink(event);
        else
            await deps.nonTurnSink(event);
        return { admitted: true, eventId: event.eventId, digest };
    };
}

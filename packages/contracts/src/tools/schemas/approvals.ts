import { z } from 'zod';

// Approvals the owner put off ("Not now") wait until Waldo raises them again. When is the model's judgment; the desk
// raises only an approval that is still put off, waiting and unexpired.
export const raiseApprovalArgsSchema = z.strictObject({
  operation: z.enum(['list', 'raise']).describe('list: the approvals waiting on the owner, with the ones they put off marked. raise: show one they put off to them again.'),
  approval_id: z.string().regex(/^p[A-Za-z0-9-]{1,63}$/).optional().describe('The approval to raise, from list. Only with raise.'),
}).refine(args => (args.operation === 'raise') === (args.approval_id !== undefined), { error: 'raise needs approval_id; list takes none', path: ['approval_id'] });
export type RaiseApprovalArgs = z.infer<typeof raiseApprovalArgsSchema>;

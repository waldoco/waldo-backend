import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildResponsibilityJudgmentAuthorityV05Bundle,
} from '../packages/contracts/src/protocol/responsibility-judgment-authority-v0-5-fixtures';
import {
  canonicalizeJudgmentRequestV05ForDigest,
  judgmentAnswerRequestV05Schema,
  judgmentDecisionV05Schema,
  judgmentProjectionPageV05Schema,
  judgmentRequestV05Schema,
} from '../packages/contracts/src/protocol/responsibility-judgment-authority-v0-5';

describe('generate responsibility judgment and authority v0.5 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-judgment-authority/v0.5/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const sourceSha256 = createHash('sha256')
      .update(readFileSync(new URL(
        '../packages/contracts/src/protocol/responsibility-judgment-authority-v0-5.ts',
        import.meta.url,
      )))
      .digest('hex');
    const bundle = buildResponsibilityJudgmentAuthorityV05Bundle(
      (value) => createHash('sha256').update(value).digest('hex'),
      sourceSha256,
    );
    const request = judgmentRequestV05Schema.parse(
      JSON.parse(bundle['judgment-request.valid.json']!),
    );
    const answer = judgmentAnswerRequestV05Schema.parse(
      JSON.parse(bundle['judgment-answer.valid.json']!),
    );
    const decision = judgmentDecisionV05Schema.parse(
      JSON.parse(bundle['judgment-decision.valid.json']!),
    );
    const projection = judgmentProjectionPageV05Schema.parse(
      JSON.parse(bundle['judgment-projection-page.valid.json']!),
    );
    const requestDigest = `sha256:${createHash('sha256')
      .update(canonicalizeJudgmentRequestV05ForDigest(request))
      .digest('hex')}`;
    expect(answer.payload.displayedRequestDigest).toBe(requestDigest);
    expect(decision.displayedRequestDigest).toBe(requestDigest);
    expect(projection.items[0]?.displayedRequestDigest).toBe(requestDigest);
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildResponsibilityJudgmentAuthorityV04Bundle,
  canonicalizeJudgmentRequestV04ForDigest,
  judgmentAnswerRequestV04Schema,
  judgmentDecisionV04Schema,
  judgmentRequestV04Schema,
} from '../packages/contracts/src';

describe('generate responsibility judgment and authority v0.4 fixtures', () => {
  it('writes the version-pinned fixture bundle', () => {
    const directory = new URL(
      '../packages/contracts/fixtures/responsibility-judgment-authority/v0.4/',
      import.meta.url,
    );
    mkdirSync(directory, { recursive: true });
    const bundle = buildResponsibilityJudgmentAuthorityV04Bundle((value) =>
      createHash('sha256').update(value).digest('hex'),
    );
    const request = judgmentRequestV04Schema.parse(
      JSON.parse(bundle['judgment-request.valid.json']!),
    );
    const answer = judgmentAnswerRequestV04Schema.parse(
      JSON.parse(bundle['judgment-answer.valid.json']!),
    );
    const decision = judgmentDecisionV04Schema.parse(
      JSON.parse(bundle['judgment-decision.valid.json']!),
    );
    const requestDigest = `sha256:${createHash('sha256')
      .update(canonicalizeJudgmentRequestV04ForDigest(request))
      .digest('hex')}`;
    expect(answer.payload.displayedRequestDigest).toBe(requestDigest);
    expect(decision.displayedRequestDigest).toBe(requestDigest);
    for (const [path, contents] of Object.entries(bundle)) {
      writeFileSync(new URL(path, directory), contents);
    }
  });
});

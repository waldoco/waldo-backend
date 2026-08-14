import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityClosureV04Bundle } from './responsibility-closure-v0-4-fixtures';
import { buildResponsibilityContinuityV04Bundle } from './responsibility-continuity-v0-4-fixtures';
import { buildResponsibilityExecutionV04Bundle } from './responsibility-execution-v0-4-fixtures';
import { buildResponsibilityPresenceChannelV04Bundle } from './responsibility-presence-channel-v0-4-fixtures';
import { boundedProtocolTextV04, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

describe('responsibility protocol v0.4 primitives', () => {
  it('pins the version and rejects malformed Unicode', () => {
    expect(protocolVersionV04Schema.parse('0.4')).toBe('0.4');
    expect(protocolVersionV04Schema.safeParse('0.3').success).toBe(false);
    expect(boundedProtocolTextV04(8).safeParse('\ud800').success).toBe(false);
  });

  it('gives every simple-family public schema a valid portable fixture', () => {
    const builders = [
      buildResponsibilityPresenceChannelV04Bundle,
      buildResponsibilityExecutionV04Bundle,
      buildResponsibilityClosureV04Bundle,
      buildResponsibilityContinuityV04Bundle,
    ];
    for (const build of builders) {
      const bundle = build(() => 'f'.repeat(64));
      for (const schemaPath of Object.keys(bundle).filter((path) =>
        path.endsWith('.schema.json'),
      )) {
        const fixturePath =
          schemaPath === 'verification.schema.json'
            ? 'verification-indeterminate.valid.json'
            : schemaPath.replace('.schema.json', '.valid.json');
        expect(bundle[fixturePath], `${schemaPath} lacks ${fixturePath}`).toBeDefined();
        const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
          JSON.parse(bundle[schemaPath]!),
        );
        const fixture = JSON.parse(bundle[fixturePath]!);
        expect(validate(fixture), `${schemaPath}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });
});

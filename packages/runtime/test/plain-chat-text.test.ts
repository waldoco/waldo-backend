import { describe, expect, it } from 'vitest';
import { plainChatText } from '../src/channels/rich-format';

// WhatsApp and iMessage show the reply as typed: Markdown arrives as literal brackets and asterisks.
describe('plainChatText', () => {
  it('turns bold into WhatsApp bold and a link into its label and URL', () => {
    expect(plainChatText('Call **now**: [Axis contact page](https://www.axisbank.com/contact-us).'))
      .toBe('Call *now*: Axis contact page (https://www.axisbank.com/contact-us).');
  });
  it('shows a link whose label is its own address once', () => {
    expect(plainChatText('See [axisbank.com](https://www.axisbank.com/) or [https://a.example/x](https://a.example/x).'))
      .toBe('See https://www.axisbank.com/ or https://a.example/x.');
  });
  it('drops heading marks and leaves code, bare links and plain text as written', () => {
    expect(plainChatText('## Plan\nRun `a **b**` then open https://x.example/a_b_c.\n```\n**raw**\n```'))
      .toBe('Plan\nRun `a **b**` then open https://x.example/a_b_c.\n```\n**raw**\n```');
    expect(plainChatText('Done. Thursday at 10.')).toBe('Done. Thursday at 10.');
  });
});

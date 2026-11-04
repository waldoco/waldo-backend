import { describe, expect, it } from 'vitest';
import { QUICK_REPLY_LABEL_MAX_CHARS } from '../../app/parts';
import { OFFER_REPLIES_MAX_CHOICES, offerRepliesArgsSchema, offerRepliesResultSchema } from './offer-replies';

describe('offer_replies arguments', () => {
  it('takes one to three short, distinct answers', () => {
    expect(offerRepliesArgsSchema.safeParse({ choices: ['Finish the deck'] }).success).toBe(true);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['Finish the deck', 'Gym first', 'Something else'] }).success).toBe(true);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['x'.repeat(QUICK_REPLY_LABEL_MAX_CHARS)] }).success).toBe(true);
  });

  it('refuses none, more than WhatsApp shows, an over-long or blank answer, a repeat, and anything else', () => {
    expect(offerRepliesArgsSchema.safeParse({ choices: [] }).success).toBe(false);
    expect(offerRepliesArgsSchema.safeParse({ choices: Array.from({ length: OFFER_REPLIES_MAX_CHOICES + 1 }, (_, i) => `Option ${i}`) }).success).toBe(false);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['x'.repeat(QUICK_REPLY_LABEL_MAX_CHARS + 1)] }).success).toBe(false);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['   '] }).success).toBe(false);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['Gym', 'gym'] }).success).toBe(false);
    expect(offerRepliesArgsSchema.safeParse({ choices: ['Gym'], question: 'What first?' }).success).toBe(false);
  });
});

describe('offer_replies result', () => {
  it('says whether the answers will go out with the card, and why not', () => {
    expect(offerRepliesResultSchema.safeParse({ offered: true }).success).toBe(true);
    expect(offerRepliesResultSchema.safeParse({ offered: false, reason: 'already_offered' }).success).toBe(true);
    expect(offerRepliesResultSchema.safeParse({ offered: false, reason: 'sent' }).success).toBe(false);
    expect(offerRepliesResultSchema.safeParse({ offered: true, reason: 'not_card_turn' }).success).toBe(false);
  });
});

# Staging E2E: forget barrier and asynchronous purge

Flag: `WALDO_FORGET_BARRIER` in `env.staging.vars` of `packages/runtime/wrangler.jsonc` (added by the barrier PR). Rollback: set it to `"off"` and redeploy; the previous filters take over and nothing stored changes.

Use a synthetic fact, never a real one. Run on the owner's account after the staging deploy that carries the flip. The owner's app, WhatsApp and Telegram must all be linked to the same owner.

1. **Tell, in two messages.** In the app: "My locker code at the climbing gym is Bluefin 4471." Wait for the reply. Then: "Separate thing: I keep my spare chalk bag in locker 12." Two messages, so no single memory carries both.
2. **Check it was learned.** In the app: "what do you know about my climbing gym?" Expect the locker code or the chalk bag in the answer.
3. **Forget.** In the app: "Forget my locker code Bluefin." Expect a receipt that says it is forgotten and that cleanup of stored copies is running. Note the time `T`.
4. **Ask directly, on three surfaces**, within a minute of `T`:
   - app: "what's my locker code?"
   - WhatsApp: "remind me of the code for my gym locker"
   - Telegram: "what code did I tell you this morning?"

   Expect each to say it does not know or that it was forgotten. None may quote `Bluefin` or `4471`. (The probes never contain the topic, so an echo of the owner's own words cannot pass for a leak.)
5. **Ask by paraphrase.** In the app: "what number did I give you for the gym?" Expect no `4471`.
6. **Nothing else went missing.** In the app: "where's my spare chalk bag?" Expect locker 12: the barrier drops the forgotten item, not the whole memory.
7. **An outside page still reads.** In the app: "search the web for bluefin tuna sustainability and summarise one page." Expect a normal summary. Where the page says "Bluefin" and the forgotten topic was that word, the model sees it redacted with a one-line note; the page is not withheld. (This probe types the word on purpose: the owner's current message is never filtered.)
8. **Console memory page.** While the purge is pending: the topic is listed under "Forgetting" (masked to its first letter and length), with each store's state and a "Retry now" button; the memory graph and profile are shown, not blank. After it settles (normally minutes): the topic is gone from the list.
9. **Traces.** In Langfuse (staging), open the traces for steps 4 to 7. The model input for steps 4 to 6 contains no `Bluefin` and no `4471`. Step 7's input carries the owner's own word in their message, and the page text in its tool result is redacted with the note. In Cloudflare logs, filter `"hop":"forget_settled"` after `T`: one line, with no topic text.

Pass when steps 4 to 9 hold on all three surfaces. Any `Bluefin` or `4471` in a reply or a model input is a fail; copy the trace id into the PR.

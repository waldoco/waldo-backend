# Owner trace persistence clock

Base bff864af7684f14e482dbf20c72ece0274d77cff; branch lane/waldo-owner-trace-clock; consumer #377 isolated owner-DO captures.

Premise: owner trace persistence used Date.now while fixture source/effect and responder clocks used injected deps.now. The owner ingress test reproduced this at the persisted trace boundary: 4/5 tests passed, fictional Google-read trace timestamps failed the fixture-time assertion. Hypotheses were a wrong world clock or a bypass in trace persistence. Source showed both normal and exporter-failure persistence directly calling Date.now. The world read/effect clocks were already bound.

Choice: initialize the existing deps before the log closure and use deps.now for both trace writes. Alternative global Date replacement would alter library timers and make the evidence less useful. Production deps still uses wall time. No new public override, effect permission or security relaxation.

Verification: the revised test advances the world one minute between owner A and B, then checks each persisted trace against its own turn time, not a frozen start or the other owner's turn. Owner ingress 5/5, trace-book tests 5/5 and runtime typecheck pass locally. Review covers both trace writes. Duration measurements still use wall time intentionally; other scheduler, tool ledger and memory timestamp sites remain separate work. Not a full DO-wide clock seal or W/R result. No live staging or actual provider claim.

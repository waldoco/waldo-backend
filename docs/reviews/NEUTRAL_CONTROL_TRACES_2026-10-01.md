# Channel control trace alignment

Follow-up to #459. The compatibility core already emitted `whatsapp-N`, but listener
timers/final roots and direct DO commands/callbacks still emitted `tg-N`. That split
made one WhatsApp turn look like two unrelated traces. A host-selected helper now
aligns envelope, listener and direct-control trace IDs; Telegram remains `tg-N`.

No DO name/owner authentication/offset key/conversation store/send policy changes.
Telegram-specific interception and probes retain their old IDs. WhatsApp still uses
the compatibility transport shim; native ingress, preference routing and separation
of shared rolling history are not implemented by this slice. Trace labels are not
identity or authorization. The host supplies the surface, never user content.

Focused listener/envelope/control tests cover success, unsupported media, failures,
wrong-owner no-effects and same numeric sequence on two surfaces. Real owner-DO
sealed ingress regression also passed. Live Telegram proof follows review and exact
CI/merge/deployment; it has not run for this follow-up yet. A live WhatsApp provider
run is not claimed.

# iMessage source pin and capability matrix

Preferred reference: [imsg](https://github.com/openclaw/imsg/tree/640f58f4f80220b10082eafe4d725049fe2acb77), exact commit `640f58f4f80220b10082eafe4d725049fe2acb77`, MIT, inspected 1 October 2026. Protocol version 1 over JSON-RPC 2.0 NDJSON. No upstream executable/code is imported or run. The synthetic DTOs are Waldo-authored. The upstream license is retained alongside the protocol attribution.

Pinned primary sources: [RPC](https://github.com/openclaw/imsg/blob/640f58f4f80220b10082eafe4d725049fe2acb77/docs/rpc.md), [JSON](https://github.com/openclaw/imsg/blob/640f58f4f80220b10082eafe4d725049fe2acb77/docs/json.md), [send](https://github.com/openclaw/imsg/blob/640f58f4f80220b10082eafe4d725049fe2acb77/docs/send.md), [advanced bridge](https://github.com/openclaw/imsg/blob/640f58f4f80220b10082eafe4d725049fe2acb77/docs/advanced-imcore.md), [license](https://github.com/openclaw/imsg/blob/640f58f4f80220b10082eafe4d725049fe2acb77/LICENSE).

| Feature | Source-level receive | Source-level send | Exact targeting / proof caveat | Scaffold live state |
|---|---|---|---|---|
| Text / files | SQLite history/watch metadata | AppleScript or private bridge | Local outgoing row is not recipient delivery | Disabled |
| URL balloon | Logical message coalescing | Private bridge preview | Preserve URL plus original instruction; preview untrusted | Disabled |
| Reply / part / thread | GUID and thread metadata | Private bridge | Require verified GUID + part in same account/chat | Disabled |
| Standard reaction | Watch/cursor reaction extension | UI react or bridge tapback | UI react cannot prove exact targeting | Disabled |
| Custom reaction | Custom emoji receive metadata | UI react rejects; optional bridge probe | Never map to nearest standard tapback | Disabled |
| Ordered audio / video / documents | Attachment metadata | Ordinary files | Native voice is a distinct private flag | Disabled |
| Styled text / effects | Not asserted by this inspection | Private bridge | Native ranges; plain readable fallback later | Disabled |
| Typing / read state | Optional bridge events / DB snapshot | IMCore operations | Activation/entitlement/privacy risk | Disabled |
| Edit / unsend | Optional events/capability | Private selectors | Host/platform windows unverified | Disabled |
| Stickers / polls | Attachment/poll metadata | Private selectors | Preserve actor/part; external vote is not consent | Disabled |
| Groups / membership | Chat participants | Private or existing group route | Owner membership/audience policy awaits S3 | Disabled |
| Name/photo sharing | Optional status | Private mutation | Privacy-sensitive; explicit later approval | Disabled |
| Arbitrary app balloons / Apple Pay / location | Safe unsupported bundle identity only | Unsupported | No arbitrary extension payload execution | Disabled |

These are inspected upstream surfaces, not Waldo live capabilities or an Apple compatibility benchmark. `supported_methods` is the compiled union; `methods` reflects readiness at the instant of a probe. Only later verified host probes may admit a feature. The matrix is deliberately more conservative than UI tapback success.

Protocol bounds in the pinned RPC source: 128 outstanding requests; watch buffer range 1..4096 with default256; cursor catchup page max500; independent read lane max4. Only limits actually used by the relay will be encoded. Spool bytes, request bytes, signature freshness and heartbeat expiry are operational policy, not inferred imsg facts: callers must supply explicit bounded policy with provenance; the fixture policy is synthetic and never a live default.

Secondary candidates remain design references only: BlueBubbles Apache-2.0, OpenClaw/Hermes MIT, Photon Kit/Spectrum/adapter MIT. No code from those projects is reused in S0-S2; no transitive framework is installed. Their licenses/maintenance are not current live verification. BlueBubbles mapping is S5.

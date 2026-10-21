# Smoke transport correction

30 September 2026. Guarded smoke run36666998416 failed before any captured successful Responses response. Credential validation passed; no bearer warning pattern was found in its stdout. All LLM attempts were classified transient. This is not a model usefulness verdict or proof of zero billing/network traffic.

A credential-free, unpaid transport reproduction in the Workers test runtime found the cause: redirect:error throws TypeError because Workers supports only follow/manual. The smoke wrapper used error to enforce its no-redirect rule. The same unauthenticated models GET with manual returned401. The test probe used no model generation or key and was removed after diagnosis.

Correction: use manual and reject every3xx response without following. The exact Responses URL and POST restriction stay. Reserve each request receipt before await so transport failures and concurrent attempts count towards the eight-attempt ceiling. Record bounded status/failure classification and actual response model/ID/raw usage when a JSON response exists. Drop raw transport error text and never record redirect Location. Return HTTP errors to the SDK for its ordinary classification.

Deterministic tests cover supported redirect option, five redirect statuses/no-follow, failed-attempt ceiling, URL/method rejection, actual response metadata and malformed HTTP error bodies. These are synthetic transport tests, not a successful real model trial. Further paid attempt remains an owner-scoped choice after exact-head review/CI; previous runner attempts did not clear the smoke gate. Temporary push triggers are removed after each outcome.

# Brief 02: weather and daylight tool

**Branch:** `instinct/weather-daylight-tool`. A draft PR to `beta-mvp`.

## Why

The website says Waldo factors in weather and daylight ("Weather and daylight", "Working today"). Today nothing exists.

Owner decision D5 (ledger §10):
- Use Open-Meteo for the forecast, UV and air quality. It needs no key.
- Location is coarse, comes from the app with OS permission, and is never stored more precisely than needed.

## What to build

A read-only agent tool, `get_weather`, that the model can call. Typical uses: the Brief, a run plan, "should I walk to the meeting".

- **Arguments (Zod, strict):**
  - `place`, optional: a free-text place the owner named;
  - `day`, optional: `today` or a date within the forecast range;
  - `hours`, optional.
  - Keep it small.
- **Location resolution, in order:**
  1. `place` if given, via the Open-Meteo geocoding API.
  2. The owner's stored coarse location, through a narrow interface you define, e.g. `OwnerLocationSource.get(): {lat, lon} | null`.
     - Ship an implementation that reads a DO storage key passed in by the host.
     - The owner's lane wires the app side that writes it. Round to 1 decimal (~11 km) before any request.
  3. Otherwise, a typed "no location" result the model can explain ("tell me where you are, or share location in the app").
- **Output:**
  - temperature, feels-like and precipitation probability by hour for the window;
  - UV index;
  - the air-quality category;
  - sunrise, sunset and daylight duration;
  - plus `source: 'open-meteo'` and the fetch time.
  - Keep it compact. The model decides what matters; the tool does not add advice text.

## Where things go

- A new `packages/runtime/src/tools/live/weather.ts` that exports the handler, following the shape of the existing read tools (`tools/live/web-search.ts` is a good reference for outbound fetch, timeouts and errors).
- A new provider adapter, e.g. `packages/runtime/src/connectors/open-meteo.ts`: fetch with a timeout and a bounded response size; parse with Zod.
- Additive edits to the shared tool registries, following an existing read-only tool such as `web_search`. Search for every place it is listed:
  - the args schema in `packages/contracts/src/tools/schemas/reads.ts`;
  - the tool name in `packages/contracts/src/tools/permissions.ts`;
  - `packages/runtime/src/hooks/registry.ts`, `tools/source-scope.ts`, `hooks/claim-verify-effects.ts`, `hooks/tool-replay-class.ts`.
- **Do not register the handler in `channels/telegram-owner-do.ts`** (hot file). Export it; the owner's lane adds the one registration line in review.
- **Egress:** use the repository's existing outbound and egress path. Do not add a bare `fetch` that bypasses it. List the hosts the tool needs in the PR body (`api.open-meteo.com`, `geocoding-api.open-meteo.com`, `air-quality-api.open-meteo.com`), so the owner can add them to the egress allowlist config.

## Behaviour that must hold

- Read-only. No owner data leaves except a rounded coordinate or the place string the owner typed.
- Never log coordinates or place strings.
- Provider failures and timeouts return a typed `unavailable` result, not a throw that fails the turn.
- No retry loops beyond the repo's existing fetch policy.
- No caching that stores location.

## Tests (red first)

- A Zod valid and an invalid test for the args and for the parsed provider response.
- Adapter tests against recorded, synthetic provider payloads:
  - normal;
  - a missing field;
  - an oversized body;
  - a timeout;
  - HTTP 429 and 5xx.
- Location order: `place` wins over the stored location, then the stored location, then "no location".
- Rounding: a 4-decimal coordinate never appears in the outbound URL.
- A registry test that the tool is classified read-only and replay-safe.

## Open question for the owner (put it in the PR)

- Open-Meteo's free API is for non-commercial use. Commercial use needs their paid plan or self-hosting [verify their current terms].

## Done means

- A draft PR.
- The gate table at the head SHA.
- The one-line registration snippet for the owner's lane.
- The egress host list.

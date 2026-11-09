# Health and fitness imports: sources, terms and paths (A5)

Written with the A5 PR for waldoco/waldo-backend#1980, 6 November 2026. Not legal advice. Every verdict below that depends
on reading a clause is an engineering reading, and decisions that rest on one go to the owner.

## What A5 builds, and why

The issue asks for the cheapest path that gives the data.

| Path | State before A5 | A5 |
|---|---|---|
| (a) Phone health store: workouts with type, duration and effort | Accepted since health revision 5 (type, minutes, energy, distance, heart rate, zones, effort, sport metrics) | Nothing to add |
| (a) Phone health store: mindfulness minutes | Accepted (`mindful_duration`), read as `mindful` | Nothing to add |
| (a) Phone health store: nutrition | No signal | **Added** as `nutrition`, revision 7 (`docs/proposals/ADR_0081_AMENDMENT_NUTRITION_2026-11-06.md`) |
| (b) Direct APIs | WHOOP live; Oura mapper only, not connected (its agreement bars storage and AI use) | **None added.** See the table below |
| (c) One-time history files | No parser | **Not built.** See "History files" |

Most apps reach Waldo through path (a) already, because they write to Apple Health or Health Connect: Strava, Garmin
Connect, Hevy and food apps write workouts, and food apps write nutrition. `[inference]` That each of these writes those
types depends on each app's own settings; it was not verified per app. Data that reaches Waldo through HealthKit or Health
Connect comes under the platform rules (section 6 below), not the writer's API terms. `[inference]` Whether a provider's
terms reach data that its own app wrote to the phone's store is a legal question this document does not settle.

## Direct sources: verdicts

| Provider | Verdict | Re-verified in this PR |
|---|---|---|
| Strava | **Blocked.** API Policy §5.3 (effective 1 June 2026) bars use "in connection with the development, training, evaluation, or operation of any AI Application", including "ingestion into a context window or working memory" | Yes: the API Policy page was read directly on 6 November 2026 and §5.3, §5.10 and §5.16 were quoted |
| MyFitnessPal | **Blocked.** "We are not accepting requests for API access at this time." | No, research pass only |
| Oura | **Blocked** for API → model → storage. Model use is allowed only through Oura's MCP server, and that server forbids storage without a written agreement. This matches `docs/app/WHOOP_AND_OURA_2026-10-21.md` | No, research pass only |
| Garmin | **Unknown.** It needs the developer application (with the owner) and Garmin's written approval to pass data to an LLM provider. Reports of an October 2026 revision were not verified | No |
| Hevy | **OK with conditions.** Pro users only; a per-user API key, held like provider tokens in Vault; a beta API that "may … abandon" | No |
| WHOOP (live today) | **Unknown, high risk.** API Terms §4.2(3) (effective 6 October 2026): "Use any API or WHOOP Data to create, develop, test, train, fine-tune or improve any large language model or any other machine learning or artificial intelligence model, application, or system", "Unless expressly authorized by the WHOOP Data owner", where "owner" is not defined | Yes: the terms page was read directly on 6 November 2026 |

**WHOOP goes to the owner as a decision.** The integration is live and predates the 6 October terms. This PR changes nothing
in it. Whether operating Waldo on a member's own WHOOP data, with their consent, falls under "create, develop, test … any
artificial intelligence … application", and who the "WHOOP Data owner" is, needs WHOOP's written answer or a legal reading.

## History files

ADR-0081 keeps raw readings for 90 days, and `waldo.health_ingest` ignores a reading that ended more than 90 days ago. An
Apple Health `export.zip`, a Google Takeout Fit archive, a Garmin export or a Strava bulk export could therefore add only
the last 90 days. The phone's own HealthKit or Health Connect read already covers that window. A file importer is worth
building only after a retention decision for imported history, which is the 31 October amendment's deferred HI-7 (raw
reads beyond 30 days and 24-month aggregates). This goes to the owner rather than being built against a retention it
cannot use.

---

The research pass follows. It was made on 6 November 2026 from each provider's own pages, by an agent working for this PR.
Its Strava and WHOOP clauses were then re-read directly, as marked above. Everything else is as the pass recorded it,
including its own UNVERIFIED marks.


Use case being tested: Waldo, an LLM-based personal health agent, imports one consenting user's own data and uses it to plan that user's day. In practice this means the provider's data enters an LLM context window, is sent to a third-party LLM provider acting as processor, and is kept in Waldo's stores.

Method: I read each provider's own terms, docs or help pages directly with curl or WebFetch on 2026-11-06. Clauses below are quoted verbatim from those fetches. Anything taken only from secondary coverage is marked **UNVERIFIED**. None of this is legal advice. Several verdicts depend on how a clause is read, and those readings are marked `[inference]`.

---

### 1. Strava: BLOCKED

**Sources**
- API Agreement (2026), https://www.strava.com/legal/api. "Effective Date: June 1, 2026"
- API Policy, https://www.strava.com/legal/api_policy. "Effective Date: June 1, 2026". The Agreement incorporates the Policy by reference, and the AI rules sit in the Policy.
- Rate limits, https://developers.strava.com/docs/rate-limits/

**(a) Access.** Public REST API using OAuth (the athlete authorizes your app). New apps start at "Single Player Mode" (athlete capacity 1). Self-serve upgrade raises capacity to 10. Going beyond 10 requires Strava review. Policy §3.3 sets tiers at 10, 9,999 and Extended (10,000+, "approved by Strava"). Standard Tier apps "are subject to subscription requirements … including a requirement that the developer or specified end users maintain an active Strava subscription."

**(b) AI clauses (verbatim, API Policy, eff. 2026-06-01)**
- §5.3 "No AI/ML Training, Fine-Tuning, Grounding, Evaluation, Embedding, or Retrieval-Augmented Generation": "You may not use the Strava API Materials or Strava Data, directly or indirectly, in connection with the development, training, evaluation, or operation of any AI Application. This prohibition extends to: Any data derived from, aggregated from, anonymized from, or generated using Strava Data, in any form (including original, derivative, aggregated, anonymized, de-identified, or model-output form); and Any of the following activities with respect to an AI Application: training, pre-training, post-training, fine-tuning, reinforcement learning, alignment, grounding, evaluation, benchmarking, embedding generation, retrieval-augmented generation, **ingestion into a context window or working memory**, and any other activity intended or reasonably likely to develop, improve, evaluate, or operate an AI Application. This prohibition does not extend to use of the Strava MCP, as discussed above in Section 3.5."
- §5.10: "You may not, directly or indirectly, disclose, market, sell, license, lease, or make available in exchange for monetary or other valuable consideration, any Strava Data to any third party — including advertisers, data brokers, AI Application providers, or model developers — even if a user of your Developer Application consents."
- §3.5 (Strava MCP): "Subscribers to Strava may access the Strava MCP in connection with their personal use of their own Strava data … and may bring their own AI Application to interact with their own data through the Strava MCP. The Strava MCP is not authorized for, and may not be used to enable, any commercial or third-party access to the Strava API Materials or Strava Data outside the developer's own personal use."
- §5.16(b): you may not "operate any MCP Server, agent-mediated interface, or analogous mechanism that exposes the Strava API Materials, Strava Data, or any subset thereof".
- "AI Application" is not defined in either page as fetched.

**(c) Other blockers**
- §5.4: "You may not combine Strava Data with other customer data for these or any other purposes."
- §5.5: no storage "in any Persistent Index … vector stores, embedding stores, search indexes, knowledge graphs, retrieval-augmented data stores".
- §6.2: "You may not retain Strava Data in your cache for longer than seven (7) days."
- §5.2 forbids apps that compete with Strava, and §5.8 forbids charging end users for Strava functionality.

**(d) Verdict: BLOCKED.** §5.3 names "ingestion into a context window or working memory" and "operation of any AI Application", which describes Waldo's core loop exactly. A user's consent does not cure §5.10. The Strava MCP carve-out covers personal, non-commercial use only. The user's own bulk export (§6.6) is outside the API terms. Whether Waldo could ingest a file the user uploads themselves is a separate legal question and is not settled here.

---

### 2. Hevy: OK with conditions

**Sources**
- Public API docs (OpenAPI spec embedded in https://api.hevyapp.com/docs/, version "0.0.1")
- Terms & Conditions, https://www.hevyapp.com/terms-and-conditions-1/. "effective as of 23 June 2019"

**(a) Access.** A public REST API exists. Each request carries a per-user `api-key` header (UUID). There is no OAuth: each user generates their own key and would paste it into Waldo. Endpoints include workouts, workouts/events, routines, routine_folders, exercise_templates, exercise_history, body_measurements and user/info. From the spec: "Currently, this API is only available to Hevy Pro users. You can get your key on our web app at https://hevy.com/settings?developer."

**(b) AI clauses.** None. The API description and the general T&Cs contain no AI, ML or third-party AI language. I found no separate developer or API agreement. UNVERIFIED: whether one exists that is not linked from the docs.

**(c) Other conditions**
- The spec says: "We're just starting to roll this out … we make no guarantees that we won't completely change the structure or abandon the project entirely so use it at your own risk."
- Pro subscription required.
- The spec asks callers not to sync "exactly at xx:00". No numeric rate limit is published.
- The key is a long-lived bearer credential for the user's account. Per Waldo's security overlay it must go in Supabase Vault and never be logged.
- `[inference]` The API is designed for a user using their own key. Hevy has not said anything about a third-party commercial app collecting many users' keys. Confirm with Hevy (pavel@hevyapp.com, per the docs) before launch.

**(d) Verdict: OK with conditions.** No AI restriction exists. The risks are platform stability (beta, could be abandoned), the Pro-only gate, key custody, and the lack of an explicit third-party-app agreement.

---

### 3. MyFitnessPal: BLOCKED

**Sources**
- https://www.myfitnesspal.com/api redirects to https://myfitnesspalapi.com/
- Terms of Service, https://www.myfitnesspal.com/terms-of-service. "Effective Date: March 18, 2025"

**(a) Access.** None for new developers. The API site says verbatim: "We are not accepting requests for API access at this time." The only other route is a "Licensing" mailto: partners@myfitnesspal.com.

**(b) AI clauses.** None apply, since there is no API to use. The ToS AI language covers MFP's own AI features only.

**(c) Other blockers.** ToS "No Scraping": "You may not engage in data mining or similar data gathering or extraction activities or retrieve data or content from the Services by accessing, monitoring, or copying any Content or information using automated means…". This rules out scraping or unofficial clients.

**(d) Verdict: BLOCKED** for direct integration. A partner licence is the only official path. UNVERIFIED: MFP writes nutrition data into Apple Health and Health Connect, which would let Waldo read it indirectly under the platform rules in section 6. I could not confirm this because MFP's help centre returned 403.

---

### 4. Garmin Connect Developer Program / Health API: UNKNOWN (likely OK with conditions for inference only, and requires approval)

**Sources**
- Program overview, https://developer.garmin.com/gc-developer-program/overview/. Gives tiers; no dates beyond "©2026".
- Personal API page, https://developer.garmin.com/gc-developer-program/personal/personal-api/
- Garmin Connect Developer Program Agreement (Garmin International, US), https://developerportal.garmin.com/sites/default/files/Garmin%20Connect%20Developer%20Program%20Agreement.pdf. FRM-0952 Rev. B. PDF created 2023-10-04. It has no AI clause.
- Same agreement for the Garmin China Shanghai RHQ entity, https://www8.garmin.com/en-US/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT/GARMINCONNECTDEVELOPERPROGRAMAGREEMENT_EN.pdf. FRM-0952 Rev. B. PDF created 2026-03-03. It has an AI clause.

**(a) Access.** Three tiers:
- **Personal** ("Secure access to your own Garmin Connect data for individuals"). Uses a personal API key from Garmin Connect web plus an access-token exchange. Pull only. Its terms are a separate click-through I could not read. `[inference]` It is not meant for serving other users.
- **Business Starter** ("Apply … create an app with Starter Access"). Push only, "Historical Data: Not included", "User Capacity: Limited".
- **Enterprise**. Push or Ping/Pull, 1 month+ of history, unlimited users, "commercial terms are tailored".

Business access uses per-app client credentials and the user's consent. The overview page does not name the OAuth version.

**(b) AI clauses**
- US agreement (2023 PDF): no AI or ML clause.
- China-entity agreement (2026 PDF), §15.10: "Licensee's Privacy Policy shall include a conspicuous artificial intelligence transparency statement (the "AI Transparency Statement") if End User Data will be used for training with, or processing by, artificial intelligence systems. The AI Transparency Statement shall: a. Clearly inform End Users of the nature and purpose of any processing or training by artificial intelligence systems; and b. Comply with any legal or regulatory obligations … including mechanisms for (i) obtaining explicit consent from each End User before initiating any processing of End User Data; (ii) allowing End Users to withdraw such consent easily at any time; and (iii) updating to reflect changes in applicable laws, regulations, or Garmin policies." §15.7 lets Garmin audit compliance with "the artificial intelligence transparency requirements".
- **UNVERIFIED:** secondary coverage (the5krunner 2026-10-14, openwearables.io 2026-10-23, notebookcheck) reports three things. First, that Garmin paused new applications for most of 2026 and reopened on 2026-10-21. Second, that a revised agreement bans using Garmin data to train or improve your own AI models and bars sharing data with services Garmin has not approved in writing. Third, that Enterprise fees start 2027-04-01. I could not get the current global agreement text, which is a click-through inside the developer portal. None of these sources quotes the clause.

**(c) Other restrictions (US agreement, verbatim)**
- §5.3(o): no making the API available "…developing a Licensee application programming interface to provide End User Data to third-party websites, software applications, platforms, services, or products that have not been approved by Garmin in writing".
- §5.3(q): no "combine or integrate the API with any software, technology, services, or materials, unless authorized (i) herein or (ii) by Garmin in writing".
- §5.3(e): no deriving income from the API "without Garmin's prior written permission".

`[inference]` Read together, (o) and (q) mean sending Garmin data to an external LLM provider should be disclosed to Garmin and approved in writing.

**(d) Verdict: UNKNOWN.** Program admission is required. If the reported 2026 revision holds, inference-only use for the consenting user, with an AI transparency statement and Garmin's written approval of the LLM subprocessor, is the most plausible permitted path. Training on Garmin data is out. Ask Garmin to confirm in writing before building.

---

### 5a. Oura API v2: BLOCKED via REST API. Conditional via Oura MCP Server only.

**Sources**
- "Oura API and MCP Agreement", https://cloud.ouraring.com/legal/api-agreement. "Effective date: June 8, 2026". Supersedes the 2021 agreement.
- API docs, https://cloud.ouraring.com/v2/docs (openapi-1.43.json)
- Auth docs, https://cloud.ouraring.com/docs/authentication

**(a) Access.** OAuth2 authorization code flow, with PKCE recommended. "Please note that personal access tokens were deprecated in December 2025 and are no longer available for use." "API Applications are limited to **10** users before requiring approval from Oura." Two-layer rate limits (per token and per app). A 403 can mean "the user's Oura subscription has expired", so a membership is effectively required.

**(b) AI clauses (verbatim)**
- §4(d): "To the extent you seek to use any Oura Data or User Data in connection with a large language model, you may (unless you are an Aggregator) access and process such Oura Data or User Data **solely through the MCP Server** subject to the provisions of this Agreement. You shall not use, and shall not permit any third party to use, the Oura API to develop, train, fine-tune, evaluate, **prompt, or otherwise provide input or data to any AI Model or AI Platform**."
- Definition: "AI Model(s)" means "any artificial intelligence system, machine learning model, neural network, large language model, or other computational intelligence system."
- §4(a) Prohibited Uses (absent Oura's prior written consent):
  - (iii) "training, fine-tuning, developing, or improving any AI Model or AI Platform …"
  - (iv) "creating or modifying any AI Model weights, parameters, embeddings, or persistent representations"
  - (xx) "aggregating, caching, or storing geographic location information or other User Data accessible via the Oura API or MCP Server."
- §4(c): "the foregoing Prohibited Uses shall apply regardless of whether a User has purportedly consented to any such use".
- §2(b): any third-party AI Model or Platform used must be "bound by written terms and conditions that are no less protective of the Company, its Users, User Data, Oura Data, and Oura Intellectual Property than the terms set forth in this Agreement". You indemnify Oura for that third party's breaches.
- §3(m): "Unless and until you are authorized to do so by the Company in a separate written agreement or consent, you shall not store or cache any data accessed or obtained through the MCP Server."

**(c) Other restrictions**
- §5(g) restricts use to a function "directly relevant to the Authorized Purpose".
- §4(a)(v) bars combining with other data to build "any database, dataset, application, or software that includes information about any User without first obtaining User Consent".
- §4(d)–(e) lets Oura revoke access for any app "not providing added benefit to Users and/or … not in the best interests of Oura".
- UNVERIFIED: the MCP Server onboarding process, endpoint and eligibility. I found no public quickstart.

**(d) Verdict: BLOCKED** for the planned architecture (REST API feeding an LLM, with stored data). **Conditional** path: Oura's MCP Server, with no storing or caching unless Oura signs a written agreement, a flow-down agreement with the LLM provider, and no training or embeddings. The no-storage rule conflicts with keeping a persistent daily-plan memory.

### 5b. WHOOP API: UNKNOWN (high risk; get written clarification)

**Sources**
- WHOOP API Terms of Use, https://developer.whoop.com/api-terms-of-use/. "Effective Date: October 6, 2026"
- App approval, https://developer.whoop.com/docs/developing/app-approval/

**(a) Access.** OAuth 2.0 public API. "Every new app starts on the Sandbox tier, which allows up to 10 WHOOP members to connect." Higher tiers need manual review, plus "at least 50% of your current tier's member limit to be connected".

**(b) AI clause (verbatim, §4 "Prohibitions on WHOOP Data")**
- "Unless expressly authorized by the WHOOP Data owner or by applicable law, Company will not … Use any API or WHOOP Data to create, develop, test, train, fine-tune or improve any large language model or any other machine learning or artificial intelligence model, **application, or system**".
- `[inference]` Runtime inference is not named, unlike Strava and Oura. But "create, develop, test … any … artificial intelligence … application" read literally covers building and testing Waldo with WHOOP data.
- `[inference]` "WHOOP Data owner" is ambiguous. It could mean the end user, which would allow a consent-based carve-out, or WHOOP.

**(c) Other restrictions (verbatim)**
- "Expose WHOOP Data to other users or to third parties without explicit opt-in consent".
- "Scrape, build databases, or otherwise create permanent copies of WHOOP Data, or keep cached copies longer than permitted by the cache header".
- "Copy, translate, modify, create a derivative work of, sell, lease, lend, convey, distribute, publicly display, or sublicense WHOOP Data to any third party".
- §3: "Use the APIs to offer, solicit, obtain, or provide any medical, legal, or other professional advice".
- §3: no medical-device features.
- §3: "Use any API Materials to compete, directly or indirectly, with WHOOP" (WHOOP ships its own AI coach).
- §2: data "encrypted (in transit and at rest)".

**(d) Verdict: UNKNOWN, high risk.** The literal text arguably covers an AI application. Permanent copies are banned, and passing data to an LLM provider may count as "convey/distribute to any third party". Ask WHOOP in writing before integrating.

---

### 6. Platform health stores

### Apple HealthKit: OK with conditions
**Sources**
- App Review Guidelines, https://developer.apple.com/app-store/review/guidelines/. "Last Updated: October 16, 2026"
- Apple Developer Program License Agreement §3.3.3(H), https://developer.apple.com/support/terms/apple-developer-program-license-agreement/. No version date shown; read 2026-11-06, and its latest dated attachment is effective 2026-10-31.

**(a) Access.** On-device framework. Per-type user authorization. No server API.

**(b) AI and third-party clauses (verbatim)**
- Guideline 5.1.2(i): "You must clearly disclose where personal data will be shared with third parties, **including with third-party AI**, and obtain explicit permission before doing so."
- Guideline 5.1.2(vi): HealthKit data "may not be used for marketing, advertising or use-based data mining, including by third parties."
- Guideline 5.1.3(i): "Apps may not use or disclose to third parties data gathered in the health, fitness, and medical research context—including from the … HealthKit API … for advertising, marketing, or other use-based data mining purposes other than improving health management, or for the purpose of health research, and then only with permission." Also: "You must disclose the specific health data that you are collecting from the device."
- DPLA §3.3.3(H): "may not use the HealthKit APIs … or any information obtained through [them] for any purpose other than providing health, motion, and/or fitness services in connection with Your Application". "You must not use these APIs, or any information obtained through these APIs, to disclose or provide an end user's health, motion, fitness … information to a third party without prior express end user consent, and then only for purposes of enabling the third party to provide health, motion, fitness … services as permitted herein."

**(c) Other.** Guideline 5.1.3(ii): apps "may not store personal health information in iCloud". The app's purpose must be "clearly evident in Your marketing text and user interface".

**(d) Verdict: OK with conditions.** Requirements: an explicit in-app disclosure naming the third-party AI provider, explicit permission, health and fitness purpose only, no ads or data-mining, and no PHI in iCloud.

### Android Health Connect (Google Play policy): OK with conditions
**Sources**
- Play policy "Permissions and APIs that Access Sensitive Information", Health Connect section, https://support.google.com/googleplay/android-developer/answer/9888170
- "Android Health Permissions: Guidance and FAQs", https://support.google.com/googleplay/android-developer/answer/12991134

Neither page shows an effective date. Both were read 2026-11-06 ("©2026").

**(a) Access.** On-device permissions. Health permissions must be declared in Play Console and pass review.

**(b) AI and third-party clauses.** No clause names AI or ML. The FAQ mentions AI only to say that "Apps (especially AI Agents and multi-purpose tools) that support a wide range of data sources, should use the Matchmaking API to detect available data sources on the device before requesting access". Limited Use (verbatim):
- "Data use should be limited to providing or improving the appropriate use case or features visible in the application's user interface."
- "User data may only be transferred to third parties with explicit user consent: for security purposes (for example, to investigate abuse), to comply with applicable laws or regulations, or as part of mergers/acquisitions."
- "Human access to user data is restricted unless explicit user consent is obtained…"
- "All other transfers, uses, or sale of Health Connect data is prohibited, including: Transferring or selling user data to third parties like advertising platforms, data brokers, or any information resellers…"

The FAQ also lists as forbidden: "Sharing health data with third parties without explicit, informed user consent."

**(c) Other.** No medical-device use without regulatory clearance. No headless apps. "Do not use Health Connect with apps that sync data between incompatible devices or platforms." Minimum-scope permissions. A privacy policy covering third-party sharing is required.

**(d) Verdict: OK with conditions.** Requirements: explicit informed consent for sending data to the LLM provider, use limited to visible user-facing features, and Play health-permission declaration approval. `[inference]` The Limited Use transfer sentence lists only security, legal and M&A purposes. Whether a consented transfer to an LLM processor fits that sentence, or relies on the FAQ's consent-based allowance, is ambiguous. Confirm during the Play declaration review.

---

### Summary table

| Provider | (a) Individual-data API / auth | (b) AI clause (effective date) | (c) Key other blockers | (d) Verdict |
|---|---|---|---|---|
| Strava | Yes. OAuth. 1 → 10 athletes self-serve, more needs review. Strava subscription for Standard Tier | Policy §5.3 bans "operation of any AI Application" incl. "ingestion into a context window"; §5.10 no transfer to "AI Application providers … even if a user … consents" (eff. 2026-06-01) | 7-day cache max, no persistent index, no combining with other data, no competing | **BLOCKED** |
| Hevy | Yes, Pro only. Per-user `api-key` header, no OAuth | None found (T&Cs eff. 2019-06-23; API v0.0.1) | Beta, "may … abandon", no third-party-app agreement, long-lived key custody | **OK with conditions** |
| MyFitnessPal | No: "We are not accepting requests for API access at this time" | n/a | ToS (eff. 2025-03-18) bans scraping/automated extraction | **BLOCKED** |
| Garmin | Personal key (own data only) or Business Starter/Enterprise via application | US agreement (2023): none. China-entity 2026 §15.10: AI transparency statement + explicit consent. Reported 2026 global revision banning AI training: UNVERIFIED | Written approval to pass data to third-party services or combine with other tech; Starter push-only, limited users | **UNKNOWN** (lean OK with conditions, inference only) |
| Oura | Yes. OAuth2 only (PATs gone Dec 2025). 10 users before approval | §4(d): LLM use "solely through the MCP Server"; API may not "prompt, or otherwise provide input … to any AI Model" (eff. 2026-06-08) | MCP data may not be stored/cached without written agreement; no embeddings; flow-down terms on LLM vendor | **BLOCKED** (API); conditional via MCP |
| WHOOP | Yes. OAuth 2.0. Sandbox 10 members | §4: no using data to "create, develop, test, train, fine-tune or improve any … AI model, application, or system" (eff. 2026-10-06) | No permanent copies, no conveying data to third parties, no medical advice, no competing | **UNKNOWN** (high risk) |
| Apple HealthKit | On-device, per-type user auth | Guideline 5.1.2(i): disclose and get explicit permission for sharing "with third-party AI" (Guidelines updated 2026-10-16) | Health/fitness purpose only; third-party only with express consent for health services; no PHI in iCloud | **OK with conditions** |
| Android Health Connect | On-device, Play-declared permissions | No AI clause. Limited Use: transfers only with explicit consent; use limited to visible features (no date shown) | No ads/brokers, not a medical device, minimum scope | **OK with conditions** |

### Not verified from primary sources
- The current Garmin global/US developer agreement text, including the reported Oct 2026 AI and third-party-sharing revision and Enterprise pricing.
- The Garmin Personal tier click-through terms.
- How Oura MCP Server onboarding works.
- Whether Hevy has any developer agreement beyond its 2019 consumer T&Cs.
- Whether MyFitnessPal writes data to HealthKit or Health Connect.
- An effective date for the Health Connect policy pages and the Apple DPLA version date.

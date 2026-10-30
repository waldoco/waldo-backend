# What a personal assistant does, and what Waldo should observe, remember and do (30 October 2026)

This is research for [`WALDO_MEMORY_REDESIGN_2026-10-30.md`](../proposals/WALDO_MEMORY_REDESIGN_2026-10-30.md). It
grounds that doc's life areas (§5) and its real-time memory (§6) in sources: what human executive and personal assistants
do, how days differ across people, and the psychology underneath.

**Sources.** Every claim cites a primary or high-trust source:
- government occupational and time-use data (O\*NET, BLS);
- official health bodies (NIOSH, CDC);
- peer-reviewed papers.

**Tags.**
- **[unverified]** means the source was seen only in search snippets, or its page could not be opened.
- **[inference]** marks a design implication drawn from a source. Implications are ours, not the sources'.

The reading was done on 30 Oct 2026 by two research passes. The URLs opened are listed at the end.

## 1. What a human executive or personal assistant does

**Calendar, inbox and gatekeeping**
- O\*NET 43-6011.00, *Executive Secretaries and Executive Administrative Assistants*, lists 23 task statements. The core
  ones are:
  - managing and maintaining executives' schedules;
  - making travel arrangements;
  - opening, sorting and distributing correspondence, email included;
  - preparing responses to routine inquiries;
  - deciding whether visitors "should be given access to specific individuals". That last one is gatekeeping in the
    occupation's own words.
- BLS describes executive assistants as giving "high-level support". Their work goes beyond clerical tasks to reviewing
  incoming documents, doing research and preparing reports.

**Anticipation and briefing**
- O\*NET tasks include:
  - reading incoming memos and reports "to determine their significance" and planning their distribution;
  - preparing agendas and arranging meetings;
  - researching and compiling data and preparing papers for executives;
  - recording and distributing minutes.

**Relationships and acting for the principal**
- O\*NET tasks include meeting individuals and groups "on behalf of executives". Its top work activities include building and
  maintaining relationships, and organising, planning and prioritising.
- In O\*NET's work-context data, 73% report "a lot of freedom" to set tasks and priorities, 97% use email every day, and
  80% are in constant contact with others. The role runs on delegated judgment.

**Keeping the record**
- In Bandiera, Prat, Hansen and Sadun, the CEO's personal assistant logged every activity of 15 minutes or more for one
  week. The diaries cover 1,114 CEOs. *CEO Behavior and Firm Performance*, *Journal of Political Economy* 128(4), 2020.
  [the diary design was seen in working-paper snippets; the paper itself was not opened]

**How an assistant learns a principal: no primary source found**
- No government or peer-reviewed source describes how an EA learns a principal's preferences, routines and people over
  time, and O\*NET has no task for it.
- The IAAP *CAP Body of Knowledge* (six domains, including organisational culture and meeting management) was seen only in
  snippets. [unverified]
- **Design consequence [inference].** Waldo's learning loop has to be specified from the psychology in §3 and from its own
  evals, not copied from a documented human practice.

## 2. How days differ

| Archetype | What structures the day | Source | What an assistant watches [inference] |
|---|---|---|---|
| Founder or executive | Meetings. CEO diaries split into "leaders" (multi-function, high-level meetings) and "managers" (one-to-one meetings on core functions). | Bandiera et al. 2020 | Meeting load and mix; protected time for the principal's main agenda |
| Salaried employee | Full-time workers worked 8.1 hours on days they worked. 30% worked on an average weekend day; 35% worked at home some of the time on days they worked. 57% can vary their start and end times. | BLS ATUS 2025 (released 25 Jun 2026); BLS *Job Flexibilities* 2024–25 (released 24 Sep 2026) | Real start and end times, not an assumed 9-to-5; weekend work |
| Shift worker | 15% of wage and salary workers usually work outside daytime hours. NIOSH counts any schedule outside 7am–6pm as shift work. Night workers report insomnia at 18.5% (day workers 8.4%) and excessive sleepiness at 22.3% (16.2%). NIOSH advises night shifts no longer than 8 hours and a nap before a night shift. | BLS *Job Flexibilities*; NIOSH nurse training module 1; NIOSH Science Blog, *Shift Work and Sleep*, 2016 | The rotation; sleep windows that move; when it is safe to send anything |
| Clinician | Nurses often work 12-hour shifts in compressed weeks. Physicians' average week fell from 54.9 hours (1996) to 51.0 (2008). Residents are capped at 80 hours a week, averaged over 4 weeks. | NIOSH module 1; Staiger, Auerbach and Buerhaus, *JAMA* 2010;303(8):747–753; ACGME Common Program Requirements 2026 [unverified] | Long blocks with no reachable windows; recovery days |
| Student | 50% of college students report daytime sleepiness and 70% insufficient sleep. Late chronotypes and social jet lag peak up to about age 25. | Hershner and Chervin, *Nat Sci Sleep* 2014;6:73–84; Wittmann et al. 2006 | Class times, deadlines, weekday versus weekend sleep |
| Parent of young children | Adults living with children under 6 spend 2.3 hours a day on primary childcare (women 2.8, men 1.7; employed 1.7, not employed 3.3). | BLS ATUS 2025 | School and daycare windows; broken nights |
| Creative or freelancer | No primary source found. The nearest: 24% of non-daytime workers say their schedule is a personal preference. | BLS *Job Flexibilities* | Self-set hours; irregular weeks [unsupported by a primary source] |
| Frequent traveller | The body clock adapts about 1.5 hours a day westward and about 1 hour a day eastward. Morning light helps eastward travel, evening light westward. For trips under about 2 days, stay on home time. | Riedy and Williams, *Jet Lag Disorder*, CDC Yellow Book 2026 | Time zone on each day of a trip; when the owner's clock has caught up |

**Chronotype and social jet lag**
- People differ widely in preferred sleep timing, and the difference is mainly the body clock. Chronotype varies with age
  and sex (Munich ChronoType Questionnaire, more than 55,000 respondents). Roenneberg et al., *Epidemiology of the human
  circadian clock*, *Sleep Med Rev* 2007;11(6):429–438.
- **Social jet lag** is the mismatch between social time and biological time. Late chronotypes build sleep debt over the
  working week. Wittmann, Dinich, Merrow and Roenneberg, *Chronobiol Int* 2006;23(1–2):497–509.
- Social jet lag is associated with higher BMI beyond sleep duration. This is cross-sectional data from a self-selected
  online sample. Roenneberg et al., *Curr Biol* 2012;22(10):939–943. The share of people with an hour or more of social jet
  lag (often cited as about two thirds) was seen only in snippets [unverified].

**Design consequence [inference].** The evidence supports watching the person's own clock instead of a 9-to-5 default. It
favours:
- learning when *this* owner works, sleeps and can be reached;
- knowing their time zone on each day;
- treating a regular routine as information the model reasons with, not a rule code applies.

## 3. The psychology underneath

| Topic | Finding | Source | Implication for Waldo [inference] |
|---|---|---|---|
| Implementation intentions | An if-then plan for when, where and how to act has a medium-to-large effect on reaching a goal: d = .65 across 94 tests. It works because the cue becomes easier to notice and the response becomes automatic. A 2025 synthesis of 642 tests finds d = .27 to .66, depending on the outcome. | Gollwitzer and Sheeran 2006, *Adv. Exp. Soc. Psychol.* 38:69–119; Sheeran, Listrom and Gollwitzer 2025, *Eur. Rev. Soc. Psychol.* 36:162–194 [search only]; Gollwitzer 1999, *Am. Psychol.* 54:493–503 [search only] | When the owner states an intention, help them turn it into a when-then plan tied to a cue Waldo can observe. Then bring it up when the cue happens. |
| Open loops | **Contested.** A 2025 meta-analysis finds no memory advantage for unfinished tasks (the Zeigarnik effect). It does find a tendency to resume them (the Ovsiankina effect). Unfinished goals cause intrusive thoughts and worse performance on other tasks, and writing a specific plan removes those effects. | Ghibellini and Meier 2025, *Humanities and Social Sciences Communications* 12; Masicampo and Baumeister 2011, *JPSP* 101(4):667–683 (same lab as ego depletion: promising, not settled) | Remembering an open loop does not quiet it. Planning it does. So the backlog closes loops by planning them, and makes interrupted work easy to resume. |
| Working memory | People hold about 4 chunks, not 7. | Cowan 2001, *Behav. Brain Sci.* 24:87–114 | Waldo shows about 4 new items or fewer at once. This is why the Close card offers at most 3 candidates. |
| Prospective memory | People remember to do something later either by monitoring, which costs capacity, or by retrieval when a cue appears. | Einstein and McDaniel 2005, *Curr. Dir. Psychol. Sci.* 14:286–290 [search only] | Waldo carries the monitoring. Intentions attach to real events, not to the owner's vigilance. |
| Cognitive load | Means-ends problem solving overloads working memory. | Sweller 1988, *Cognitive Science* 12:257–285 [search only] | Give the next step, not the whole tree. |
| Allostatic load | Stress mediators protect in the short term and wear the body when chronic. Chronic sleep loss acts as a stressor that adds to that load. | McEwen 1998, *NEJM* 338:171–179 (concept only); McEwen 2006, *Metabolism* 55 Suppl 2:S20–23 | Treat recovery as part of the plan. Lighten the day after poor sleep, **only from health the owner shared**. Missing data is never read as high or low load (CLAUDE.md, ADR-0081). |
| Self-determination | Competence, autonomy and relatedness raise motivation and well-being. Threats, imposed deadlines and directives lower intrinsic motivation; choice and self-direction raise it. Evidence on controlling versus autonomy-supportive message wording is mixed. | Ryan and Deci 2000, *Am. Psychol.* 55:68–78 | Offer choices with reasons, let the owner decline, never invent deadlines. Supports the `people` area (relatedness) and the `goals` area (autonomy and competence). |
| Habits | Habits are cued by context and change slowly. Average time to automaticity is about 66 days, ranging from 18 to a projected 254. Missing one day barely matters. | Wood and Neal 2007, *Psychol. Rev.* 114:843–863; Lally et al. 2010, *Eur. J. Soc. Psychol.* (figures via the BPS Research Digest; primary paper returned 403) | Anchor routines to stable cues, expect months, and never treat a missed day as failure. |
| Decision fatigue | **Not supported.** A preregistered replication across 23 labs (N = 2,141) found d = 0.04, CI including zero. A second across 36 labs found d ≈ 0.06. | Hagger et al. 2016, *Perspect. Psychol. Sci.* 11:546–573; Vohs et al. 2021, *Psychol. Sci.* 32:1566–1581 [search only] | Do not model a "willpower budget". Workload, interruptions and sleep are the levers with evidence behind them. |
| Interruptions | Interrupted email work finished faster but raised stress and frustration (stress 6.92 → about 9.3 on a 20-point scale). The widely quoted "23 minutes to resume" is not in this paper. Notifications delivered at task breakpoints reduced frustration, for about 1.5 minutes of delay. How disruptive a notification feels depends on the task and the sender. | Mark, Gudith and Klocke 2008, *CHI* 107–110; Iqbal and Bailey 2008, *CHI* 93–102; Mehrotra et al. 2016, *CHI* | Batch non-urgent messages for natural breaks. Every push costs stress, even a useful one. |

## 4. The help taxonomy

Each cluster is a kind of help a human assistant gives. For each cluster, the table says what Waldo observes, what it
remembers, and what it does, and which life area the memory mainly lands in (the memory doc, §5).
- "Does" stays inside Waldo's existing authority: reading, drafting, reminding and proposing. Effects go through the
  existing approvals.
- What Waldo observes is limited to what the owner has connected.

| # | Cluster | Grounding | Observes | Remembers | Does | Area |
|---|---|---|---|---|---|---|
| H1 | **Calendar stewardship and gatekeeping** | O\*NET (schedules; deciding who gets access); Bandiera et al. | Calendar changes and invites (push or sweep) | Protected times, meeting preferences, who gets priority | Flags conflicts; proposes holds and declines as approvals; guards focus blocks | `work`, `home` |
| H2 | **Inbox triage and correspondence** | O\*NET (sort correspondence; judge significance; routine replies) | New mail (`observed_mail`, update cards) | Who matters, reply norms, threads the owner is waiting on | Surfaces what is significant; drafts replies for approval; tracks reply debts | `work`, `people` |
| H3 | **Briefing and anticipation** | O\*NET (agendas, papers, research) | Upcoming events and their people | Context per person and recurring meeting | Prepares a brief before the meeting (`event-briefs`); says what changed | `work`, `people` |
| H4 | **Logistics and travel** | O\*NET (travel arrangements); CDC Yellow Book | Bookings, location and time zone per day | Travel preferences; how this owner handles jet lag | Plans arrival days around the body clock; time-zone-aware reminders | `home`, `body` |
| H5 | **Follow-through on commitments** | Masicampo and Baumeister; Ghibellini and Meier; #1587 | Promises in chat and mail | The backlog (`loops`), with check times | Turns each item into a when-then plan; checks back at the cue; carries over at the Close without guilt | all |
| H6 | **Remembering-to** | Einstein and McDaniel; Gollwitzer | Cues: time, place, an event, a person | Intentions bound to cues | Reminds at the cue, not on a guess | all |
| H7 | **Protecting energy and focus** | Mark et al.; Iqbal and Bailey; Cowan | Meeting density, interruptions, sleep (if shared) | Chronotype, focus windows, when the owner can be reached | Batches non-urgent messages for breaks; at most about 4 new items at once; suggests a lighter day after a short night (shared data only) | `mind`, `body` |
| H8 | **Body and recovery** | McEwen; NIOSH; Roenneberg et al. | Health the owner shares (live, ADR-0081) | Patterns in words, never readings | Plans recovery into the day; notices trends; is honest when data is missing | `body` |
| H9 | **Relationships** | Ryan and Deci (relatedness); O\*NET (relationships) | People in mail, calendar and chat | Who each person is to the owner; birthdays; what they care about | Remembers dates; suggests reaching out; preps before seeing someone | `people` |
| H10 | **Goals and habits** | Gollwitzer and Sheeran; Wood and Neal; Lally et al.; Ryan and Deci | Progress the owner mentions; routine cues | Goals (claims of kind `goal`); routines and their cues | Helps form when-then plans; anchors routines to cues; never shames a missed day | `goals`, `body` |
| H11 | **Money admin** | O\*NET (expenses); open loops | Bills, renewals and subscriptions in mail | Due dates and recurring costs, never credentials | Reminds before due dates; flags renewals | `money` |
| H12 | **Learning the principal** | No primary source (§1). The design's own loop. | Every correction, confirmation and refusal | Preferences about how Waldo works | Asks a small question at a natural moment; never treats memory as permission | all |

**Cross-cutting principles** (from §2 and §3) [inference]:
1. **The owner's own clock.** Watch their actual hours and time zone, not a 9-to-5 default. 15% of workers are off-daytime, and chronotypes vary widely.
2. **Plan, don't just remember.** An open loop quiets once it has a when and a how.
3. **Carry the monitoring.** Bind intentions to cues Waldo can see.
4. **Choices, not directives.** Give the reason and let the owner decline.
5. **Few at a time, at breaks.** About 4 new items at most, delivered when it costs least.
6. **Shared health only.** Never infer load from missing data.
7. **No willpower model.** It did not replicate.

## Sources opened

- O\*NET OnLine 43-6011.00 — https://www.onetonline.org/link/summary/43-6011.00
- BLS Occupational Outlook Handbook, Secretaries and Administrative Assistants — https://www.bls.gov/ooh/office-and-administrative-support/secretaries-and-administrative-assistants.htm
- BLS American Time Use Survey 2025 — https://www.bls.gov/news.release/atus.nr0.htm
- BLS Job Flexibilities and Work Schedules 2024–25 — https://www.bls.gov/news.release/flex2.nr0.htm
- NIOSH, Training for Nurses on Shift Work and Long Work Hours, modules 1 and 2 — https://www.cdc.gov/niosh/work-hour-training-for-nurses/longhours/mod1/01.html
- NIOSH Science Blog, *Shift Work and Sleep* (2016) — https://www.cdc.gov/niosh/bulletin/2016/shift-work.html
- CDC Yellow Book 2026, *Jet Lag Disorder* — https://www.cdc.gov/yellow-book/hcp/travel-air-sea/jet-lag-disorder.html
- Wittmann et al. 2006 — https://pubmed.ncbi.nlm.nih.gov/16687322/
- Cowan 2001 — PubMed 11515286
- McEwen 1998 — PubMed 9428819 (no abstract); McEwen 2006 — PubMed 16979422
- Masicampo and Baumeister 2011 — PubMed 21688924
- Wood and Neal 2007 — PubMed 17907866
- Ryan and Deci 2000 — PDF, pp. 68–70
- Gollwitzer and Sheeran 2006 — KOPS repository record
- Ghibellini and Meier 2025 — RePEc abstract
- Hagger et al. 2016 — Massey repository record; Dang 2016 — PMC4971805
- Mark, Gudith and Klocke 2008 — full PDF; Iqbal and Bailey 2008 — PDF p.1; Mehrotra et al. 2016 — PDF p.1
- Lally et al. 2010 — via the BPS Research Digest (primary paper returned 403)
- Europe PMC records: Roenneberg 2007, Roenneberg 2012, Hershner and Chervin 2014, Staiger et al. 2010, Sack et al. 2007

**Not opened (cited as [unverified] or [search only] above):**
- Bandiera et al. 2020 (working-paper snippets)
- the IAAP CAP Body of Knowledge (403)
- the ACGME 2026 PDF
- AASM pages (blocked)
- Gollwitzer 1999; Sheeran et al. 2025; Sweller 1988; Einstein and McDaniel 2005; Vohs et al. 2021

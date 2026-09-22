# Jev-assisted Hyper Computer Use: bounded research

Reviewed 2026-09-21. Research only; no app wiring or native actions.
The research agent used mocks; the parent later ran three explicitly authorized
synthetic API calls using a temporary in-memory credential. Builds on
[the existing proposal](jev-for-bunji.md).
“Hyper Computer Use” is a proposed Bunji feature name here, not a verified TypeSafe
product or a measured speed claim.

## Finding

Jev is plausible as an optional selector among a small set of observed AX elements.
It is not the planner, screenshot reader, permission authority, or native executor.
The current model should retain task planning, generated text, and visual reasoning.
TypeSafe describes typed decisions over supplied state rather than generated prose.
[Official introduction](https://docs.typesafe.ai/introduction)

The documented HTTP contract uses `POST https://api.typesafe.ai/v1/systemone`,
Bearer authentication, `state`, `model`, and named `questions`. A Choice question
has instructions and a criteria map; its answer contains choice, probabilities,
and confidence. The response also has a resolved model and input/output token usage.
The harness uses `jev-latest`, one question, local candidate aliases, and `none`.
Only text/structured state is documented here; no image payload or vision endpoint
is assumed. The docs describe automatic SDK retries, so this experiment uses fetch
without retries to avoid duplicate spend.
[Official API reference](https://docs.typesafe.ai/api)

Confidence summarizes the probability distribution; it is not an authorization or
proof of correctness. The experiment requires confidence >= 0.8, winning probability
>= 0.85, and a runner-up margin >= 0.2. These are provisional gates, not calibrated
operating thresholds. Tune on a development set and freeze before held-out testing.
[Official confidence guide](https://docs.typesafe.ai/confidence)

TypeSafe documents weaknesses around adversarial content, irrelevant context,
indirection, and numeric precision. Narrow state and deterministic validation help,
but cannot establish semantic correctness. Test confident wrong answers explicitly.
[Official Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Delivered experiment

Files live only in `experiments/jev-hyper-use/` and this new document. Node >=22.13;
no dependencies, native helper launch, filesystem input, screenshots, or app content.

```sh
node --test experiments/jev-hyper-use/harness.test.mjs
node experiments/jev-hyper-use/evaluate.mjs
```

`prepare` validates a user objective, frame ID, and observed candidate records.
It projects only label, role, and enabled state into the request. Gold labels,
native IDs, permission fields, screenshots, and unknown fields are excluded.
Model output maps back to a host-held ID and frame; arbitrary IDs, action commands,
or permission claims cannot become executable output. The return type is a
candidate recommendation or abstention. There is deliberately no execution function.

The normalized `enabled` boolean is a synthetic harness field, not a claim that
the current bridge exposes it. A future trusted adapter must derive actionability
from native evidence, or exclude candidates whose actionability is unknown. Do not
let a model supply or override that value. The existing bridge's observed records
contain id/role/label/optional value; this harness is not a drop-in bridge adapter.

Bounds: 20 candidates; objective 1,000 UTF-16 units; IDs/roles 128; labels 256;
16 KiB UTF-8 request; 32 KiB streamed response; 5 seconds across headers and body.
The CLI permits one synthetic case per explicit live invocation. The library defaults
to one attempt and rejects configured budgets above three attempts per client.
Attempts are charged before sending, even if they fail; no automatic retry.
Redirects are rejected and the origin/path are fixed. Errors return fixed categories,
never server bodies, exception messages, headers, or credentials. Token counts are
separate input/output fields; unavailable/cache-read usage is null, not zero.
Returned model metadata is restricted to the Jev identifier format.

These are per-process request/byte limits, not a dollar ceiling or cross-process
quota. Timeout can leave a request already billed. Unknown usage after timeout/error
must stay unknown; do not treat it as free or retry automatically.

## Measured offline results

The baseline selects a unique enabled candidate whose label occurs in the objective.
It is a deliberately simple local heuristic, **not Bunji's current model or Jev**.
Sixteen hand-labelled synthetic smoke cases include missing/duplicate/disabled
targets, unseen visual context, injection-like labels, synonyms, negation, substring
overlap, quoted instructions, and permission explanations. No held-out benchmark
or threshold fitting was performed.

| Measure | Result |
| --- | --- |
| Correct, including expected abstentions | 11/16 (68.75%) |
| Abstentions | 8/16 (50%) |
| Selection coverage | 8/16 (50%) |
| Correct among selections | 5/8 (62.5%) |
| Selections when gold label requires abstention | 3 |

The five misses are synonym and substring cases (unnecessary abstention), plus
negation, permission explanation, and quoted instructions (incorrect selections).
The three incorrect selections are recommendations only; nothing was executed.
These failures motivate semantic evaluation but do not show that Jev fixes them.

All 13 deterministic tests passed. They cover baseline counts, request projection
and limits, frame/ID mapping, uncertainty/disabled/none gates, malformed answer
distributions, default no-network/no-env-read behavior, mocked live success and
budgets, missing key, redacted HTTP/transport/parse failures, streamed size limits,
timeouts before headers and during body reads, and separate usage fields. Mock
responses prove adapter behavior only, not service compatibility or model quality.

## Live API smoke results

Three synthetic requests passed against resolved model `jev-1.13.0`:

| Case | Result | Latency | Input | Output |
| --- | --- | --- | --- | --- |
| Save draft | Selected the correct candidate | 515 ms | 476 | 41 |
| Duplicate Save controls | Abstained | 359 ms | 474 | 40 |
| Do not press Delete; wait | Abstained | 157 ms | 426 | 32 |

Total: 1,376 input and 113 output tokens. Cache-read and dollar cost are unavailable.
No retries, screenshots, Notes content, or real user conversations were sent.
The key was received through non-echoing process input and discarded on process exit;
it is not a project file or saved Bunji credential. These three hand-picked cases
prove API compatibility only, not production reliability, calibrated thresholds,
or an improvement over the existing model. Broader held-out evaluation remains.

## Future experimental Settings toggle

Proposed wording: **Jev-assisted computer use (experimental)**. Default off. Explain
that enabling it sends the current objective and a bounded AX shortlist to TypeSafe,
may incur API charges, and falls back when it cannot select confidently. Key setup
and storage remain owned by the main implementation; this research adds neither.

1. The existing selected model derives the next bounded objective. The native path
   observes the authorized target and supplies a fresh candidate shortlist.
2. A trusted host checks enabled mode, available provider configuration, request
   budget, active session, and permitted target before invoking the selector.
3. A validated confident result proposes `press` with the original frame and ID
   through the **same existing native executor**. It gains no new tools or rights.
4. Native dispatch remains authoritative for permissions, session/lease, target
   ownership, foreground window, secure input, frame age/consumption, action count,
   takeover, and stop. A model cannot grant OS access, switch targets, or resume.
5. `none`, uncertainty, malformed output, budget exhaustion, missing key, transport
   error, or timeout returns to the current model for fresh observation/replanning
   under the same scope. If native denies permission or the user stops/takes over,
   halt; fallback must not bypass the denial or auto-resume. Never replay an uncertain
   action dispatch. A selection request itself performs no native action.

Existing implementation references: [native lab](../../../experiments/computer-use-native/README.md)
and [stdio bridge](../../../experiments/computer-use-native-bridge/README.md).
Their documented fixture validations are prior work, not rerun by this experiment.
The current native lab is itself experimental; generic app support and production
chat integration are not established by this work.

## Remaining real-key evaluation

No credential was sought, inspected, echoed, or stored during this research. The
live path reads `TYPESAFE_API_KEY` only when explicitly invoked. The main agent/user
retains credential handling. After separate spend authorization and local setup:

```sh
node experiments/jev-hyper-use/evaluate.mjs --live-case save
```

That command sends one included synthetic fixture, never an arbitrary local file.
It has **not been run**. Start by confirming the documented response contract and
resolved model. Then, with an approved aggregate spend cap, compare frozen synthetic
development/held-out sets against both the heuristic and Bunji's current selected
model. Measure accuracy, abstention/coverage, incorrect-selection rate, errors,
latency distribution, and separate token usage per provider. Review changed model
aliases and report unknown billing after failures. Do not report performance or cost
savings until those comparisons exist. Any future GUI validation is separate from
this evaluation and must first use the disposable native fixture.

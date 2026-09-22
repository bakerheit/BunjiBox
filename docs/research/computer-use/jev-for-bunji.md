# Jev inside Bunji: evaluation proposal

Reviewed 2026-09-21 against the official docs. No API key was collected, no credits
were spent, and no user conversations or app contents were sent to TypeSafe.

## Fit

Jev should be an optional decision service, not another chat-model dropdown item.
Its API accepts state plus typed questions and returns choices, scores, or yes/no
probabilities. It does not replace the generative model behind a coding agent.
[Official explanation](https://docs.typesafe.ai/introduction/coding-agents)

Promising Bunji experiments, in order:

1. **Tool routing:** distinguish a response-only request from one requiring files,
   browsing, or native app tools. Reduce unnecessary context without changing the
   user's selected model. Low confidence falls back to the existing router/model.
2. **Memory relevance:** rerank an already retrieved, bounded shortlist; do not
   upload a whole vault. Never let a classification silently delete memories.
3. **UI candidate selection:** select among accessible element IDs supplied by the
   native harness, with an explicit `none` option. The main model still handles
   screenshots, text generation, and multi-step planning.

These are hypotheses for Bunji, not measured gains. The official
[intent-routing pattern](https://docs.typesafe.ai/patterns/intent-routing) and
[skill-suggestion example](https://docs.typesafe.ai/cookbooks/skill_suggestion)
are directly relevant; their published results are not Bunji results.

## First test

Use 40 synthetic request/context pairs: clear chat, clear tool use, ambiguous
follow-ups, and misleading quoted instructions. Label them before evaluating.
Compare Jev's recommendation with Bunji's current routing; score missed tool needs,
unnecessary tool activation, abstentions, latency, input/output usage, and errors.
Keep this in shadow mode: record predictions, never execute suggested actions.
Use separate cases to choose thresholds and to report results; 40 cases are an
initial smoke test, not enough evidence for production reliability.

The documented endpoint is `POST https://api.typesafe.ai/v1/systemone`, with a
Bearer key, `state`, `model`, and `questions`. Use `TYPESAFE_API_KEY` in the local
test process; no frontend storage, logs, committed keys, or account scraping.
Start with the documented `jev-latest` alias and record the resolved model returned
by the API, rather than silently comparing different model versions.
[API reference](https://docs.typesafe.ai/api)

## Boundaries

Confidence is derived from the answer distribution, not proof of correctness.
Choice/Score include confidence; Noul does not. Calibrate thresholds on our own
examples. [Confidence documentation](https://docs.typesafe.ai/confidence)

The current model documents weaknesses with adversarial state, numeric precision,
indirection, and irrelevant context. Keep authorization, coordinate bounds,
stale-frame rejection, budgets, and stop/takeover in deterministic code. Never let
Jev turn on full-Mac access. Do not send screenshots as a made-up vision payload;
the documented state interface is text/structured JSON.
[Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

Before a live test: choose a small spend cap and configure the key locally. Adding
Jev to every user turn, changing default providers, or installing its agent skill
is not part of this proposal.

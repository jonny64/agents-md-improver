# agents-md-improver — find CLAUDE.md additions from session logs

Scans Claude Code session logs of the current project, finds situations that need a
CLAUDE.md rule (user corrections, repeated clarifications, failures + workarounds),
classifies them with TypeSafe Jev (`~typesafe/jev-latest` via OpenRouter decisions API),
drafts rule lines with a cheap chat model, validates them with a smart model, and emits
a review markdown report.

## Setup

```bash
export OPENROUTER_API_KEY=...   # openrouter.ai key, used for decide/draft/validate
```

To reach openrouter.ai through a proxy, set `HTTPS_PROXY` / `HTTP_PROXY`. The npm scripts
enable `NODE_USE_ENV_PROXY=1` so Node's fetch honors them; plain `node script.js` bypasses
the proxy and gets a 403 from the provider's security policy.

## Layout

```
scan.js       logs jsonl     -> out/situations.jsonl   (local heuristics)
decide.js     situations     -> out/decided.jsonl      (jev: disposition — add_rule/clarify_existing/
              move_to_skill/fix_tool/none — plus category/target_file)
draft.js      decided draftable -> out/drafted.jsonl   (chat: structured draft per situation; jev-checked slug merge)
validate.js   drafted        -> out/validated.jsonl    (jev: fixes_situation + overbroad_risk gate, conf floor; kimi reason on reject)
report.js     validated      -> out/report-<date>.md   (markdown for review)
manifest.js   run manifest: scan records config (prompt/digest hashes, project,
              models, window); stages warn on drift, refuse a wrong-project OUT_DIR
eval.js       labeled fixtures -> decide quality report (TP/FP/FN/TN per partition,
              disposition confusion; EVAL_PRECISION_FLOOR gates, unset until baselined)
prompts.js    question structure + digest builder
prompts/      prompt texts, one file per prompt — edit wording here, not in JS
fixtures/     synthetic jsonl sessions for detector tests and eval labels
tests/        node --test suites (*.test.js), one per stage; live probes behind SMOKE_LIVE=1
```

## Usage

Set `PROJECT_DIR` to the project whose logs you want mined; it determines the
session-log slug directory:

```bash
PROJECT_DIR=/path/to/target npm start   # all stages in sequence
npm run scan                            # or step by step
npm run decide
npm run draft
npm run validate
npm run report
node eval.js                           # measure decide against fixtures/labeled.jsonl
```

Full runs write `run.log` in `OUT_DIR`, with the cost estimate on the first line
and all stages logged sequentially.

Env: `DAYS` (default 30), `SINCE`/`UNTIL` (`YYYY-MM-DD`, mtime-based inclusive window —
`SINCE` overrides `DAYS`, `UNTIL` caps it), `PROJECT_DIR` (default cwd), `OUT_DIR` (default `out`),
`DRAFT_MODEL` (default `z-ai/glm-5.3-flash`), `VALIDATE_MODEL` (default `moonshotai/kimi-k3`).

Tests: `npm test` (offline, with coverage). Live probes cost a few cents:
`NODE_USE_ENV_PROXY=1 SMOKE_LIVE=1 npm test`. Files run serially
(`--test-concurrency=1`) because suites spawn the real stage scripts and one
renames a shared prompt file.

`DAYS` filters session files by mtime, not messages by timestamp — a long-lived
session touched today yields its old messages too.

All stages are idempotent: each appends to its output and skips ids already present,
re-runs resume where they stopped.

API calls carry `session_id: agents-md-improver-<YYYYMMDD>` and a per-stage
`User-Agent: ami-<stage>-<YYYYMMDD>`, so a run's spend is grouped per day in the
OpenRouter Sessions view with the stage identifiable per request.

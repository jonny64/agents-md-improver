# agents-md-improver — find CLAUDE.md additions from session logs

## Overview

Standalone Node 24 tool. It scans Claude Code session logs for user corrections,
repeated clarifications, and failures followed by workarounds. It classifies
situations with TypeSafe Jev, drafts rules with a chat model, validates them, and
emits a markdown report.

## Design

- Plain Node scripts and `node:` standard-library modules; no runtime npm deps.
- Session logs come from `~/.claude/projects/<slug>/*.jsonl`, where the slug is
  the project path with non-alphanumeric characters replaced by `-`.
- Process only the selected project and stream logs line by line.
- Keep generated files in the gitignored `out/` directory.
- Each stage appends output and skips known ids so reruns resume safely.
- Scan and report run locally. Decide, draft, and validate call OpenRouter.

Pipeline:

1. `scan.js` extracts situations and records the run manifest.
2. `decide.js` assigns disposition, category, and target file.
3. `draft.js` drafts structured rules and merges equivalent slugs conservatively.
4. `validate.js` checks situation fit and harmful overbreadth with confidence
   floors, then writes rejection reasons.
5. `report.js` renders accepted and rejected findings for manual review.
6. `eval.js` measures decisions against synthetic labeled fixtures.

Prompt text lives in `prompts/`; question construction and digest building live
in `prompts.js`.

## Testing

- Fixtures are wholly synthetic and contain no production transcripts, user
  identifiers, or application-specific object names.
- Run the offline suite with `npm test`.
- Live probes require `SMOKE_LIVE=1`, an API key, and network access.
- Evaluate prompt changes on the dev partition, then check the holdout partition
  for regressions. Repeat live measurements because model decisions can vary.

## Deferred work

P1:

- [ ] Require failure workarounds to target the same file or command and check
      the successful call's exit code.
- [ ] Use a fixed eval scratch directory instead of deleting an env-provided
      output path.
- [ ] Check output ownership before overwriting the manifest; retain a matching
      manifest and refuse a foreign one.
- [ ] Carry existing-rule context through draft and validation for
      `clarify_existing`, and render the proposed amendment in the report.

P2:

- [ ] Mark digest content omitted by the bullet-only parser.
- [ ] Report raw and post-threshold recall.
- [ ] Freeze the eval digest and add more `clarify_existing` coverage.
- [ ] Surface unresolved overbreadth confidence in the report.
- [ ] Persist raw drafts immediately and merge durable records.
- [ ] Fix report rendering for unvalidated input.
- [ ] Measure single-correction sufficiency and confidence-as-evidence prompt
      changes with repeated eval runs before accepting them.

## Manual verification

Review the generated report and decide which rules to adopt into user-global or
project instructions. Generated reports may contain source evidence and should
be handled as private local artifacts.

// prompts.js — single quality lever: jev question structure + system prompts,
// plus the shared existing-rules digest builder. All prompt TEXT lives in
// prompts/*.txt (one file per prompt, editable without touching JS); this file
// assembles them. Tune judgement here and in prompts/, not in the stage scripts.

const {existsSync, readFileSync} = require ('node:fs')
const {join} = require ('node:path')
const os = require ('node:os')

// bullet lines of ~/.claude/CLAUDE.md + project ./AGENTS.md, ./CLAUDE.md,
// .docs/CLAUDE.md, ./CLAUDE.local.md (generic: agent rules may live in AGENTS.md
// too). Each bullet carries a source file label (no line numbers — they rot
// under truncation). Budgets are per SCOPE, shared across its files and filled
// sequentially: project 1500 (largest — it is the clarification target), local
// 500, global 1000. A single global cap let the user-global CLAUDE.md eat the
// whole budget so project rules never reached jev (user catch 2026-10-14).
// Truncation is marked per file, so "guidance absent" can never be claimed for
// content that was cut (codex review #2).
function buildRulesDigest (projectDir) {
    const scopes = [
        {budget: 1500, files: [
            [join (projectDir, 'AGENTS.md'),          '[AGENTS.md]'],
            [join (projectDir, 'CLAUDE.md'),          '[CLAUDE.md]'],
            [join (projectDir, '.docs', 'CLAUDE.md'), '[.docs/CLAUDE.md]'],
        ]},
        {budget: 500, files: [
            [join (projectDir, 'CLAUDE.local.md'), '[CLAUDE.local.md]'],
        ]},
        {budget: 1000, files: [
            [join (os.homedir (), '.claude', 'CLAUDE.md'), '[~/.claude/CLAUDE.md]'],
        ]},
    ]
    const seen = new Set ()
    const sections = []
    for (const {budget, files} of scopes) {
        let left = budget
        for (const [f, label] of files) {
            if (seen.has (f) || !existsSync (f)) continue
            seen.add (f)
            const bullets = readFileSync (f, 'utf8').split ('\n')
                .filter (l => /^\s*[-*] /.test (l))
                .map (l => `- ${label} ${l.trim ().replace (/^[-*] /, '')}`)
            if (!bullets.length) continue
            if (left <= 0) { sections.push (`…(truncated, ${bullets.length} more rules)`); continue }
            const [section, used] = cut (bullets, left)
            sections.push (section)
            left -= used
        }
    }
    return sections.join ('\n')
}

// line-boundary cut so no bullet arrives half-read; a cut section states how much
// is missing; returns the section and its length so the shared scope budget drains
function cut (bullets, budget) {
    const out = []
    let len = 0
    for (const l of bullets) {
        if (len + l.length + 1 > budget) break
        out.push (l); len += l.length + 1
    }
    if (out.length === bullets.length) return [out.join ('\n'), len]
    const section = out.join ('\n') + `\n…(truncated, ${bullets.length - out.length} more rules)`
    return [section, section.length]
}

function read (name) {
    const f = join (__dirname, 'prompts', name)
    if (!existsSync (f)) throw new Error (`missing prompt file: prompts/${name}`)
    return readFileSync (f, 'utf8').trim ()
}

// POST /api/alpha/decisions body.questions — one record per question, each answered
// independently against `state`. criteria describes what each choice means.
const jevQuestions = {
    disposition: {
        type: 'choice',
        instructions: read ('jev_disposition_instructions.txt'),
        criteria: {
            add_rule:         read ('jev_disposition_add_rule.txt'),
            clarify_existing: read ('jev_disposition_clarify_existing.txt'),
            move_to_skill:    read ('jev_disposition_move_to_skill.txt'),
            fix_tool:         read ('jev_disposition_fix_tool.txt'),
            none:             read ('jev_disposition_none.txt'),
        },
    },
    category: {
        type: 'choice',
        instructions: read ('jev_category_instructions.txt'),
        criteria: {
            constraint: read ('jev_category_constraint.txt'),
            workflow:   read ('jev_category_workflow.txt'),
            tooling:    read ('jev_category_tooling.txt'),
            style:      read ('jev_category_style.txt'),
        },
    },
    target_file: {
        type: 'choice',
        instructions: read ('jev_target_file_instructions.txt'),
        criteria: {
            user_global: read ('jev_target_file_user_global.txt'),
            project:     read ('jev_target_file_project.txt'),
            local:       read ('jev_target_file_local.txt'),
        },
    },
}

// validate.js jev gate: does the drafted rule fix the situations it groups, and
// does its wording stay correct on adjacent situations it would also reach?
const jevValidateQuestions = {
    fixes_situation: {
        type: 'choice',
        instructions: read ('jev_fixes_situation.txt'),
        criteria: {
            yes: read ('jev_fixes_situation_yes.txt'),
            no:  read ('jev_fixes_situation_no.txt'),
        },
    },
    overbroad_risk: {
        type: 'choice',
        instructions: read ('jev_overbroad_risk_instructions.txt'),
        criteria: {
            yes: read ('jev_overbroad_risk_yes.txt'),
            no:  read ('jev_overbroad_risk_no.txt'),
        },
    },
}

// draft.js jev gate for slug collisions: are the candidates one remedy or several?
const jevMergeQuestions = {
    merge_equivalent: {
        type: 'choice',
        instructions: read ('jev_merge_equivalent_instructions.txt'),
        criteria: {
            yes: read ('jev_merge_equivalent_yes.txt'),
            no:  read ('jev_merge_equivalent_no.txt'),
        },
    },
}

// draft.js — one imperative English rule line per situation group
const draftSystemPrompt = read ('draft_system.txt')

// validate.js — one-line rejection reasons (called only for rejected rules)
const reasonSystemPrompt = read ('validate_reason_system.txt')

module.exports = {jevQuestions, jevValidateQuestions, jevMergeQuestions, draftSystemPrompt, reasonSystemPrompt, buildRulesDigest}

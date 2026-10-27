// tests/prompts.js — disposition vocabulary + labeled rules digest (offline).
// Digest tests use temp project dirs; the real ~/.claude/CLAUDE.md may also
// contribute bullets, so asserts check presence, never exclusivity.
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {rmSync, mkdirSync, writeFileSync} = require ('node:fs')
const {join} = require ('node:path')
const {jevQuestions, jevValidateQuestions, buildRulesDigest} = require ('../prompts.js')

const tmp = 'out/testprompts'

describe ('jev question vocabulary', () => {

    it ('disposition offers exactly the five choices, needs_rule is gone', () => {
        assert.ok (!jevQuestions.needs_rule, 'needs_rule must be replaced by disposition')
        assert.deepStrictEqual (Object.keys (jevQuestions.disposition.criteria),
            ['add_rule', 'clarify_existing', 'move_to_skill', 'fix_tool', 'none'],
            'disposition criteria must carry the full vocabulary')
        for (const [choice, text] of Object.entries (jevQuestions.disposition.criteria))
            assert.ok (text.length > 10, `criterion ${choice} must be non-trivial text`)
    })

    it ('validate gate asks both questions, each yes/no', () => {
        assert.deepStrictEqual (Object.keys (jevValidateQuestions), ['fixes_situation', 'overbroad_risk'],
            'the validate call must carry the Task 20 two-question gate')
        for (const q of Object.values (jevValidateQuestions)) {
            assert.strictEqual (q.type, 'choice')
            assert.deepStrictEqual (Object.keys (q.criteria), ['yes', 'no'])
        }
    })

})

describe ('buildRulesDigest labels and truncation', () => {

    it ('labels every bullet with its source file', () => {
        const dir = join (tmp, 'labels')
        rmSync (dir, {recursive: true, force: true}); mkdirSync (dir, {recursive: true})
        writeFileSync (join (dir, 'CLAUDE.md'), '# p\n\n- Alpha rule\n- Beta rule\n')
        writeFileSync (join (dir, 'AGENTS.md'), '# a\n\n* Gamma rule\n')
        writeFileSync (join (dir, 'CLAUDE.local.md'), '- Local rule\n')
        const digest = buildRulesDigest (dir)
        assert.match (digest, /- \[CLAUDE\.md\] Alpha rule/, 'project CLAUDE.md bullets labeled')
        assert.match (digest, /- \[CLAUDE\.md\] Beta rule/, 'second bullet kept')
        assert.match (digest, /- \[AGENTS\.md\] Gamma rule/, 'AGENTS.md bullets labeled, `*` marker normalized')
        assert.match (digest, /- \[CLAUDE\.local\.md\] Local rule/, 'CLAUDE.local.md labeled with its own budget')
    })

    it ('truncates per file with an explicit marker, project rules survive a fat global file', () => {
        const dir = join (tmp, 'trunc')
        rmSync (dir, {recursive: true, force: true}); mkdirSync (dir, {recursive: true})
        const fat = Array.from ({length: 80}, (_, i) => `- Rule number ${i} ${'x'.repeat (60)}`).join ('\n')
        writeFileSync (join (dir, 'CLAUDE.md'), `${fat}\n`)
        const digest = buildRulesDigest (dir)
        // project section: first bullets in, own truncation marker with the count
        assert.match (digest, /- \[CLAUDE\.md\] Rule number 0 /, 'project bullets lead the digest')
        assert.match (digest, /…\(truncated, \d+ more rules\)/, 'cut section states how much is missing')
        const lines = digest.split ('\n')
        assert.ok (lines.filter (l => l.startsWith ('- [CLAUDE.md]')).every (l => l.length < 100),
            'cut happens on line boundaries — no half bullets')
        // budgets are per scope, shared: all three project files together stay ~1500
        const isProject = l => /^- \[(AGENTS\.md|CLAUDE\.md|\.docs\/CLAUDE\.md)\]/.test (l)
        const projectLen = lines.filter (isProject).join ('\n').length
        assert.ok (projectLen <= 1600, `project scope must cap at its shared budget, got ${projectLen}`)
        // the regression this guards: whatever the real global file contributes (it is
        // fat on this machine), it gets its own 1000-char slice — never eats the project section
        if (digest.includes ('[~/.claude/CLAUDE.md]')) {
            const globalLen = lines.filter (l => l.startsWith ('- [~/.claude/CLAUDE.md]')).join ('\n').length
            assert.ok (globalLen <= 1100, `global slice must cap at its own budget, got ${globalLen}`)
        }
    })

    it ('project scope budget is shared across files, filled sequentially', () => {
        const dir = join (tmp, 'shared')
        rmSync (dir, {recursive: true, force: true}); mkdirSync (dir, {recursive: true})
        const fat = n => Array.from ({length: n}, (_, i) => `- ${String (i).padStart (2, '0')} ${'y'.repeat (70)}`).join ('\n')
        writeFileSync (join (dir, 'AGENTS.md'), `${fat (30)}\n`) // ~2400 chars — drains the scope alone
        writeFileSync (join (dir, 'CLAUDE.md'), `${fat (30)}\n`) // nothing left here but a marker
        const lines = buildRulesDigest (dir).split ('\n')
        assert.ok (lines.some (l => l.startsWith ('- [AGENTS.md] 00')), 'first file fills first')
        assert.strictEqual (lines.filter (l => l.startsWith ('- [CLAUDE.md]')).length, 0,
            'exhausted scope leaves no bullets for later project files')
        assert.ok (lines.includes ('…(truncated, 30 more rules)'),
            'the starved file still gets an explicit truncation marker')
    })

    it ('no truncation marker for a section that fits its budget', () => {
        const dir = join (tmp, 'small')
        rmSync (dir, {recursive: true, force: true}); mkdirSync (dir, {recursive: true})
        writeFileSync (join (dir, 'CLAUDE.md'), '- Tiny rule\n')
        const digest = buildRulesDigest (dir)
        const lines = digest.split ('\n')
        const i = lines.indexOf ('- [CLAUDE.md] Tiny rule')
        assert.ok (i >= 0, 'tiny project bullet present')
        assert.ok (i === lines.length - 1 || !/^…\(truncated/.test (lines [i + 1]),
            'a section that fits must not carry a truncation marker')
    })

})

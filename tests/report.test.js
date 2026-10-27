// tests/report.js — crafted stage artifacts -> both report sections present (offline)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync, mkdirSync, writeFileSync} = require ('node:fs')

describe ('report.js rendering', () => {

    const OUT = 'out/testreport'
    rmSync (OUT, {recursive: true, force: true})
    mkdirSync (OUT, {recursive: true})
    const w = (name, arr) => writeFileSync (`${OUT}/${name}`, arr.map (x => JSON.stringify (x)).join ('\n') + '\n')
    const sit = (id, kind, session) => ({id, kind, ts: '2026-10-13T10:00:00.000Z', session, file: 'f',
        quotes: [`${kind} evidence quote ${id}`], context: {}, count: 1})
    w ('decided.jsonl', [
        {...sit ('y1', 'correction', 'sess-a'), disposition: 'add_rule', category: 'constraint', target_file: 'project', confidence: 0.9, cost: 0.00005},
        {...sit ('y2', 'failure', 'sess-b'),     disposition: 'add_rule', category: 'tooling',   target_file: 'user_global', confidence: 0.7, cost: 0.00005},
        {...sit ('y3', 'correction', 'sess-d'), disposition: 'add_rule', category: 'workflow', target_file: 'local', confidence: 0.2, cost: 0.00005},
        {...sit ('n1', 'clarification', 'sess-c'), disposition: 'none', category: 'workflow', target_file: 'local', confidence: 0.8, cost: 0.00005},
        {...sit ('m1', 'correction', 'sess-e'), disposition: 'move_to_skill', category: 'workflow', target_file: 'project', confidence: 0.9, cost: 0.00005},
        {...sit ('t1', 'failure', 'sess-f'), disposition: 'fix_tool', category: 'tooling', target_file: 'project', confidence: 0.8, cost: 0.00005},
    ])
    w ('drafted.jsonl', [
        {id: 'g1', situation_ids: ['y1'], count: 1, rule_line: 'Never edit a slice directly — use its _vw view.',
            trigger: 'editing a slice file', mistake: 'bypasses the _vw contract', preferred_behavior: 'edit via the _vw view',
            scope: 'src/*', cost: 0.0002},
        {id: 'g2', situation_ids: ['y2'], count: 1, rule_line: 'Be nice to the database.',
            trigger: 'querying the database', mistake: 'vague intent', preferred_behavior: 'precise queries',
            scope: 'psql sessions', cost: 0.0002},
    ])
    w ('validated.jsonl', [
        {id: 'g1', verdict: 'keep', confidence: 0.85, reason: null, rule_line: 'Never edit a slice directly — use its _vw view.', category: 'constraint', situation_ids: ['y1'], cost: 0.001},
        {id: 'g2', verdict: 'reject', confidence: 0.6, reason: 'vague platitude', rule_line: 'Be nice to the database.', category: 'tooling', situation_ids: ['y2'], cost: 0.001},
    ])
    const r = spawnSync ('node', ['report.js'], {env: {...process.env, OUT_DIR: OUT}, encoding: 'utf8'})
    const md = readFileSync (`${OUT}/report-${new Date ().toISOString ().slice (0, 10)}.md`, 'utf8')

    it ('renders kept and rejected sections with the drafted rules', () => {
        assert.strictEqual (r.status, 0, `report.js exited ${r.status}: ${r.stderr}`)
        assert.match (md, /## Rule candidates \(1\)/, 'kept section with 1 finding')
        assert.match (md, /## Rejected by validator \(1\)/, 'rejected section with 1 finding')
        assert.match (md, /Never edit a slice directly/, 'kept rule line present')
        assert.match (md, /Be nice to the database/, 'rejected rule line present')
        assert.match (md, /vague platitude/, 'rejection reason present')
    })

    it ('header carries disposition counts, below-threshold and summed cost', () => {
        assert.match (md, /dispositions: add_rule 3, clarify_existing 0, move_to_skill 1, fix_tool 1, none 1 \(below conf 0\.5: 1\)/,
            'header disposition breakdown + below-threshold count')
        assert.match (md, /total cost: \$0\.0027/, 'header cost sums all stages')
    })

    it ('skill and tool dispositions get their own sections, not drafted rules', () => {
        assert.match (md, /## Skill candidates \(1\)/, 'skill candidates section')
        assert.match (md, /## Tool-fix candidates \(1\)/, 'tool-fix candidates section')
        assert.match (md, /- \(correction x1\) correction evidence quote m1/, 'skill candidate listed with its evidence quote')
        assert.match (md, /- \(failure x1\) failure evidence quote t1/, 'tool-fix candidate listed with its evidence quote')
    })

    it ('per-finding stats show validation confidence, structured fields, situations and sessions', () => {
        assert.match (md, /confidence 0\.85 \| seen 1x/, 'per-finding stats (jev validation confidence)')
        assert.match (md, /situations: y1 \| sessions: sess-a/, 'kept rule traces to its situation and session')
        assert.match (md, /trigger: editing a slice file \| mistake: bypasses the _vw contract/, 'structured draft fields render')
        assert.match (md, /situations: y2 \| sessions: sess-b/, 'rejected rule traces to its situation and session too')
    })

})

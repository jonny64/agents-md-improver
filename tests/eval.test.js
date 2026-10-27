// tests/eval.js — scoring math and label-stripping units (offline); live eval
// behind SMOKE_LIVE=1 (needs OPENROUTER_API_KEY + network + NODE_USE_ENV_PROXY=1)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync, renameSync} = require ('node:fs')
const {score, situationOf} = require ('../eval.js')

describe ('eval.js scoring (offline)', () => {

    const row = (id, label, expected, partition) => ({id, label, expected, partition})
    const verdict = (id, disposition, confidence) => ({id, disposition, confidence})

    it ('counts TP/FP/FN/TN per partition and overall, precision/recall with 0-div guards', () => {
        const labeled = [
            row ('t1', 'yes', 'add_rule', 'dev'), row ('t2', 'no', 'none', 'dev'),
            row ('t3', 'yes', 'add_rule', 'dev'), row ('t4', 'no', 'none', 'dev'),
            row ('h1', 'yes', 'add_rule', 'holdout'),
        ]
        const decided = new Map ([
            verdict ('t1', 'add_rule', 0.9),        // TP (also exact)
            verdict ('t2', 'add_rule', 0.4),        // FP
            verdict ('t3', 'none', null),           // FN
            verdict ('t4', 'none', 0.8),            // TN
            verdict ('h1', 'move_to_skill', 0.7),   // TP — actionable channel, disposition mismatch
        ].map (v => [v.id, v]))
        const s = score (labeled, decided)
        assert.deepStrictEqual (s.parts.dev, {tp: 1, fp: 1, fn: 1, tn: 1, precision: 0.5, recall: 0.5})
        assert.deepStrictEqual (s.parts.holdout, {tp: 1, fp: 0, fn: 0, tn: 0, precision: 1, recall: 1})
        assert.strictEqual (s.parts.__all__.tp, 2)
        assert.strictEqual (s.parts.__all__.precision.toFixed (3), (2 / 3).toFixed (3))
        assert.strictEqual (s.missing.length, 0)
    })

    it ('move_to_skill/fix_tool predictions count as actionable, none does not', () => {
        const labeled = [row ('t1', 'yes', null, 'dev'), row ('t2', 'no', null, 'dev')]
        const decided = new Map ([verdict ('t1', 'fix_tool', 0.9), verdict ('t2', 'none', 0.9)].map (v => [v.id, v]))
        const s = score (labeled, decided)
        assert.strictEqual (s.parts.dev.tp, 1)
        assert.strictEqual (s.parts.dev.tn, 1)
    })

    it ('confusion matrix, exact agreement and mismatch listing name expected vs predicted', () => {
        const labeled = [row ('t1', 'yes', 'add_rule', 'dev'), row ('t2', 'no', 'none', 'dev'), row ('t3', 'no', null, 'dev')]
        const decided = new Map ([
            verdict ('t1', 'clarify_existing', 0.6), verdict ('t2', 'none', 0.9), verdict ('t3', 'add_rule', 0.2),
        ].map (v => [v.id, v]))
        const s = score (labeled, decided)
        assert.strictEqual (s.confusion.add_rule.clarify_existing, 1)
        assert.strictEqual (s.confusion.none.none, 1)
        assert.strictEqual (s.exact, 1)
        assert.strictEqual (s.exactAll, 2)
        assert.ok (s.mismatches.some (m => m.id === 't1' && m.expected === 'add_rule' && m.predicted === 'clarify_existing'))
        assert.ok (s.mismatches.some (m => m.id === 't3' && m.expected === null && m.predicted === 'add_rule'),
            'rows without an expected disposition still list binary mismatches')
    })

    it ('below-threshold actionable predictions are counted for the hypothesis note', () => {
        const labeled = [row ('t1', 'yes', 'add_rule', 'dev'), row ('t2', 'yes', 'add_rule', 'dev')]
        const decided = new Map ([verdict ('t1', 'add_rule', 0.2), verdict ('t2', 'add_rule', 0.8)].map (v => [v.id, v]))
        const s = score (labeled, decided)
        assert.strictEqual (s.belowThr, 1)
        assert.strictEqual (s.actionable, 2)
    })

    it ('verdict-less cases land in missing, never counted as predictions', () => {
        const labeled = [row ('t1', 'yes', 'add_rule', 'dev'), row ('t2', 'no', 'none', 'dev')]
        const s = score (labeled, new Map ())
        assert.deepStrictEqual (s.missing, ['t1', 't2'])
        assert.strictEqual (s.parts.__all__.tp + s.parts.__all__.fp + s.parts.__all__.fn + s.parts.__all__.tn, 0)
    })

    it ('situationOf strips eval metadata — labels never reach the model state', () => {
        const sit = situationOf ({id: 't1', kind: 'failure', quotes: ['q'], context: {}, count: 2,
            label: 'yes', borderline: false, expected: 'add_rule', partition: 'dev', note: 'secret labeling note'})
        assert.deepStrictEqual (sit, {id: 't1', kind: 'failure', quotes: ['q'], context: {}, count: 2})
    })

})

describe ('eval.js error path (offline)', () => {

    it ('fails with a clear error when the labeled set is missing', () => {
        renameSync ('fixtures/labeled.jsonl', 'fixtures/labeled.jsonl.bak')
        try {
            const r = spawnSync ('node', ['eval.js'], {env: {...process.env, OPENROUTER_API_KEY: 'k'}, encoding: 'utf8'})
            assert.notStrictEqual (r.status, 0, 'eval must exit non-zero without the labeled set')
            assert.match (r.stderr, /labeled\.jsonl missing/)
        }
        finally { renameSync ('fixtures/labeled.jsonl.bak', 'fixtures/labeled.jsonl') }
    })

    it ('labeled fixture carries both partitions and balanced labels', () => {
        const rows = readFileSync ('fixtures/labeled.jsonl', 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
        assert.ok (rows.length >= 14, `8 originals + >=6 new, got ${rows.length}`)
        const parts = rows.map (r => r.partition)
        assert.ok (parts.filter (p => p === 'dev').length >= 8 && parts.filter (p => p === 'holdout').length >= 4,
            'both partitions populated')
        for (const r of rows) {
            assert.ok (['yes', 'no'].includes (r.label), `${r.id} label must be yes/no`)
            assert.ok (r.expected !== undefined, `${r.id} needs an expected disposition (or explicit null)`)
        }
    })

})

describe ('eval.js live measurement (SMOKE_LIVE=1)', {skip: !process.env.SMOKE_LIVE}, () => {

    const r = spawnSync ('node', ['eval.js'], {env: {...process.env, OUT_DIR: 'out/testevallive', NODE_USE_ENV_PROXY: '1'}, encoding: 'utf8'})

    it ('measures every labeled case and prints the full report shape', () => {
        assert.strictEqual (r.status, 0, `eval exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /eval: 18 case\(s\) \(dev 13, holdout 5\)/)
        assert.match (r.stdout, /overall +TP \d+ FP \d+ FN \d+ TN \d+ \| precision \d\.\d+ recall \d\.\d+/)
        assert.match (r.stdout, /disposition agreement: \d+\/\d+ exact/)
        assert.match (r.stdout, /confusion expected\\predicted/)
        assert.match (r.stdout, /draft threshold: MIN_CONFIDENCE 0\.5 is a hypothesis to test/)
        assert.match (r.stdout, /precision floor: not set/)
        assert.doesNotMatch (r.stdout, /warning: \d+ labeled case\(s\) got no verdict/, 'all cases must get verdicts')
    })

})

// tests/validate.js — offline gate unit + error paths; live probe behind
// SMOKE_LIVE=1 (needs OPENROUTER_API_KEY + network + NODE_USE_ENV_PROXY=1)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync} = require ('node:fs')
const {verdictOf} = require ('../validate.js')

describe ('validate.js error paths (offline)', () => {

    it ('fails with a clear error when OPENROUTER_API_KEY is missing', () => {
        const r = spawnSync ('node', ['validate.js'], {
            env: {...process.env, OUT_DIR: 'out/testvalidateerr', OPENROUTER_API_KEY: ''},
            encoding: 'utf8',
        })
        assert.notStrictEqual (r.status, 0, 'validate.js must exit non-zero without a key')
        assert.match (r.stderr, /OPENROUTER_API_KEY not set/)
    })

    it ('fails with a clear error when drafted.jsonl is missing', () => {
        rmSync ('out/testvalidateerr', {recursive: true, force: true})
        const r = spawnSync ('node', ['validate.js'], {env: {...process.env, OUT_DIR: 'out/testvalidateerr'}, encoding: 'utf8'})
        assert.notStrictEqual (r.status, 0, 'validate.js must exit non-zero without drafted.jsonl')
        assert.match (r.stderr, /drafted\.jsonl missing/)
    })

    it ('source sends the OpenRouter identity (session_id body, stage User-Agent)', () => {
        const src = readFileSync ('validate.js', 'utf8')
        assert.match (src, /SESSION_ID\s*=\s*`agents-md-improver-\$\{_day\}`/, 'session_id must group under the app name')
        assert.match (src, /USER_AGENT\s*=\s*`ami-validate-\$\{_day\}`/, 'User-Agent must carry the stage tag')
        assert.match (src, /'User-Agent': USER_AGENT/, 'User-Agent header must be sent')
        assert.match (src, /session_id:\s*SESSION_ID/, 'session_id must be in the request body')
    })

})

describe ('verdictOf gate: symmetric confidence floors (offline)', () => {

    const ans = (choice, confidence) => ({choice, confidence})

    it ('keeps when fixes=yes at/above floor and no harmful overbreadth at/above floor', () => {
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('no', 0.8)), {verdict: 'keep', failed: null})
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.3), ans ('no', 0.55)), {verdict: 'keep', failed: null}, 'floor is inclusive')
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('no', 0.1)), {verdict: 'keep', failed: null},
            'a weakly-confident no-harm answer still passes — the formula only kills on confident harm')
    })

    it ('a low-confidence overbroad suspicion must not kill the rule', () => {
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('yes', 0.29)), {verdict: 'keep', failed: null})
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('yes', null)), {verdict: 'keep', failed: null},
            'missing overbroad confidence counts as 0 — suspicion below floor is ignored')
    })

    it ('a confident overbroad flag rejects', () => {
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('yes', 0.3)),  {verdict: 'reject', failed: 'overbroad_risk'})
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('yes', 0.94)), {verdict: 'reject', failed: 'overbroad_risk'})
    })

    it ('rejects naming the check that failed', () => {
        assert.deepStrictEqual (verdictOf (ans ('no', 0.9), ans ('no', 0.8)), {verdict: 'reject', failed: 'fixes_situation'})
    })

    it ('a low-confidence fixes approval must not keep', () => {
        const v = verdictOf (ans ('yes', 0.2), ans ('no', 0.9))
        assert.deepStrictEqual (v, {verdict: 'reject', failed: 'confidence_floor'})
        assert.deepStrictEqual (verdictOf (ans ('yes', null), ans ('no', 0.9)).failed, 'confidence_floor',
            'missing confidence counts as 0, never passes')
    })

    it ('malformed or missing answers never count as passing', () => {
        assert.deepStrictEqual (verdictOf (null, null),            {verdict: 'reject', failed: 'malformed'})
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), {}),  {verdict: 'reject', failed: 'malformed'})
        assert.deepStrictEqual (verdictOf ({confidence: 0.9}, ans ('no', 0.9)), {verdict: 'reject', failed: 'malformed'},
            'answer without a choice is malformed')
        assert.deepStrictEqual (verdictOf (ans ('maybe', 0.9), ans ('no', 0.9)), {verdict: 'reject', failed: 'malformed'},
            'out-of-vocabulary choice is malformed — never passes')
        assert.deepStrictEqual (verdictOf (ans ('yes', 0.9), ans ('maybe', 0.9)), {verdict: 'reject', failed: 'malformed'},
            'out-of-vocabulary overbroad answer never passes either')
    })

})

describe ('validate.js live probe (SMOKE_LIVE=1)', {skip: !process.env.SMOKE_LIVE}, () => {

    const OUT = 'out/testvalidatelive'
    rmSync (OUT, {recursive: true, force: true})
    require ('node:fs').mkdirSync (OUT, {recursive: true})
    const w = (name, arr) => require ('node:fs').writeFileSync (`${OUT}/${name}`, arr.map (x => JSON.stringify (x)).join ('\n') + '\n')
    // Synthetic evidence: the keep-expectation only holds when the rule is grounded in it;
    // distinct sessions matter — the merged keep-case must look like production output
    const sit = (id, session, kind, quotes) => ({id, kind, ts: '2026-10-13T10:00:00.000Z', session, file: 'f',
        quotes, context: {}, count: 1})
    w ('decided.jsonl', [
        // singleton keep-case evidence
        {...sit ('y1', 'sess-a', 'failure', ["Bash (failed): psql -c 'SELECT ... FROM report_groups'", 'Exit code 1: relation does not exist', 'Bash (ok): REFRESH MATERIALIZED VIEW report_groups; SELECT returned rows']),
            disposition: 'add_rule', category: 'tooling', target_file: 'project', confidence: 0.9},
        {...sit ('y2', 'sess-b', 'correction', ['Edit: ./src/report_groups.js', 'не надо править срез напрямую, используй _vw']),
            disposition: 'add_rule', category: 'constraint', target_file: 'project', confidence: 0.9},
        // merged keep-case evidence: same class, three distinct sessions
        {...sit ('y3', 'sess-c', 'failure', ["Bash (failed): psql -c 'SELECT count(*) FROM report_groups'", 'Exit code 1: relation does not exist', 'Bash (ok): REFRESH MATERIALIZED VIEW report_groups; SELECT count(*) returned 42']),
            disposition: 'add_rule', category: 'tooling', target_file: 'project', confidence: 0.9},
        {...sit ('y4', 'sess-d', 'failure', ["Bash (failed): psql -c 'SELECT sum(amount) FROM billing_mv'", 'ERROR: materialized view billing_mv has not been populated', 'Bash (ok): REFRESH MATERIALIZED VIEW billing_mv; SELECT returned rows']),
            disposition: 'add_rule', category: 'tooling', target_file: 'project', confidence: 0.9},
        {...sit ('y5', 'sess-e', 'failure', ["Bash (failed): psql -c 'SELECT * FROM reports_mv'", 'Exit code 1: relation does not exist', 'Bash (ok): REFRESH MATERIALIZED VIEW reports_mv; SELECT returned rows']),
            disposition: 'add_rule', category: 'tooling', target_file: 'project', confidence: 0.9},
        {...sit ('y6', 'sess-f', 'failure', ["Bash (failed): psql -c 'SELECT count(*) FROM report_groups'", 'Exit code 1: relation does not exist', 'Bash (ok): REFRESH MATERIALIZED VIEW report_groups; SELECT count(*) returned 42']),
            disposition: 'add_rule', category: 'tooling', target_file: 'project', confidence: 0.9},
    ])
    w ('drafted.jsonl', [
        // singleton keep case: redundant-but-harmless class — extra refresh on a fresh
        // view is waste, not harm; singletons are normal production output post-Task 17
        {id: 'a1b2c3d4e5f60718', situation_ids: ['y1'], count: 1, rule_line: 'Refresh the report_groups materialized view before selecting from it in psql.',
            trigger: 'selecting from the report_groups materialized view', mistake: 'the view is stale, relation does not exist', preferred_behavior: 'refresh it first', scope: 'psql selects from report_groups'},
        {id: 'b2c3d4e5f6071829', situation_ids: ['y2'], count: 1, rule_line: 'Be nice to the codebase and always do the right thing.',
            trigger: 'any action', mistake: 'unclear', preferred_behavior: 'do the right thing', scope: 'everywhere'},
        // merged keep case: three sessions of the same failure class back the general wording
        {id: 'd4e5f60718293a4b', situation_ids: ['y3', 'y4', 'y5'], count: 3, rule_line: 'Refresh a materialized view before selecting from it in psql.',
            trigger: 'selecting from a materialized view', mistake: 'the view is stale or unpopulated', preferred_behavior: 'refresh it first', scope: 'psql selects from materialized views'},
        // bait: blanket wording from a one-view fix — reaches every psql command;
        // harmful (mass refresh storm) or unconfident-fix, either way it must not keep
        {id: 'c3d4e5f60718293a', situation_ids: ['y6'], count: 1, rule_line: 'Before running any psql command, REFRESH MATERIALIZED VIEW on every materialized view in the database.',
            trigger: 'running a psql command', mistake: 'the view may be stale', preferred_behavior: 'refresh everything first', scope: 'psql'},
    ])
    const r = spawnSync ('node', ['validate.js'], {env: {...process.env, OUT_DIR: OUT, NODE_USE_ENV_PROXY: '1'}, encoding: 'utf8'})

    it ('keeps the singleton and merged rules, rejects the filler and the bait, records both answers', () => {
        assert.strictEqual (r.status, 0, `validate.js exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /cost \$\d/, 'validate cost must print')
        assert.match (r.stdout, /  \[1\/4 eta \d{2}:\d{2}:\d{2} MSK\] [0-9a-f]{16} (keep|reject)\s+\(conf [\d.?]+ \| overbroad (yes|no|\?) [\d.?]+\) -> /,
            'validate per-item line must carry counter/id/eta plus both answers')
        const checks = readFileSync (`${OUT}/validated.jsonl`, 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
        assert.strictEqual (checks.length, 4, `expected 4 verdicts, got ${checks.length}`)
        const byId = Object.fromEntries (checks.map (c => [c.id, c]))
        const singleton = byId.a1b2c3d4e5f60718
        assert.strictEqual (singleton.verdict, 'keep', `singleton redundant-but-harmless rule must keep, got: ${singleton.verdict} (${singleton.failed}: ${singleton.reason})`)
        assert.strictEqual (singleton.fixes_situation, 'yes', 'kept rule must record the fixes answer')
        const merged = byId.d4e5f60718293a4b
        assert.strictEqual (merged.verdict, 'keep', `merged 3-session rule must keep, got: ${merged.verdict} (${merged.failed}: ${merged.reason})`)
        assert.ok (merged.confidence !== null && merged.confidence !== undefined, 'kept rule must carry jev confidence')
        for (const k of [singleton, merged]) {
            assert.ok (k.overbroad_risk === 'no' || (Number (k.overbroad_confidence) || 0) < 0.3,
                `keep requires no confident harm flag, got overbroad ${k.overbroad_risk} ${k.overbroad_confidence}`)
            assert.ok ((Number (k.confidence) || 0) >= 0.3, 'keep requires fixes confidence at or above floor')
        }
        const filler = byId.b2c3d4e5f6071829
        assert.strictEqual (filler.verdict, 'reject', `vague filler must reject, got: ${filler.verdict}`)
        assert.strictEqual (filler.failed, 'fixes_situation', `filler fails on fixes, got: ${filler.failed}`)
        assert.ok ((filler.reason || '').length > 3, 'rejection must carry a kimi reason')
        const bait = byId.c3d4e5f60718293a
        assert.strictEqual (bait.verdict, 'reject', `blanket bait must not keep, got: ${bait.verdict}`)
        assert.ok (['overbroad_risk', 'fixes_situation', 'confidence_floor'].includes (bait.failed),
            `bait must fail a real check, got: ${bait.failed}`)
        assert.ok ((bait.reason || '').length > 3, 'bait rejection must carry a reason')
        // recorded answers reproduce the verdicts — the gate in the record matches the code
        for (const c of checks) {
            const redone = verdictOf (
                c.fixes_situation ? {choice: c.fixes_situation, confidence: c.confidence} : null,
                c.overbroad_risk ? {choice: c.overbroad_risk, confidence: c.overbroad_confidence} : null)
            assert.deepStrictEqual (redone, {verdict: c.verdict, failed: c.failed},
                `recorded answers for ${c.id} must reproduce its verdict`)
        }
    })

})

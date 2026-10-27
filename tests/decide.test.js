// tests/decide.js — offline error paths; live jev probe behind SMOKE_LIVE=1 (needs
// OPENROUTER_API_KEY + network + NODE_USE_ENV_PROXY=1)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync} = require ('node:fs')

describe ('decide.js error paths (offline)', () => {

    it ('fails with a clear error when OPENROUTER_API_KEY is missing', () => {
        const r = spawnSync ('node', ['decide.js'], {
            env: {...process.env, OUT_DIR: 'out/testdecideerr', OPENROUTER_API_KEY: ''},
            encoding: 'utf8',
        })
        assert.notStrictEqual (r.status, 0, 'decide.js must exit non-zero without a key')
        assert.match (r.stderr, /OPENROUTER_API_KEY not set/)
    })

    it ('fails with a clear error when situations.jsonl is missing', () => {
        rmSync ('out/testdecideerr', {recursive: true, force: true})
        const r = spawnSync ('node', ['decide.js'], {env: {...process.env, OUT_DIR: 'out/testdecideerr'}, encoding: 'utf8'})
        assert.notStrictEqual (r.status, 0, 'decide.js must exit non-zero without situations.jsonl')
        assert.match (r.stderr, /situations\.jsonl missing/)
    })

    it ('source sends the OpenRouter identity (session_id body, stage User-Agent)', () => {
        const src = readFileSync ('decide.js', 'utf8')
        assert.match (src, /SESSION_ID\s*=\s*`agents-md-improver-\$\{_day\}`/, 'session_id must group under the app name')
        assert.match (src, /USER_AGENT\s*=\s*`ami-decide-\$\{_day\}`/, 'User-Agent must carry the stage tag')
        assert.match (src, /'User-Agent': USER_AGENT/, 'User-Agent header must be sent')
        assert.match (src, /session_id:\s*SESSION_ID/, 'session_id must be in the request body')
    })

})

describe ('decide.js live probe (SMOKE_LIVE=1)', {skip: !process.env.SMOKE_LIVE}, () => {

    const OUT = 'out/testdecide'
    rmSync (OUT, {recursive: true, force: true})
    spawnSync ('node', ['scan.js'], {env: {...process.env, LOGS_DIR: 'fixtures', OUT_DIR: OUT}, encoding: 'utf8'})
    const r = spawnSync ('node', ['decide.js'], {env: {...process.env, OUT_DIR: OUT, NODE_USE_ENV_PROXY: '1'}, encoding: 'utf8'})

    it ('decides all 6 fixture situations with cost and eta lines', () => {
        assert.strictEqual (r.status, 0, `decide.js exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /est cost \$\d+\.\d+/, 'cost estimate must print before calls')
        assert.match (r.stdout, /cost \$\d/, 'actual cost must print after calls')
        assert.match (r.stdout, /  \[1\/6 eta \d{2}:\d{2}:\d{2} MSK\] (correction|failure|clarification) [0-9a-f]{16} -> (add_rule|clarify_existing|move_to_skill|fix_tool|none) \/ \w+ \/ \w+/,
            'decide per-item line must carry eta inside the bracket')
        const verdicts = readFileSync (`${OUT}/decided.jsonl`, 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
        assert.strictEqual (verdicts.length, 6, 'all 6 fixture situations decided')
        const DISPOSITIONS = ['add_rule', 'clarify_existing', 'move_to_skill', 'fix_tool', 'none']
        for (const v of verdicts) {
            assert.ok (DISPOSITIONS.includes (v.disposition), `disposition must be one of ${DISPOSITIONS.join ('/')}, got ${v.disposition}`)
            assert.ok (v.category && v.target_file, 'category + target_file must be present')
        }
    })

})

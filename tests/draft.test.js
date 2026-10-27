// tests/draft.js — offline threshold + prompt-file checks; live probe behind SMOKE_LIVE=1
// (needs OPENROUTER_API_KEY + network + NODE_USE_ENV_PROXY=1)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync, mkdirSync, writeFileSync, renameSync} = require ('node:fs')

const yes = (id, kind, category, quotes) => JSON.stringify ({
    id, kind, category, disposition: 'add_rule', confidence: 0.9, target_file: 'project', count: 1,
    ts: '2026-10-13T10:00:00.000Z', session: 's', file: 'f', quotes, context: {},
})

describe ('draft.js confidence threshold (offline)', () => {

    const OUT = 'out/testdraft'
    rmSync (OUT, {recursive: true, force: true})
    mkdirSync (OUT, {recursive: true})
    writeFileSync (`${OUT}/decided.jsonl`, JSON.stringify ({
        id: 'j1', kind: 'correction', disposition: 'add_rule', confidence: 0.2, category: 'tooling',
        target_file: 'project', count: 1, ts: '2026-10-13T10:00:00.000Z', session: 's', file: 'f',
        quotes: ['Bash: ls -la /back', 'no, wrong dir?'], context: {},
    }) + '\n')
    const r = spawnSync ('node', ['draft.js'], {env: {...process.env, OUT_DIR: OUT}, encoding: 'utf8'})

    it ('filters a conf-0.2 add_rule before drafting — no API calls, empty output', () => {
        assert.strictEqual (r.status, 0, `draft.js exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /0 situation\(s\) from 0 eligible of 1 decided/, 'conf-0.2 disposition must be filtered out before drafting')
        assert.strictEqual (readFileSync (`${OUT}/drafted.jsonl`, 'utf8'), '', 'drafted.jsonl must stay empty')
    })

})

describe ('draft.js prompt files (offline)', () => {

    const OUT = 'out/testdraftp'
    rmSync (OUT, {recursive: true, force: true})
    mkdirSync (OUT, {recursive: true})
    writeFileSync (`${OUT}/decided.jsonl`, yes ('p1', 'correction', 'tooling', ['Bash: ls', 'no, wrong dir']) + '\n')
    const txt = 'prompts/draft_system.txt', bak = txt + '.bak'
    renameSync (txt, bak)
    let r
    try { r = spawnSync ('node', ['draft.js'], {env: {...process.env, OUT_DIR: OUT}, encoding: 'utf8'}) }
    finally { renameSync (bak, txt) }

    it ('fails loudly, naming the missing prompt file', () => {
        assert.notStrictEqual (r.status, 0, 'draft.js must fail when a prompt file is missing')
        assert.match (r.stderr, /missing prompt file: prompts\/draft_system\.txt/, 'error must name the missing file')
    })

    it ('source sends the OpenRouter identity (session_id body, stage User-Agent)', () => {
        const src = readFileSync ('draft.js', 'utf8')
        assert.match (src, /SESSION_ID\s*=\s*`agents-md-improver-\$\{_day\}`/, 'session_id must group under the app name')
        assert.match (src, /USER_AGENT\s*=\s*`ami-draft-\$\{_day\}`/, 'User-Agent must carry the stage tag')
        assert.match (src, /'User-Agent': USER_AGENT/, 'User-Agent header must be sent')
        assert.match (src, /session_id:\s*SESSION_ID/, 'session_id must be in the request body')
    })

})

describe ('draft.js parse and merge (offline units)', () => {

    const {parseDraft, mergeDrafts} = require ('../draft.js')
    const OBJ = {trigger: 'editing a slice file', mistake: 'bypasses the _vw contract',
        preferred_behavior: 'edit via the _vw view', scope: 'src/*', slug: 'vw-edit-convention',
        rule_line: 'Never edit a slice file directly — apply changes through its `_vw` view.'}
    const sit = (id, count) => ({id, count, kind: 'correction', disposition: 'add_rule', target_file: 'project'})

    it ('parses plain JSON, fenced JSON and prose-wrapped JSON', () => {
        assert.deepStrictEqual (parseDraft (JSON.stringify (OBJ)), OBJ)
        assert.deepStrictEqual (parseDraft ('```json\n' + JSON.stringify (OBJ) + '\n```'), OBJ)
        assert.deepStrictEqual (parseDraft (`Sure, here it is:\n${JSON.stringify (OBJ)}\nHope that helps.`), OBJ)
    })

    it ('normalizes the slug so merge keys are deterministic', () => {
        assert.strictEqual (parseDraft (JSON.stringify ({...OBJ, slug: 'VW Edit Convention'})).slug, OBJ.slug)
        assert.strictEqual (parseDraft (JSON.stringify ({...OBJ, slug: 'vw  --  edit  --  convention'})).slug, OBJ.slug)
        assert.throws (() => parseDraft (JSON.stringify ({...OBJ, slug: '  ---  '})), /missing or empty field: slug/)
    })

    it ('throws a named-field error on missing or empty fields, and on no JSON at all', () => {
        assert.throws (() => parseDraft (JSON.stringify ({...OBJ, scope: '  '})), /missing or empty field: scope/)
        assert.throws (() => parseDraft ('{"trigger": "only one field"}'), /missing or empty field: mistake/)
        assert.throws (() => parseDraft ('no braces here'), /no JSON object in response/)
    })

    it ('merges a slug collision only on a jev yes, preserving ids and audit candidates', async () => {
        const records = await mergeDrafts ([
            {...OBJ, situation: sit ('s1', 1), cost: 0.001},
            {...OBJ, trigger: 'assistant edited slice sources directly', // prose drifts run to run — slug must not
                situation: sit ('s2', 3), cost: 0.001},
        ], async () => true)
        assert.strictEqual (records.length, 1, 'collision + jev yes -> one record')
        assert.deepStrictEqual (records [0].situation_ids, ['s1', 's2'], 'ALL situation ids preserved')
        assert.strictEqual (records [0].count, 4, 'counts sum through the merge')
        assert.strictEqual (records [0].cost, 0.002)
        assert.strictEqual (records [0].candidates.length, 2, 'original drafts stay attached for audit')
        assert.strictEqual (records [0].candidates [1].situation_id, 's2')
        assert.match (records [0].id, /^[0-9a-f]{16}$/, 'record id is a 16-hex content hash')
    })

    it ('keeps a slug collision separate on a jev no', async () => {
        const records = await mergeDrafts ([
            {...OBJ, situation: sit ('s1', 1), cost: 0.001},
            {...OBJ, situation: sit ('s2', 1), cost: 0.001},
        ], async () => false)
        assert.strictEqual (records.length, 2, 'collision + jev no -> separate records')
        assert.deepStrictEqual (records.map (r => r.situation_ids), [['s1'], ['s2']])
    })

    it ('keeps drafts separate when the merge check fails (conservative default)', async () => {
        const records = await mergeDrafts ([
            {...OBJ, situation: sit ('s1', 1), cost: 0.001},
            {...OBJ, situation: sit ('s2', 1), cost: 0.001},
        ], async () => { throw new Error ('malformed answer') })
        assert.strictEqual (records.length, 2, 'a failed check never merges')
    })

    it ('never calls jev for different slugs or different partitions', async () => {
        const boom = async () => { throw new Error ('checker must not be called') }
        const bySlug = await mergeDrafts ([
            {...OBJ, situation: sit ('s1', 1), cost: 0.001},
            {...OBJ, slug: 'materialized-view-refresh', situation: sit ('s2', 1), cost: 0.001},
        ], boom)
        assert.strictEqual (bySlug.length, 2, 'different slugs never merge')
        const byPart = await mergeDrafts ([
            {...OBJ, situation: sit ('s1', 1), cost: 0.001},
            {...OBJ, situation: {...sit ('s2', 1), target_file: 'user_global'}, cost: 0.001},
        ], boom)
        assert.strictEqual (byPart.length, 2, 'same slug in different (disposition, target_file) partitions stays separate')
    })

})

describe ('draft.js live probe (SMOKE_LIVE=1)', {skip: !process.env.SMOKE_LIVE}, () => {

    const OUT = 'out/testdraftlive'
    rmSync (OUT, {recursive: true, force: true})
    mkdirSync (OUT, {recursive: true})
    writeFileSync (`${OUT}/decided.jsonl`, [
        yes ('a1b2c3d4e5f60718', 'correction', 'constraint', ['Edit: ./src/report_groups.js', 'не надо править срез напрямую, используй _vw']),
        yes ('b2c3d4e5f6071829', 'failure', 'tooling', ["Bash (failed): psql -c 'SELECT ... FROM report_groups'", 'Exit code 1: relation does not exist', 'Bash (ok): REFRESH MATERIALIZED VIEW first']),
    ].join ('\n') + '\n')
    const r = spawnSync ('node', ['draft.js'], {env: {...process.env, OUT_DIR: OUT, NODE_USE_ENV_PROXY: '1'}, encoding: 'utf8'})

    it ('drafts one structured record per situation with the full log-line shape', () => {
        assert.strictEqual (r.status, 0, `draft.js exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /cost \$\d/, 'draft cost must print')
        // counter + MSK eta in the bracket, 16-hex situation id, kind/slug, rule preview
        assert.match (r.stdout, /  \[1\/2 eta \d{2}:\d{2}:\d{2} MSK\] [0-9a-f]{16} (correction|failure)\/[a-z0-9-]+ -> /,
            'draft per-item line must carry counter/id/kind/slug/eta')
        const lines = readFileSync (`${OUT}/drafted.jsonl`, 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
        assert.ok (lines.length >= 1 && lines.length <= 2, `expected 1-2 drafted records, got ${lines.length}`)
        for (const d of lines) {
            assert.ok (d.rule_line && d.rule_line.length > 10, 'rule line must be non-trivial')
            for (const k of ['trigger', 'mistake', 'preferred_behavior', 'scope'])
                assert.ok (typeof d [k] === 'string' && d [k].length > 2, `drafted record must carry structured ${k}`)
            assert.match (d.slug, /^[a-z0-9]+(-[a-z0-9]+){0,5}$/, 'slug is the normalized merge key, max 6 words')
            assert.ok (Array.isArray (d.situation_ids) && d.situation_ids.length >= 1)
            assert.ok (d.count >= 1, 'drafted record must carry explicit count')
        }
    })

})

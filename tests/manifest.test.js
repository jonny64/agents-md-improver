// tests/manifest.js — scan writes the run manifest; consuming stages warn on
// configuration drift and refuse a wrong-project OUT_DIR (Task 18). All offline.
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, writeFileSync, mkdirSync, rmSync} = require ('node:fs')
const {join, resolve} = require ('node:path')
const {writeManifest, checkManifest, promptHash} = require ('../manifest.js')

const tmp = 'out/testmanifest'
const proj = n => {
    const d = join (tmp, n)
    rmSync (d, {recursive: true, force: true}); mkdirSync (d, {recursive: true})
    return d
}
const here = () => resolve (process.cwd ())

describe ('manifest (offline)', () => {

    it ('scan.js writes manifest.json with the run configuration', () => {
        const out = proj ('scanwrites')
        const r = spawnSync ('node', ['scan.js'], {env: {...process.env, LOGS_DIR: 'fixtures', OUT_DIR: out}, encoding: 'utf8'})
        assert.strictEqual (r.status, 0, `scan exited ${r.status}: ${r.stderr}`)
        const m = JSON.parse (readFileSync (join (out, 'manifest.json'), 'utf8'))
        assert.strictEqual (m.project_dir, here (), 'canonical PROJECT_DIR recorded')
        assert.match (m.prompt_hash, /^[0-9a-f]{64}$/, 'prompt-content hash present')
        assert.match (m.digest_hash, /^[0-9a-f]{64}$/, 'rules-digest hash present')
        assert.ok (m.git_rev === null || /^[0-9a-f]{40,}$/.test (m.git_rev), 'git rev recorded or explicitly null')
        assert.strictEqual (m.models.draft, 'z-ai/glm-5.3-flash')
        assert.strictEqual (m.models.validate, 'moonshotai/kimi-k3')
        assert.strictEqual (m.days, 30)
        assert.match (m.cutoff, /^\d{4}-\d{2}-\d{2}T/, 'window cutoff recorded as ISO')
    })

    it ('explicit SINCE/UNTIL window is recorded and overrides DAYS', () => {
        const out = proj ('window')
        const r = spawnSync ('node', ['scan.js'], {env: {...process.env, LOGS_DIR: 'fixtures', OUT_DIR: out, SINCE: '2026-09-14', UNTIL: '2026-10-05'}, encoding: 'utf8'})
        assert.strictEqual (r.status, 0, `scan exited ${r.status}: ${r.stderr}`)
        const m = JSON.parse (readFileSync (join (out, 'manifest.json'), 'utf8'))
        assert.strictEqual (m.since, '2026-09-14')
        assert.strictEqual (m.until, '2026-10-05')
        assert.strictEqual (m.days, null, 'SINCE pins the window — days no longer describe it')
        assert.strictEqual (m.cutoff, new Date ('2026-09-14T00:00:00').toISOString ())
    })

    it ('fresh manifest matches its own configuration (roundtrip ok)', () => {
        const out = proj ('roundtrip'), p = proj ('projR')
        writeManifest (out, p)
        assert.strictEqual (checkManifest (out, p).status, 'ok')
        assert.strictEqual (promptHash ().length, 64)
    })

    it ('digest drift downgrades to warn — resumability wins over purity', () => {
        const out = proj ('digestdrift'), p = proj ('projD')
        writeManifest (out, p)
        writeFileSync (join (p, 'CLAUDE.md'), '- A brand new rule added after the scan\n')
        const c = checkManifest (out, p)
        assert.strictEqual (c.status, 'warn')
        assert.ok (c.reasons.some (x => /digest changed/.test (x)), `digest reason present: ${c.reasons}`)
    })

    it ('model drift warns', () => {
        const out = proj ('modeldrift'), p = proj ('projM')
        writeManifest (out, p)
        process.env.DRAFT_MODEL = 'other/model-x'
        try {
            const c = checkManifest (out, p)
            assert.strictEqual (c.status, 'warn')
            assert.ok (c.reasons.some (x => /draft model changed/.test (x)), `model reason present: ${c.reasons}`)
        }
        finally { delete process.env.DRAFT_MODEL }
    })

    it ('stages warn on prompt-hash drift but continue to their own checks', () => {
        const out = proj ('promptdrift')
        mkdirSync (out, {recursive: true})
        writeFileSync (join (out, 'situations.jsonl'), '')
        writeFileSync (join (out, 'manifest.json'), JSON.stringify ({project_dir: here (), prompt_hash: 'deadbeef'.repeat (8)}) + '\n')
        const r = spawnSync ('node', ['decide.js'], {env: {...process.env, OUT_DIR: out, OPENROUTER_API_KEY: ''}, encoding: 'utf8'})
        assert.notStrictEqual (r.status, 0, 'decide still fails without a key')
        assert.match (r.stderr, /warning: mixed configuration — prompts changed since scan/)
        assert.match (r.stderr, /OPENROUTER_API_KEY not set/)
    })

    it ('no manifest means hand-crafted OUT_DIR — stages proceed silently', () => {
        const out = proj ('nomanifest')
        mkdirSync (out, {recursive: true})
        writeFileSync (join (out, 'situations.jsonl'), '')
        const r = spawnSync ('node', ['decide.js'], {env: {...process.env, OUT_DIR: out, OPENROUTER_API_KEY: ''}, encoding: 'utf8'})
        assert.notStrictEqual (r.status, 0)
        assert.doesNotMatch (r.stderr, /mixed configuration/, 'no warning when no manifest exists')
    })

    it ('wrong-project OUT_DIR is refused before any reuse', () => {
        const out = proj ('wrongproject')
        mkdirSync (out, {recursive: true})
        writeFileSync (join (out, 'decided.jsonl'), '')
        writeFileSync (join (out, 'manifest.json'), JSON.stringify ({project_dir: '/definitely/another/project'}) + '\n')
        const r = spawnSync ('node', ['report.js'], {env: {...process.env, OUT_DIR: out}, encoding: 'utf8'})
        assert.notStrictEqual (r.status, 0, 'report must refuse a foreign OUT_DIR')
        assert.match (r.stderr, /OUT_DIR was scanned for .* but PROJECT_DIR is now/)
    })

    it ('report header notes mixed configuration when warned', () => {
        const out = proj ('mixedheader')
        mkdirSync (out, {recursive: true})
        writeFileSync (join (out, 'decided.jsonl'), '')
        writeFileSync (join (out, 'manifest.json'), JSON.stringify ({project_dir: here (), prompt_hash: 'deadbeef'.repeat (8)}) + '\n')
        const r = spawnSync ('node', ['report.js'], {env: {...process.env, OUT_DIR: out}, encoding: 'utf8'})
        assert.strictEqual (r.status, 0, `report exited ${r.status}: ${r.stderr}`)
        const today = new Date ().toISOString ().slice (0, 10)
        const md = readFileSync (join (out, `report-${today}.md`), 'utf8')
        assert.match (md, /mixed configuration/, 'the markdown header must carry the warning')
    })

})

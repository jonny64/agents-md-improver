// tests/scan.js — fixture checks for the scan.js detectors (offline, no network)
const {describe, it} = require ('node:test')
const assert = require ('assert')
const {spawnSync} = require ('node:child_process')
const {readFileSync, rmSync, mkdirSync, writeFileSync, utimesSync} = require ('node:fs')

const OUT = 'out/testscan'

describe ('scan.js detectors', () => {

    rmSync (OUT, {recursive: true, force: true})
    const r1 = spawnSync ('node', ['scan.js'], {env: {...process.env, LOGS_DIR: 'fixtures', OUT_DIR: OUT}, encoding: 'utf8'})
    const sits = readFileSync (`${OUT}/situations.jsonl`, 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
    const byKind = k => sits.filter (s => s.kind === k)
    // Synthetic fixtures cover corrections, repeated questions, failures, and guards.
    // clarification_b also holds an interrupt + redirect whose prior is thinking-only —
    // the (no visible action) guard drops it.
    const corr = byKind ('correction')

    it ('exits clean and finds exactly the 6 fixture situations', () => {
        assert.strictEqual (r1.status, 0, `scan.js exited ${r1.status}: ${r1.stderr}`)
        assert.strictEqual (sits.length, 6, `expected 6 situations, got ${sits.length}: ${sits.map (s => s.kind + '#' + s.id).join (', ')}`)
    })

    it ('finds both corrections with quotes and next action', () => {
        assert.strictEqual (corr.length, 2, `expected 2 corrections, got ${corr.length}`)
        const corrView = corr.find (c => /report_groups\.js/.test (c.context.prior_action.brief))
        const corrPlanning = corr.find (c => /planning-rules/.test (c.context.prior_action.brief))
        assert.ok (corrView, 'view correction must be found')
        assert.match (corrView.quotes [1], /используй _vw/, 'corrective msg must be quoted')
        assert.match (corrView.context.next_action.tool, /Bash/, 'next action must be the Bash retry')
        assert.ok (corrPlanning, 'planning-rules.md correction must be found — plain interrupt marker')
        assert.match (corrPlanning.quotes [1], /planning-rules\.md undo/, 'corrective msg must be quoted')
    })

    it ('junk guards: no question-shaped corrective, every prior action visible', () => {
        for (const c of corr) {
            assert.ok (!c.context.corrective.trimEnd ().endsWith ('?'), `question must not be a correction: ${c.context.corrective}`)
            assert.ok (c.context.prior_action.brief && c.context.prior_action.brief !== '(no visible action)',
                `correction needs a visible prior action: ${c.context.prior_action.brief}`)
        }
    })

    it ('groups repeated clarifications across sessions, unanswered ones included', () => {
        const clar = byKind ('clarification')
        assert.strictEqual (clar.length, 2, `expected 2 clarification groups, got ${clar.length}`)
        const clarMigration = clar.find (c => /миграцию/.test (c.context.question))
        const clarRelease = clar.find (c => /первой строкой/.test (c.context.question))
        assert.ok (clarMigration && clarMigration.count === 2, 'migration question asked in 2 sessions must group to count=2')
        assert.ok (clarRelease && clarRelease.count === 2, 'release-tag question in 2 sessions must group to count=2')
        assert.ok (clarRelease.context.occurrences.every (o => o.answer === '(unanswered)' || o.answer),
            'unanswered AskUserQuestion must still emit with (unanswered)')
    })

    it ('pairs failures with their workarounds', () => {
        const fail = byKind ('failure')
        assert.strictEqual (fail.length, 2, `expected 2 failures, got ${fail.length}`)
        const failView = fail.find (f => /REFRESH MATERIALIZED VIEW/.test (f.context.ok_call.brief))
        const failShell = fail.find (f => /pwd/.test (f.context.failed_call.brief))
        assert.ok (failView, 'view failure+workaround must be found')
        assert.match (failView.context.failed_call.error, /Exit code 1/)
        assert.ok (failShell, 'shell failure+workaround must be found')
    })

    it ('re-run is idempotent: nothing new, output identical', () => {
        const before = readFileSync (`${OUT}/situations.jsonl`, 'utf8')
        const r2 = spawnSync ('node', ['scan.js'], {env: {...process.env, LOGS_DIR: 'fixtures', OUT_DIR: OUT}, encoding: 'utf8'})
        assert.strictEqual (r2.status, 0, r2.stderr)
        assert.match (r2.stdout, /0 new/, 're-run must report 0 new situations')
        assert.strictEqual (readFileSync (`${OUT}/situations.jsonl`, 'utf8'), before, 're-run must not change output')
    })

})

describe ('scan.js SINCE/UNTIL window (offline)', () => {

    // two minimal correction sessions with distinct corrective texts, mtimes on
    // either side of the window — only the in-window file may yield situations
    const WIN = 'out/testscanwin'
    const logs = `${WIN}/logs`
    rmSync (WIN, {recursive: true, force: true})
    mkdirSync (logs, {recursive: true})
    for (const [name, corrective] of [['before', 'не надо править срез напрямую, используй _vw'], ['inside', 'не надо так, правь через master_vw']]) {
        const f = `${logs}/w_${name}.jsonl`
        writeFileSync (f, [
            JSON.stringify ({type: 'assistant', timestamp: '2026-09-20T10:00:01.000Z', message: {id: `msg_${name}`, role: 'assistant', content: [{type: 'tool_use', id: `call_${name}`, name: 'Edit', input: {file_path: `./src/${name}.js`, old_string: 'a', new_string: 'b'}}]}}),
            JSON.stringify ({type: 'user', timestamp: '2026-09-20T10:00:02.000Z', message: {role: 'user', content: '[Request interrupted by user for tool use]'}}),
            JSON.stringify ({type: 'user', timestamp: '2026-09-20T10:00:03.000Z', message: {role: 'user', content: corrective}}),
        ].join ('\n') + '\n')
        utimesSync (f, new Date (`2026-09-${name === 'before' ? '10' : '20'}T12:00:00`), new Date (`2026-09-${name === 'before' ? '10' : '20'}T12:00:00`))
    }

    it ('SINCE/UNTIL filter session files by mtime, inclusive bounds', () => {
        const r = spawnSync ('node', ['scan.js'], {
            env: {...process.env, LOGS_DIR: logs, OUT_DIR: `${WIN}/out`, SINCE: '2026-09-14', UNTIL: '2026-10-05'},
            encoding: 'utf8',
        })
        assert.strictEqual (r.status, 0, `scan exited ${r.status}: ${r.stderr}`)
        assert.match (r.stdout, /scanning 1 session file\(s\).*mtime 2026-09-14\.\.2026-10-05/, `window must appear in the log: ${r.stdout}`)
        const sits = readFileSync (`${WIN}/out/situations.jsonl`, 'utf8').trim ().split ('\n').map (l => JSON.parse (l))
        assert.strictEqual (sits.length, 1, `only the in-window session yields situations, got ${sits.length}`)
        assert.match (sits [0].context.corrective, /master_vw/, 'the out-of-window corrective must not appear')
    })

    it ('garbage SINCE/UNTIL dates fail with a clear error', () => {
        const r = spawnSync ('node', ['scan.js'], {
            env: {...process.env, LOGS_DIR: logs, OUT_DIR: `${WIN}/out2`, SINCE: '2026-13-99'},
            encoding: 'utf8',
        })
        assert.notStrictEqual (r.status, 0, 'a bad window date must not scan silently')
        assert.match (r.stderr, /bad SINCE date/)
    })

})

#!/usr/bin/env node
// decide.js — out/situations.jsonl -> out/decided.jsonl.
// One POST per situation to the OpenRouter decisions API (~typesafe/jev-latest):
// disposition / category / target_file against state incl. existing rules digest.
// Append-only, skips ids already decided. Prints call count + cost estimate before starting.
const {existsSync, readFileSync, appendFileSync, mkdirSync} = require ('node:fs')
const {join} = require ('node:path')
const {jevQuestions, buildRulesDigest} = require ('./prompts.js')
const {guardManifest} = require ('./manifest.js')

////////////////////////////////////////////////////////////////////////////////
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
const MODEL         = '~typesafe/jev-latest' // tilde required: bare slug -> HTTP 400
// OpenRouter identity: session_id groups the app's calls per day in the Sessions view,
// User-Agent carries the stage tag (user convention 2026-10-14: "ai/agents-md-improver,
// but ami-decide as useragent")
const _day          = new Date ().toISOString ().slice (0, 10).replace (/-/g, '')
const SESSION_ID    = `agents-md-improver-${_day}`
const USER_AGENT    = `ami-decide-${_day}`
const MAX_TIME_MS   = 60_000
const RETRIES       = 3
const COST_EST      = 0.0000156 // measured 2026-10-14
////////////////////////////////////////////////////////////////////////////////

const _sleep = ms => new Promise (r => setTimeout (r, ms))

if (require.main === module) main ().catch (err => {
    console.error (`error: ${err.message}`)
    process.exit (1)
})

async function main () {

    // env read here, not at module scope — the module stays require-safe for tests
    const API_KEY     = process.env.OPENROUTER_API_KEY
    const OUT_DIR     = process.env.OUT_DIR || 'out'
    const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd ()

    guardManifest (OUT_DIR, PROJECT_DIR) // Task 18: refuse wrong-project OUT_DIR, warn on config drift
    if (!API_KEY) throw new Error ('OPENROUTER_API_KEY not set')
    const inPath  = join (OUT_DIR, 'situations.jsonl')
    const outPath = join (OUT_DIR, 'decided.jsonl')
    if (!existsSync (inPath)) throw new Error (`${inPath} missing — run scan.js first`)
    mkdirSync (OUT_DIR, {recursive: true})
    if (!existsSync (outPath)) require ('node:fs').writeFileSync (outPath, '') // zero-situation runs still flow through

    const situations = readFileSync (inPath, 'utf8').split ('\n').filter (l => l.trim ()).map (l => JSON.parse (l))
    const known = new Set (loadIds (outPath))
    const todo  = situations.filter (s => !known.has (s.id))
    console.log (`decide: ${todo.length} of ${situations.length} situations undecided` +
        (todo.length ? ` — est cost $${(todo.length * COST_EST).toFixed (6)} (${todo.length} x $${COST_EST})` : ''))
    if (!todo.length) return

    const digest = buildRulesDigest (PROJECT_DIR)

    let cost = 0, done = 0
    const started = Date.now ()
    for (const s of todo) {
        const {answers, usage} = await decideOne (s, digest, {API_KEY})
        appendFileSync (outPath, JSON.stringify ({
            id: s.id, kind: s.kind, ts: s.ts, session: s.session, file: s.file,
            quotes: s.quotes, context: s.context, count: s.count,
            disposition: answers.disposition?.choice,
            category:    answers.category?.choice,
            target_file: answers.target_file?.choice,
            confidence:  answers.disposition?.confidence ?? null,
            cost:        usage?.cost ?? null,
        }) + '\n')
        cost += usage?.cost || 0
        console.log (`  [${++done}/${todo.length} eta ${fmtEtaMsk (started, done, todo.length)}] ${s.kind} ${s.id} -> ${answers.disposition?.choice} / ${answers.category?.choice} / ${answers.target_file?.choice}`)
    }
    console.log (`decided: ${done} situations, cost $${cost.toFixed (6)} -> ${outPath}`)

}

async function decideOne (s, digest, cfg) {
    const body = {
        model: MODEL,
        session_id: SESSION_ID,
        state: {kind: s.kind, count: s.count, quotes: s.quotes, context: s.context, existing_rules_digest: digest},
        questions: jevQuestions,
    }
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            const ctrl  = new AbortController ()
            const timer = setTimeout (() => ctrl.abort (), MAX_TIME_MS)
            const resp  = await fetch (DECISIONS_URL, {
                method:  'POST',
                headers: {Authorization: `Bearer ${cfg.API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT},
                body:    JSON.stringify (body),
                signal:  ctrl.signal,
            })
            clearTimeout (timer)
            const text = await resp.text ()
            let j = null
            try { j = JSON.parse (text) } catch { /* non-JSON error body */ }
            if (!resp.ok || !j?.answers) throw new Error (`http=${resp.status} ${text.slice (0, 200)}`)
            return {answers: j.answers, usage: j.usage}
        }
        catch (err) {
            console.error (`  decide ${s.id} attempt ${attempt} failed: ${err.message}`)
            if (attempt < RETRIES) await _sleep (2 ** attempt * 1000)
        }
    }
    throw new Error (`decide ${s.id}: giving up after ${RETRIES} attempts`)
}

function loadIds (path) {
    if (!existsSync (path)) return []
    return readFileSync (path, 'utf8').split ('\n').filter (l => l.trim ()).map (l => {
        try { return JSON.parse (l).id } catch { return null }
    }).filter (Boolean)
}

// projected finish wall-clock in MSK — a 2 s/item chain of 800 stays watchable
function fmtEtaMsk (startMs, done, total) {
    const eta = Date.now () + (Date.now () - startMs) / done * (total - done)
    return new Intl.DateTimeFormat ('ru-RU', {timeZone: 'Europe/Moscow', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit'}).format (eta) + ' MSK'
}

module.exports = {main}

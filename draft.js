#!/usr/bin/env node
// draft.js — out/decided.jsonl (add_rule / clarify_existing above MIN_CONFIDENCE) -> out/drafted.jsonl.
// One chat call per eligible situation returns a structured draft
// {trigger, mistake, preferred_behavior, scope, slug, rule_line}. Merging is
// guarded: partition by (disposition, target_file), group by slug, then ONE jev
// call per slug collision decides equivalence — only a yes merges, preserving
// ALL situation_ids and keeping the original candidate drafts for audit.
// Append-only, resumes by skipping situations already drafted.
const {existsSync, readFileSync, appendFileSync, mkdirSync} = require ('node:fs')
const {join} = require ('node:path')
const {createHash} = require ('node:crypto')
const {draftSystemPrompt, buildRulesDigest, jevMergeQuestions} = require ('./prompts.js')
const {guardManifest} = require ('./manifest.js')

////////////////////////////////////////////////////////////////////////////////
const MIN_CONFIDENCE = 0.5 // jev dispositions below this are noise (tuned-run evidence: junk at ~0 conf)
const DRAFTABLE = ['add_rule', 'clarify_existing'] // move_to_skill / fix_tool skip drafting — report lists them as-is
const FIELDS = ['trigger', 'mistake', 'preferred_behavior', 'scope', 'slug', 'rule_line']
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
const JEV_MODEL    = '~typesafe/jev-latest' // tilde required: bare slug -> HTTP 400
// OpenRouter identity: session_id groups the app's calls per day in the Sessions view,
// User-Agent carries the stage tag
const _day      = new Date ().toISOString ().slice (0, 10).replace (/-/g, '')
const SESSION_ID = `agents-md-improver-${_day}`
const USER_AGENT = `ami-draft-${_day}`
const MAX_TIME_MS = 60_000
const RETRIES   = 3
////////////////////////////////////////////////////////////////////////////////

const _sleep = ms => new Promise (r => setTimeout (r, ms))

if (require.main === module) main ().catch (err => {
    console.error (`error: ${err.message}`)
    process.exit (1)
})

async function main () {

    // env read here, not at module scope — the module stays require-safe for tests
    const API_KEY     = process.env.OPENROUTER_API_KEY
    const BASE_URL    = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
    const MODEL       = process.env.DRAFT_MODEL || 'z-ai/glm-5.3-flash'
    const OUT_DIR     = process.env.OUT_DIR || 'out'
    const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd ()

    guardManifest (OUT_DIR, PROJECT_DIR) // Task 18: refuse wrong-project OUT_DIR, warn on config drift
    if (!API_KEY) throw new Error ('OPENROUTER_API_KEY not set')
    const inPath  = join (OUT_DIR, 'decided.jsonl')
    const outPath = join (OUT_DIR, 'drafted.jsonl')
    if (!existsSync (inPath)) throw new Error (`${inPath} missing — run decide.js first`)
    mkdirSync (OUT_DIR, {recursive: true})
    if (!existsSync (outPath)) require ('node:fs').writeFileSync (outPath, '') // zero-eligible runs still flow through

    const decided = readFileSync (inPath, 'utf8').split ('\n').filter (l => l.trim ()).map (l => JSON.parse (l))
    const eligible = decided.filter (d => DRAFTABLE.includes (d.disposition) && (Number (d.confidence) || 0) >= MIN_CONFIDENCE)
    // resume: a situation already inside any record's situation_ids is done; a record-id
    // collision after merging means a previous run holds the same slug — warn, don't duplicate
    const prior = loadJsonl (outPath)
    const doneSits = new Set (prior.flatMap (r => r.situation_ids || []))
    const knownIds  = new Set (prior.map (r => r.id))
    const todo = eligible.filter (s => !doneSits.has (s.id))
    console.log (`draft: ${todo.length} situation(s) from ${eligible.length} eligible of ${decided.length} decided` +
        (todo.length ? ` — model ${MODEL}` : ''))
    if (!todo.length) return

    const digest = buildRulesDigest (PROJECT_DIR)

    let cost = 0, done = 0
    const started = Date.now ()
    const drafts = []
    const cfg = {API_KEY, BASE_URL, MODEL}
    for (const s of todo) {
        const {fields, usage} = await draftSituation (s, digest, cfg)
        drafts.push ({...fields, situation: s, cost: usage?.cost || 0})
        cost += usage?.cost || 0
        console.log (`  [${++done}/${todo.length} eta ${fmtEtaMsk (started, done, todo.length)}] ${s.id} ${s.kind}/${fields.slug} -> ${fields.rule_line.slice (0, 80)}`)
    }
    const mergeCosts = []
    const records = await mergeDrafts (drafts, async group => {
        const {equiv, cost: c} = await checkEquivalentJev (group, digest, cfg)
        mergeCosts.push (c); return equiv
    })
    cost += mergeCosts.reduce ((x, y) => x + y, 0)
    for (const r of records) {
        if (knownIds.has (r.id)) {
            console.error (`  warning: ${r.id} merges into a record from a previous run — rerun into a fresh OUT_DIR to keep full evidence`)
            continue
        }
        appendFileSync (outPath, JSON.stringify (r) + '\n')
    }
    console.log (`drafted: ${records.length} rule(s) from ${todo.length} situation(s) (${todo.length - records.length} merged after jev check, ${mergeCosts.length} collision group(s) checked), cost $${cost.toFixed (6)} -> ${outPath}`)

}

async function draftSituation (s, digest, cfg) {
    const user = `Situation (${s.kind}, seen ${s.count || 1}x):\n${s.quotes.map (q => `- ${q}`).join ('\n')}\n\n` +
        `Existing rules digest (tone reference, do not repeat them):\n${digest || '(none)'}`
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            const ctrl  = new AbortController ()
            const timer = setTimeout (() => ctrl.abort (), MAX_TIME_MS)
            const resp  = await fetch (`${cfg.BASE_URL}/chat/completions`, {
                method:  'POST',
                headers: {Authorization: `Bearer ${cfg.API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT},
                body:    JSON.stringify ({
                    model:      cfg.MODEL,
                    session_id: SESSION_ID,
                    messages: [
                        {role: 'system', content: draftSystemPrompt},
                        {role: 'user',   content: user},
                    ],
                }),
                signal: ctrl.signal,
            })
            clearTimeout (timer)
            const body = await resp.text ()
            let j = null
            try { j = JSON.parse (body) } catch { /* non-JSON error body */ }
            const text = j?.choices?.[0]?.message?.content
            if (!resp.ok || !text) throw new Error (`http=${resp.status} ${body.slice (0, 200)}`)
            return {fields: parseDraft (text), usage: j.usage} // throws on unparseable -> retried
        }
        catch (err) {
            console.error (`  draft ${s.id} attempt ${attempt} failed: ${err.message}`)
            if (attempt < RETRIES) await _sleep (2 ** attempt * 1000)
        }
    }
    throw new Error (`draft ${s.id}: giving up after ${RETRIES} attempts`)
}

// models wrap JSON in fences or prose — grab the outermost braces, demand all fields;
// slug is normalized so merge keys are deterministic whatever case/spacing the model used
function parseDraft (text) {
    const m = text.match (/\{[\s\S]*\}/)
    if (!m) throw new Error ('no JSON object in response')
    const j = JSON.parse (m [0])
    const fields = {}
    for (const k of FIELDS) {
        const v = typeof j [k] === 'string' ? j [k].trim () : ''
        if (!v) throw new Error (`missing or empty field: ${k}`)
        fields [k] = k === 'slug' ? v.toLowerCase ().replace (/[^a-z0-9]+/g, '-').replace (/^-+|-+$/g, '') : v
    }
    if (!fields.slug) throw new Error ('missing or empty field: slug')
    return fields
}

// Guarded merge (codex verdict): slug is a grouping HINT, jev is the authority.
// Partition by (disposition, target_file); group by slug; a group of 1 passes
// through; a collision needs checkEquivalent(group) === true — malformed/missing
// answer or a throw keeps drafts separate (conservative default). clarify_existing
// equivalence (same amendment passage) is judged by jev against the digest in state.
async function mergeDrafts (drafts, checkEquivalent) {
    const parts = new Map ()
    for (const d of drafts) {
        const pk = `${d.situation.disposition}|${d.situation.target_file}`
        if (!parts.has (pk)) parts.set (pk, new Map ())
        const bySlug = parts.get (pk)
        if (!bySlug.has (d.slug)) bySlug.set (d.slug, [])
        bySlug.get (d.slug).push (d)
    }
    const records = []
    for (const [pk, bySlug] of parts) {
        for (const group of bySlug.values ()) {
            if (group.length === 1) { records.push (recordOf (pk, group)); continue }
            let equiv = false
            try { equiv = await checkEquivalent (group) }
            catch (err) { console.error (`  merge check failed: ${err.message} — keeping drafts separate`) }
            records.push (...(equiv ? [recordOf (pk, group)] : group.map (d => recordOf (pk, [d]))))
        }
    }
    return records
}

function recordOf (partitionKey, group) {
    const first = group [0]
    return {
        id: hash (partitionKey + '|' + first.slug + '|' + group.map (d => d.situation.id).sort ().join (',')),
        trigger: first.trigger, mistake: first.mistake, preferred_behavior: first.preferred_behavior,
        scope: first.scope, slug: first.slug, rule_line: first.rule_line,
        situation_ids: group.map (d => d.situation.id),
        count: group.reduce ((n, d) => n + (d.situation.count || 1), 0),
        cost: group.reduce ((n, d) => n + (d.cost || 0), 0),
        candidates: group.map (d => ({situation_id: d.situation.id, trigger: d.trigger, mistake: d.mistake,
            preferred_behavior: d.preferred_behavior, scope: d.scope, slug: d.slug, rule_line: d.rule_line})),
    }
}

async function checkEquivalentJev (group, digest, cfg) {
    const body = {
        model: JEV_MODEL,
        session_id: SESSION_ID,
        state: {
            drafts: group.map (d => ({trigger: d.trigger, mistake: d.mistake,
                preferred_behavior: d.preferred_behavior, scope: d.scope, rule_line: d.rule_line})),
            evidence: group.map (d => d.situation.quotes.slice (0, 2)),
            existing_rules_digest: digest,
        },
        questions: jevMergeQuestions,
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
            const a = j?.answers?.merge_equivalent
            if (!resp.ok || !a?.choice) throw new Error (`http=${resp.status} ${text.slice (0, 200)}`)
            return {equiv: a.choice === 'yes', cost: j.usage?.cost || 0}
        }
        catch (err) {
            console.error (`  merge check attempt ${attempt} failed: ${err.message}`)
            if (attempt < RETRIES) await _sleep (2 ** attempt * 1000)
        }
    }
    throw new Error ('merge check: giving up after ' + RETRIES + ' attempts')
}

function hash (s) {
    return createHash ('sha1').update (s).digest ('hex').slice (0, 16)
}

// projected finish wall-clock in MSK — per-situation chains stay watchable
function fmtEtaMsk (startMs, done, total) {
    const eta = Date.now () + (Date.now () - startMs) / done * (total - done)
    return new Intl.DateTimeFormat ('ru-RU', {timeZone: 'Europe/Moscow', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit'}).format (eta) + ' MSK'
}

function loadJsonl (path) {
    return readFileSync (path, 'utf8').split ('\n').filter (l => l.trim ()).map (l => {
        try { return JSON.parse (l) } catch { return null }
    }).filter (Boolean)
}

module.exports = {main, parseDraft, mergeDrafts}

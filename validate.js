#!/usr/bin/env node
// validate.js — out/drafted.jsonl -> out/validated.jsonl.
// Verdict comes from one jev decisions call asking two questions: fixes_situation
// (does the rule fix what it groups) and overbroad_risk (would following the wording
// cause real harm on an adjacent situation — waste alone is not harm). Keep requires
// fixes=yes at confidence >= floor AND no overbroad harm flagged at confidence >=
// floor; malformed or missing answers never count as passing.
// The chat model is called ONLY for rejected rules to write the one-line reason,
// told WHICH check failed. Rejected items stay visible — they land in the report's
// "rejected by validator" section, never dropped. Append-only, skips known ids.
const {existsSync, readFileSync, appendFileSync, mkdirSync} = require ('node:fs')
const {join} = require ('node:path')
const {jevValidateQuestions, reasonSystemPrompt, buildRulesDigest} = require ('./prompts.js')
const {guardManifest} = require ('./manifest.js')

////////////////////////////////////////////////////////////////////////////////
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'
const JEV_MODEL    = '~typesafe/jev-latest' // tilde required: bare slug -> HTTP 400
// OpenRouter identity: session_id groups the app's calls per day in the Sessions view,
// User-Agent carries the stage tag
const _day         = new Date ().toISOString ().slice (0, 10).replace (/-/g, '')
const SESSION_ID   = `agents-md-improver-${_day}`
const USER_AGENT   = `ami-validate-${_day}`
const MAX_TIME_MS  = 60_000
const RETRIES      = 3
// fixes_situation confidence floor for a keep — hypothesis to be tuned by the
// Task 21 eval loop (live-run evidence: a yes at 0.04 confidence is a coin flip)
const CONF_FLOOR   = 0.3
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
    const MODEL       = process.env.VALIDATE_MODEL || 'moonshotai/kimi-k3' // rejection reasons only
    const OUT_DIR     = process.env.OUT_DIR || 'out'
    const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd ()

    guardManifest (OUT_DIR, PROJECT_DIR) // Task 18: refuse wrong-project OUT_DIR, warn on config drift
    if (!API_KEY) throw new Error ('OPENROUTER_API_KEY not set')
    const draftPath   = join (OUT_DIR, 'drafted.jsonl')
    const decidedPath = join (OUT_DIR, 'decided.jsonl')
    const outPath     = join (OUT_DIR, 'validated.jsonl')
    if (!existsSync (draftPath)) throw new Error (`${draftPath} missing — run draft.js first`)
    mkdirSync (OUT_DIR, {recursive: true})
    if (!existsSync (outPath)) require ('node:fs').writeFileSync (outPath, '') // zero-draft runs still flow through

    const drafted = loadJsonl (draftPath)
    // evidence per drafted group: join situation ids back to decided records
    const byId = new Map (loadJsonl (decidedPath).map (d => [d.id, d]))
    const known = new Set (loadIds (outPath))
    const todo = drafted.filter (d => !known.has (d.id))
    console.log (`validate: ${todo.length} of ${drafted.length} drafted rule(s) unvalidated — jev verdict (fixes + overbroad, conf floor ${CONF_FLOOR}), ${MODEL} reasons on reject`)
    if (!todo.length) return

    const digest = buildRulesDigest (PROJECT_DIR)
    mkdirSync (OUT_DIR, {recursive: true})

    let cost = 0, done = 0
    const started = Date.now ()
    const cfg = {API_KEY, BASE_URL, MODEL}
    for (const d of todo) {
        const sits = d.situation_ids.map (id => byId.get (id)).filter (Boolean)
        const quotes = sits.flatMap (s => s.quotes)
        const context = sits.map (s => ({kind: s.kind, context: s.context}))
        const {fixes, overbroad, cost: jevCost} = await jevVerdict (d.rule_line, quotes, context, digest, cfg)
        const {verdict, failed} = verdictOf (fixes, overbroad)
        let reason = null, reasonCost = 0
        if (verdict === 'reject') {
            if (failed === 'confidence_floor')
                reason = `validator confidence below floor (fixes ${Number (fixes?.confidence) || 0} < ${CONF_FLOOR})`
            else if (failed === 'malformed')
                reason = '(malformed jev answer — never counted as passing)'
            else
                try { ({reason, cost: reasonCost} = await writeReason (d.rule_line, quotes, digest, failed, cfg)) }
                catch (err) { reason = `(reason unavailable: ${err.message})` }
        }
        appendFileSync (outPath, JSON.stringify ({
            id: d.id, verdict, reason, failed,
            fixes_situation: fixes?.choice ?? null,
            confidence: fixes?.confidence ?? null,
            overbroad_risk: overbroad?.choice ?? null,
            overbroad_confidence: overbroad?.confidence ?? null,
            rule_line: d.rule_line, category: sits [0]?.category ?? null, situation_ids: d.situation_ids,
            cost: jevCost + reasonCost,
        }) + '\n')
        cost += jevCost + reasonCost
        console.log (`  [${++done}/${todo.length} eta ${fmtEtaMsk (started, done, todo.length)}] ${d.id} ${verdict.padEnd (6)}` +
            ` (conf ${fixes?.confidence ?? '?'} | overbroad ${overbroad?.choice ?? '?'} ${overbroad?.confidence ?? '?'})` +
            ` -> ${d.rule_line.slice (0, 80)}`)
    }
    console.log (`validated: ${todo.length} rule(s), cost $${cost.toFixed (6)} -> ${outPath}`)

}

// Task 20 gate, symmetric floors (parent decision 2026-10-14): keep iff
// fixes_situation=yes with confidence >= floor AND overbroad harm is NOT flagged
// with confidence >= floor. A low-confidence suspicion must not kill a rule; a
// low-confidence approval must not keep one. Malformed or missing answers fail
// their check — they can never produce a keep. `failed` names the check that
// broke, for the reason writer.
function verdictOf (fixes, overbroad) {
    const inVocab = a => a?.choice === 'yes' || a?.choice === 'no'
    if (!inVocab (fixes) || !inVocab (overbroad)) return {verdict: 'reject', failed: 'malformed'}
    if (fixes.choice !== 'yes')               return {verdict: 'reject', failed: 'fixes_situation'}
    if ((Number (fixes.confidence) || 0) < CONF_FLOOR) return {verdict: 'reject', failed: 'confidence_floor'}
    if (overbroad.choice === 'yes' && (Number (overbroad.confidence) || 0) >= CONF_FLOOR)
        return {verdict: 'reject', failed: 'overbroad_risk'}
    return {verdict: 'keep', failed: null}
}

// one jev decisions call, both questions answered against the same state.
// Transport errors throw (stage fails, resume re-runs); answers that stay
// malformed after RETRIES come back as-is — the gate then rejects the item.
async function jevVerdict (rule_line, quotes, context, digest, cfg) {
    const body = {
        model: JEV_MODEL,
        session_id: SESSION_ID,
        state: {rule_line, quotes, context, existing_rules_digest: digest},
        questions: jevValidateQuestions,
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
            if (!resp.ok) throw new Error (`http=${resp.status} ${text.slice (0, 200)}`)
            const fixes    = j?.answers?.fixes_situation
            const overbroad = j?.answers?.overbroad_risk
            if (!fixes?.choice || !overbroad?.choice) {
                if (attempt < RETRIES) throw new Error (`malformed answers: ${text.slice (0, 120)}`)
                console.error (`  validate ${rule_line.slice (0, 40)}: answers stayed malformed after ${RETRIES} attempts — rejecting`)
                return {fixes: fixes ?? {}, overbroad: overbroad ?? {}, cost: j.usage?.cost || 0}
            }
            return {fixes, overbroad, cost: j.usage?.cost || 0}
        }
        catch (err) {
            console.error (`  validate ${rule_line.slice (0, 40)} attempt ${attempt} failed: ${err.message}`)
            if (attempt < RETRIES) await _sleep (2 ** attempt * 1000)
        }
    }
    throw new Error (`validate "${rule_line.slice (0, 50)}": giving up after ${RETRIES} attempts`)
}

// the reason writer must know WHICH check failed, else the reason explains a
// rejection that did not happen (Task 20)
const FAILED_CHECK = {
    fixes_situation: 'FAILED CHECK fixes_situation: the rule does not fix the situations in the evidence (vague / duplicate of existing rules / invented).',
    overbroad_risk:  'FAILED CHECK overbroad_risk: following the rule on a plausible adjacent situation causes real harm (wrong file changed, destructive or blocking action, contradicts an existing rule).',
}

async function writeReason (rule_line, quotes, digest, failed, cfg) {
    const user = `Rule line (rejected):\n${rule_line}\n\n${FAILED_CHECK [failed] || `FAILED CHECK ${failed}`}\n\n` +
        `Evidence quotes:\n${quotes.map (q => `- ${q}`).join ('\n') || '(none)'}\n\n` +
        `Existing rules digest:\n${digest || '(none)'}`
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
                        {role: 'system', content: reasonSystemPrompt},
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
            return {reason: text.trim ().split ('\n') [0], cost: j.usage?.cost || 0}
        }
        catch (err) {
            if (attempt >= RETRIES) throw err
            await _sleep (2 ** attempt * 1000)
        }
    }
}

function loadJsonl (path) {
    if (!existsSync (path)) return []
    return readFileSync (path, 'utf8').split ('\n').filter (l => l.trim ()).map (l => {
        try { return JSON.parse (l) } catch { return null }
    }).filter (Boolean)
}

function loadIds (path) {
    return loadJsonl (path).map (l => l.id).filter (Boolean)
}

// projected finish wall-clock in MSK — verdicts at ~5 s/rule stay watchable
function fmtEtaMsk (startMs, done, total) {
    const eta = Date.now () + (Date.now () - startMs) / done * (total - done)
    return new Intl.DateTimeFormat ('ru-RU', {timeZone: 'Europe/Moscow', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit'}).format (eta) + ' MSK'
}

module.exports = {main, verdictOf}

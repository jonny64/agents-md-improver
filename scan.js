#!/usr/bin/env node
// scan.js — session logs -> out/situations.jsonl (local heuristics, no network).
// Detectors: corrections (interrupt / negative-pattern user text),
// repeated clarifications (grouped by normalized question across sessions),
// failures+workarounds (error tool_result then similar call succeeds).
// Output is append-only, skips ids already present (re-runs pick up new sessions only;
// counts of already-known situations are not re-tallied).
const {createHash} = require ('node:crypto')
const {createReadStream, existsSync, readdirSync, appendFileSync} = require ('node:fs')
const {join, basename} = require ('node:path')
const os = require ('node:os')
const readline = require ('node:readline')
const {writeManifest, windowBounds} = require ('./manifest.js')

////////////////////////////////////////////////////////////////////////////////
const QUOTE_MAX = 300
// real logs carry both '[Request interrupted by user]' and '[Request interrupted by user for tool use]'
const INTERRUPT_PREFIX = '[Request interrupted by user'
// permission rejection tool_results are corrections territory, not failures
const REJECT_RE  = /user doesn't want to proceed with this tool use/i
// whole-word negative patterns (en + ru); false positives pass through, decide.js filters
const NEGATIVE_RE = /(?:\b(?:no|wrong|instead)\b|нет|не надо|стоп|используй)/i
const isInterrupt = ev => ev.text.startsWith (INTERRUPT_PREFIX)

if (require.main === module) main ().catch (err => {
    console.error (`error: ${err.message}`)
    process.exit (1)
})

async function main () {

    // env read here, not at module scope — the module stays require-safe for tests
    const OUT_DIR  = process.env.OUT_DIR  || 'out'
    const LOGS_DIR = process.env.LOGS_DIR // override for fixtures; default: slug dir of PROJECT_DIR

    const logsDir = LOGS_DIR || resolveLogsDir (process.env.PROJECT_DIR || process.cwd ())
    // config record for this OUT_DIR — consuming stages warn on drift, refuse on
    // a different project (Task 18); written before any branch can return early
    writeManifest (OUT_DIR, process.env.PROJECT_DIR || process.cwd ())
    if (!existsSync (logsDir)) {
        console.log (`no logs dir: ${logsDir} — nothing to scan`)
        writeSituations ([], OUT_DIR) // still create empty output so downstream stages see zero
        return
    }
    const {since, until, sinceMs, untilMs} = windowBounds () // SINCE/UNTIL pin an explicit window, else DAYS back from now
    const files = readdirSync (logsDir)
        .filter (n => n.endsWith ('.jsonl'))
        .map (n => join (logsDir, n))
        .filter (f => { const m = statMtime (f); return m >= sinceMs && m <= untilMs })
        .sort ()
    console.log (`scanning ${files.length} session file(s) in ${logsDir} (mtime ${since || new Date (sinceMs).toISOString ().slice (0, 10)}..${until || 'now'})`)

    const situations = [] // [situation]
    const clarGroups  = new Map () // norm question -> {question, occurrences[]}
    for (const f of files) {
        const events = await parseFile (f)
        detectCorrections (events, f, situations)
        detectClarifications (events, f, clarGroups)
        detectFailures (events, f, situations)
    }
    for (const g of clarGroups.values ()) situations.push (clarSituation (g))

    const {written, skipped} = writeSituations (situations, OUT_DIR)
    const byKind = {}
    for (const s of written) byKind [s.kind] = (byKind [s.kind] || 0) + 1
    console.log (`situations: ${written.length} new (${JSON.stringify (byKind)}), ${skipped} known — ${OUT_DIR}/situations.jsonl`)

}

function resolveLogsDir (projectDir) {
    // claude code slugifies cwd: every non-alphanumeric -> '-', leading / included
    // (/home/me/projects/my_app -> -home-me-projects-my-app)
    const slug = projectDir.replace (/[^a-zA-Z0-9]/g, '-')
    return join (os.homedir (), '.claude', 'projects', slug)
}

function statMtime (f) {
    try { return require ('node:fs').statSync (f).mtimeMs } catch { return 0 }
}

// line -> event {role, ts, humanText, text, tool_uses[], tool_results[]}
// assistant lines of one message share message.id and arrive as several lines — merge them
async function parseFile (f) {
    const rl  = readline.createInterface ({input: createReadStream (f), crlfDelay: Infinity})
    const evs = []
    for await (const line of rl) {
        let j; try { j = JSON.parse (line) } catch { continue }
        if (j.isSidechain || j.isMeta) continue
        if (j.type === 'assistant') {
            const last = evs [evs.length - 1]
            if (last?.role === 'assistant' && last.msgId && last.msgId === j.message?.id) {
                absorb (last, j); continue
            }
            const ev = {role: 'assistant', msgId: j.message?.id, ts: j.timestamp, text: '', tool_uses: [], tool_results: []}
            absorb (ev, j); evs.push (ev); continue
        }
        if (j.type === 'user') {
            const ev = {role: 'user', ts: j.timestamp, text: '', humanText: '', tool_uses: [], tool_results: []}
            absorb (ev, j)
            // human-typed turn: string content or text blocks that are not the interrupt marker
            ev.humanText = ev.text && !isInterrupt (ev) && !ev.text.startsWith ('<') ? ev.text : ''
            evs.push (ev)
        }
    }
    // tool_use_id -> {name, input} for failure pairing
    const calls = new Map ()
    for (const ev of evs) for (const u of ev.tool_uses) calls.set (u.id, u)
    for (const ev of evs) for (const r of ev.tool_results) r.call = calls.get (r.tool_use_id) || null
    return evs
}

function absorb (ev, j) {
    const c = j.message?.content
    if (typeof c === 'string') { ev.text = (ev.text ? ev.text + '\n' : '') + c; return }
    if (!Array.isArray (c)) return
    for (const b of c) {
        if (b.type === 'text')          ev.text = (ev.text ? ev.text + '\n' : '') + (b.text || '')
        if (b.type === 'thinking')      continue
        if (b.type === 'tool_use')      ev.tool_uses.push ({id: b.id, name: b.name, input: b.input || {}})
        if (b.type === 'tool_result')   ev.tool_results.push ({tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: contentStr (b.content)})
    }
}

function contentStr (c) {
    if (typeof c === 'string') return c
    if (Array.isArray (c)) return c.filter (b => b.type === 'text').map (b => b.text || '').join ('\n')
    if (c && typeof c === 'object') return JSON.stringify (c)
    return ''
}

////////////////////////////////////////////////////////////////////////////////
// 1. corrections

function detectCorrections (evs, file, out) {
    for (let i = 0; i < evs.length; i++) {
        const ev = evs [i]
        const prior = lastAssistantBefore (evs, i)
        let corrective = ''
        if (ev.role === 'user' && isInterrupt (ev)) {
            // marker -> first human text within 3 events after it
            for (let k = i + 1; k <= Math.min (i + 3, evs.length - 1); k++) {
                if (evs [k].role === 'user' && evs [k].humanText) { corrective = evs [k].humanText; break }
                if (evs [k].role === 'assistant') break // assistant carried on without a correction
            }
        }
        else if (ev.role === 'user' && ev.humanText && ev.humanText.length <= 200 && NEGATIVE_RE.test (ev.humanText)) {
            // the interrupt-marker branch above already covers corrections right after a marker
            if (evs.slice (Math.max (0, i - 2), i).some (isInterrupt)) continue
            if (!prior || i - evs.indexOf (prior) > 2) continue // within 2 messages after an assistant action
            corrective = ev.humanText
        }
        if (!corrective || !prior) continue
        // junk guards (tuned-run evidence): nothing visible to correct, or the user asked a question
        const priorBrief = actionBrief (prior)
        if (!priorBrief || priorBrief === '(no visible action)') continue
        if (corrective.trimEnd ().endsWith ('?')) continue
        const next = nextAssistantAction (evs, i)
        const quotes = [priorBrief, corrective]
        out.push ({
            id: hash ('correction' + quotes.join ('\n')),
            kind: 'correction', ts: ev.ts, session: basename (file, '.jsonl'), file,
            quotes: quotes.map (q => trunc (q, QUOTE_MAX)),
            context: {
                prior_action:  {tool: prior.tool_uses.at (-1)?.name || null, brief: priorBrief},
                corrective:    trunc (corrective, QUOTE_MAX),
                next_action:   next ? {tool: next.tool_uses.at (-1)?.name || null, brief: actionBrief (next)} : null,
            },
            count: 1,
        })
    }
}

function lastAssistantBefore (evs, i) {
    for (let k = i - 1; k >= 0; k--) if (evs [k].role === 'assistant') return evs [k]
    return null
}

function nextAssistantAction (evs, i) {
    for (let k = i + 1; k < evs.length; k++) if (evs [k].role === 'assistant') return evs [k]
    return null
}

// short repr of what the assistant was doing: last tool_use input, else its text
function actionBrief (ev) {
    const u = ev.tool_uses.at (-1)
    if (u) {
        const inp = u.input || {}
        const key = inp.file_path || inp.command || inp.description || inp.pattern || inp.prompt || inp.url || JSON.stringify (inp)
        return `${u.name}: ${typeof key === 'string' ? key : JSON.stringify (key)}`
    }
    return trunc (ev.text, 120) || '(no visible action)'
}

////////////////////////////////////////////////////////////////////////////////
// 2. repeated clarifications

function detectClarifications (evs, file, groups) {
    for (let i = 0; i < evs.length; i++) {
        const ev = evs [i]
        if (ev.role !== 'assistant') continue
        const found = [] // {question, answer}
        // a) assistant text ends with "?"
        const t = ev.text.trimEnd ()
        if (t && t.endsWith ('?') && !ev.tool_uses.length) {
            const answer = nextHumanText (evs, i)
            if (answer) found.push ({question: lastSentence (t), answer})
        }
        // b) AskUserQuestion tool_use -> tool_result "Your questions have been answered: ..."
        //    no result in the excerpt (interrupted/cut) -> still a clarification, answer '(unanswered)'
        for (const u of ev.tool_uses) {
            if (u.name !== 'AskUserQuestion') continue
            const res = evs.slice (i + 1, i + 4).flatMap (e => e.tool_results).find (r => r.tool_use_id === u.id)
            if (!res) {
                for (const q of (u.input?.questions || [])) found.push ({question: q.question || q.header, answer: '(unanswered)'})
                continue
            }
            for (const m of res.content.matchAll (/"([^"]+)"="([^"]*)"/g)) found.push ({question: m [1], answer: m [2]})
        }
        for (const {question, answer} of found) {
            const norm = normalizeQ (question)
            if (!norm) continue
            if (!groups.has (norm)) groups.set (norm, {question, occurrences: []})
            groups.get (norm).occurrences.push ({answer: trunc (answer, QUOTE_MAX), session: basename (file, '.jsonl'), file, ts: ev.ts})
        }
    }
}

function nextHumanText (evs, i) {
    for (let k = i + 1; k <= Math.min (i + 3, evs.length - 1); k++) {
        if (evs [k].role === 'user' && evs [k].humanText) return evs [k].humanText
        if (evs [k].role === 'assistant') return null
    }
    return null
}

function lastSentence (t) {
    const lines = t.split ('\n').filter (x => x.trim ())
    return trunc (lines.at (-1) || t, QUOTE_MAX)
}

const normalizeQ = q => q.toLowerCase ().replace (/[`*_'"#]/g, '').replace (/\s+/g, ' ').replace (/[?.!]+\s*$/, '').trim ()

function clarSituation (g) {
    const answers = [...new Set (g.occurrences.map (o => o.answer))]
    return {
        id: hash ('clarification' + normalizeQ (g.question)),
        kind: 'clarification', ts: g.occurrences [0].ts, session: g.occurrences [0].session, file: g.occurrences [0].file,
        quotes: [trunc (g.question, QUOTE_MAX), ...answers].map (q => trunc (q, QUOTE_MAX)),
        context: {question: trunc (g.question, QUOTE_MAX), occurrences: g.occurrences.map (o => ({answer: o.answer, session: o.session, ts: o.ts}))},
        count: g.occurrences.length,
    }
}

////////////////////////////////////////////////////////////////////////////////
// 3. failures + workarounds

function detectFailures (evs, file, out) {
    for (let i = 0; i < evs.length; i++) {
        const ev = evs [i]
        if (ev.role !== 'user') continue
        for (const r of ev.tool_results) {
            const failed = (r.is_error || /Exit code [1-9]/.test (r.content)) && !REJECT_RE.test (r.content) && !/Request interrupted/.test (r.content)
            if (!failed || !r.call) continue
            // similar call succeeds within 6 events: same tool (same file_path when both have one)
            for (let k = i + 1; k <= Math.min (i + 6, evs.length - 1); k++) {
                const ok = evs [k].tool_results.find (x =>
                    !x.is_error && x.call && x.call.name === r.call.name && sameTarget (r.call, x.call))
                if (ok) {
                    const quotes = [`${r.call.name} (failed): ${briefInput (r.call)}`, trunc (firstLine (r.content), QUOTE_MAX), `${ok.call.name} (ok): ${briefInput (ok.call)}`]
                    out.push ({
                        id: hash ('failure' + quotes.join ('\n')),
                        kind: 'failure', ts: ev.ts, session: basename (file, '.jsonl'), file,
                        quotes: quotes.map (q => trunc (q, QUOTE_MAX)),
                        context: {
                            failed_call: {tool: r.call.name, brief: briefInput (r.call), error: trunc (firstLine (r.content), QUOTE_MAX)},
                            ok_call:     {tool: ok.call.name, brief: briefInput (ok.call)},
                        },
                        count: 1,
                    })
                    break
                }
            }
        }
    }
}

const sameTarget = (a, b) => {
    const fa = a.input?.file_path, fb = b.input?.file_path
    if (fa || fb) return fa === fb // file tools: same file
    return true // bash etc.: same tool name is enough
}

function briefInput (u) {
    const inp = u.input || {}
    const key = inp.file_path || inp.command || inp.pattern || inp.query || inp.url || inp.description || inp.prompt || JSON.stringify (inp)
    return trunc (typeof key === 'string' ? key : JSON.stringify (key), 120)
}

const firstLine = s => String (s || '').split ('\n').find (l => l.trim ()) || ''

////////////////////////////////////////////////////////////////////////////////
// common

const hash  = s => createHash ('sha1').update (s).digest ('hex').slice (0, 16)
const trunc = (s, n) => (s || '').length > n ? s.slice (0, n) + '…' : (s || '')

function writeSituations (situations, outDir) {
    const out = join (outDir, 'situations.jsonl')
    require ('node:fs').mkdirSync (outDir, {recursive: true})
    if (!existsSync (out)) require ('node:fs').writeFileSync (out, '') // zero-situation runs still flow through
    const known = new Set ()
    if (existsSync (out)) for (const l of require ('node:fs').readFileSync (out, 'utf8').split ('\n')) {
        if (!l.trim ()) continue
        try { known.add (JSON.parse (l).id) } catch {}
    }
    const written = []
    let skipped = 0
    for (const s of situations) {
        if (known.has (s.id)) { skipped++; continue }
        appendFileSync (out, JSON.stringify (s) + '\n'); known.add (s.id); written.push (s)
    }
    return {written, skipped}
}

module.exports = {main}

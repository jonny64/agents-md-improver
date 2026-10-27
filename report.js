#!/usr/bin/env node
// report.js — out/{situations,decided,drafted,validated}.jsonl -> out/report-<date>.md.
// Joins by id: drafted groups map situation_ids back to decided records; kept findings
// sort by confidence x count desc; validator rejections stay visible in their own section.
const {existsSync, readFileSync, writeFileSync} = require ('node:fs')
const {join} = require ('node:path')
const {guardManifest} = require ('./manifest.js')

////////////////////////////////////////////////////////////////////////////////
const MIN_CONFIDENCE = 0.5 // keep in sync with draft.js — dispositions below this never reach drafting
const DISPOSITIONS = ['add_rule', 'clarify_existing', 'move_to_skill', 'fix_tool', 'none']
////////////////////////////////////////////////////////////////////////////////

if (require.main === module) try { main () }
catch (err) {
    console.error (`error: ${err.message}`)
    process.exit (1)
}

function main () {

    // env read here, not at module scope — the module stays require-safe for tests
    const OUT_DIR     = process.env.OUT_DIR || 'out'
    const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd ()

    // Task 18: refuse a wrong-project OUT_DIR outright; a warn lands in the header
    const manifestStatus = guardManifest (OUT_DIR, PROJECT_DIR)

    const decidedPath = join (OUT_DIR, 'decided.jsonl')
    if (!existsSync (decidedPath)) throw new Error (`${decidedPath} missing — run decide.js first`)
    const decided = loadJsonl (decidedPath) // empty file = zero situations, render an empty report
    const drafted   = loadJsonl (join (OUT_DIR, 'drafted.jsonl'))
    const validated = loadJsonl (join (OUT_DIR, 'validated.jsonl'))
    const bySitId   = new Map (decided.map (d => [d.id, d]))
    const verdictByGroupId = new Map (validated.map (v => [v.id, v]))

    const sessions = new Set (decided.map (d => d.session))
    const byKind = {}, byDisp = {}
    let belowThr = 0
    for (const d of decided) {
        byKind [d.kind] = (byKind [d.kind] || 0) + 1
        byDisp [d.disposition || 'none'] = (byDisp [d.disposition || 'none'] || 0) + 1
        if (d.disposition && d.disposition !== 'none' && (Number (d.confidence) || 0) < MIN_CONFIDENCE) belowThr++
    }
    const cost = sum (decided.map (d => d.cost)) + sum (drafted.map (d => d.cost)) + sum (validated.map (v => v.cost))

    const kept = [], rejected = []
    for (const g of drafted) {
        const v = verdictByGroupId.get (g.id)
        if (v?.verdict === 'reject') { rejected.push ({g, v, sits: g.situation_ids.map (id => bySitId.get (id)).filter (Boolean)}); continue }
        if (v?.verdict !== 'keep')   { rejected.push ({g, v: {verdict: 'unvalidated', reason: 'no validator verdict — run validate.js'}}); continue }
        const sits = g.situation_ids.map (id => bySitId.get (id)).filter (Boolean)
        kept.push ({
            rule_line:  g.rule_line,
            category:   mode (sits.map (s => s.category)) ?? null,
            trigger:    g.trigger,
            mistake:    g.mistake,
            preferred:  g.preferred_behavior,
            scope:      g.scope,
            situation_ids: g.situation_ids,
            target_file: mode (sits.map (s => s.target_file)),
            confidence: Number (v.confidence) || 0, // jev confidence of the validation call
            count:      sum (sits.map (s => s.count || 1)),
            sessions:   [...new Set (sits.map (s => s.session))],
            quotes:     [...new Set (sits.flatMap (s => s.quotes))].slice (0, 6),
        })
    }
    kept.sort ((a, b) => (b.confidence * b.count) - (a.confidence * a.count))

    // skill / tool dispositions carry no drafted rule — evidence quotes ARE the payload
    const skills  = decided.filter (d => d.disposition === 'move_to_skill' && (Number (d.confidence) || 0) >= MIN_CONFIDENCE)
    const toolfix = decided.filter (d => d.disposition === 'fix_tool'      && (Number (d.confidence) || 0) >= MIN_CONFIDENCE)

    const lines = []
    lines.push (`# CLAUDE.md rule candidates — ${today ()}`)
    lines.push ('')
    lines.push (`Sessions scanned: ${sessions.size} | situations: ${decided.length} (${Object.entries (byKind).map (([k, n]) => `${k} ${n}`).join (', ')}) | dispositions: ${DISPOSITIONS.map (k => `${k} ${byDisp [k] || 0}`).join (', ')} (below conf ${MIN_CONFIDENCE}: ${belowThr}) | total cost: $${cost.toFixed (6)}`)
    if (manifestStatus === 'warn') lines.push ('_warning: mixed configuration — run outputs were produced under different prompts/digest/models than now; treat findings with suspicion_')
    lines.push ('')
    lines.push (`## Rule candidates (${kept.length})`)
    lines.push ('')
    if (!kept.length) lines.push ('_None — jev found nothing worth a rule, or the validator rejected everything._')
    for (const k of kept) {
        lines.push (`- **${k.rule_line}**`)
        lines.push (`  - ${k.category} -> ${k.target_file} | confidence ${k.confidence} | seen ${k.count}x`)
        lines.push (`  - situations: ${k.situation_ids.join (', ')} | sessions: ${k.sessions.join (', ')}`)
        lines.push (`  - trigger: ${k.trigger} | mistake: ${k.mistake} | preferred: ${k.preferred} | scope: ${k.scope}`)
        for (const q of k.quotes) lines.push (`  - evidence: ${q.replace (/\n/g, ' ')}`)
    }
    lines.push ('')
    renderList (lines, 'Skill candidates', skills)
    renderList (lines, 'Tool-fix candidates', toolfix)
    lines.push (`## Rejected by validator (${rejected.length})`)
    lines.push ('')
    if (!rejected.length) lines.push ('_None._')
    for (const {g, v, sits} of rejected) {
        lines.push (`- ~~${g.rule_line}~~`)
        lines.push (`  - ${v.reason} (${v.category ?? g.scope ?? 'uncategorized'})`)
        lines.push (`  - situations: ${g.situation_ids.join (', ')} | sessions: ${[...new Set (sits.map (s => s.session))].join (', ') || '?'}`)
    }
    lines.push ('')

    const out = join (OUT_DIR, `report-${today ()}.md`)
    writeFileSync (out, lines.join ('\n'))
    console.log (`report: ${kept.length} kept, ${rejected.length} rejected -> ${out}`)
}

function renderList (lines, title, items) {
    lines.push (`## ${title} (${items.length})`)
    lines.push ('')
    if (!items.length) lines.push ('_None._')
    for (const d of items) {
        lines.push (`- (${d.kind} x${d.count || 1}) ${(d.quotes [0] || '').replace (/\n/g, ' ').slice (0, 120)}`)
        lines.push (`  - ${d.category} -> ${d.target_file} | confidence ${Number (d.confidence) || 0} | sessions: ${d.session}`)
        for (const q of d.quotes.slice (1, 4)) lines.push (`  - evidence: ${q.replace (/\n/g, ' ')}`)
    }
    lines.push ('')
}

function loadJsonl (path) {
    if (!existsSync (path)) return []
    return readFileSync (path, 'utf8').split ('\n').filter (l => l.trim ()).map (l => {
        try { return JSON.parse (l) } catch { return null }
    }).filter (Boolean)
}

function sum (a) {
    return a.reduce ((x, y) => x + (Number (y) || 0), 0)
}

function mode (a) {
    return a.sort ((x, y) => a.filter (v => v === y).length - a.filter (v => v === x).length) [0]
}

function today () {
    return new Date ().toISOString ().slice (0, 10)
}

module.exports = {main}

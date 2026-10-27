#!/usr/bin/env node
// eval.js — fixtures/labeled.jsonl -> decide quality report (Task 19).
// Runs decide.js on the labeled set in a FRESH scratch dir — stale verdicts from
// older prompts would lie about the current ones — then scores: binary actionable
// (label yes/no vs disposition != none) as TP/FP/FN/TN with precision/recall per
// partition, disposition exact agreement + confusion matrix, per-item mismatches.
// The 0.5 draft threshold is printed as a hypothesis to test, not truth; the
// pass/fail precision floor stays unset until the first baseline is measured.
const {existsSync, readFileSync, writeFileSync, rmSync, mkdirSync} = require ('node:fs')
const {join} = require ('node:path')
const {spawnSync} = require ('node:child_process')

////////////////////////////////////////////////////////////////////////////////
const DISPOSITIONS = ['add_rule', 'clarify_existing', 'move_to_skill', 'fix_tool', 'none']
const MIN_CONFIDENCE = 0.5 // keep in sync with draft.js — printed as hypothesis here
////////////////////////////////////////////////////////////////////////////////

if (require.main === module) try { main () }
catch (err) {
    console.error (`error: ${err.message}`)
    process.exit (1)
}

function main () {

    // env read here, not at module scope — the module stays require-safe for tests
    const API_KEY     = process.env.OPENROUTER_API_KEY
    const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd ()
    const OUT_DIR     = process.env.OUT_DIR || 'out/eval'
    const LABELED     = process.env.EVAL_LABELED || join ('fixtures', 'labeled.jsonl')
    const FLOOR       = process.env.EVAL_PRECISION_FLOOR // unset = measure-only baseline

    if (!API_KEY) throw new Error ('OPENROUTER_API_KEY not set')
    if (!existsSync (LABELED)) throw new Error (`${LABELED} missing — the labeled set is the eval contract`)
    const labeled = readFileSync (LABELED, 'utf8').split ('\n').filter (l => l.trim ()).map (l => JSON.parse (l))

    // fresh scratch every run: decide skips known ids, and a kept verdict from an
    // older prompt version would silently pollute the measurement
    rmSync (OUT_DIR, {recursive: true, force: true})
    mkdirSync (OUT_DIR, {recursive: true})
    // situation fields only — label metadata must never reach the model
    writeFileSync (join (OUT_DIR, 'situations.jsonl'), labeled.map (r => JSON.stringify (situationOf (r))).join ('\n') + '\n')

    const r = spawnSync ('node', [join (__dirname, 'decide.js')], {
        env: {...process.env, OUT_DIR, PROJECT_DIR, NODE_USE_ENV_PROXY: '1'}, stdio: 'inherit',
    })
    if (r.status !== 0) throw new Error (`decide.js exited ${r.status} — eval aborted`)

    const decided = new Map (readFileSync (join (OUT_DIR, 'decided.jsonl'), 'utf8').split ('\n')
        .filter (l => l.trim ()).map (l => JSON.parse (l)).map (d => [d.id, d]))
    const scored = score (labeled, decided)
    printReport (scored, {PROJECT_DIR, FLOOR})
    if (scored.missing.length) console.error (`warning: ${scored.missing.length} labeled case(s) got no verdict: ${scored.missing.join (', ')}`)

    if (FLOOR !== undefined) {
        const floor = Number (FLOOR)
        const p = scored.parts.__all__.precision
        if (Number.isFinite (floor) && p < floor) {
            console.error (`precision ${p.toFixed (3)} below floor ${floor}`)
            process.exit (1)
        }
    }
}

// strip eval metadata — what scan.js would have written for this situation
function situationOf (row) {
    const {label, borderline, expected, partition, note, ...situation} = row
    return situation
}

// pure scoring: rows joined against verdicts by id. Binary ground truth is the
// label (yes = worth acting on via any output channel — rule, skill, or tool fix);
// move_to_skill / fix_tool predictions therefore count as actionable, and the
// channel choice is judged separately by exact disposition agreement.
function score (labeled, decidedById) {
    const parts = {__all__: blank ()}
    const confusion = {} // expected -> predicted -> n
    const mismatches = []
    const missing = []
    let exact = 0, exactAll = 0, belowThr = 0, actionable = 0
    for (const row of labeled) {
        const d = decidedById.get (row.id)
        if (!d?.disposition) { missing.push (row.id); continue }
        const pred = d.disposition
        const predActionable = pred !== 'none'
        if (predActionable) actionable++
        if (predActionable && (Number (d.confidence) || 0) < MIN_CONFIDENCE) belowThr++
        const key = row.partition || 'dev'
        parts [key] = parts [key] || blank ()
        for (const p of [parts [key], parts.__all__]) tally (p, row.label === 'yes', predActionable)
        if (row.expected) {
            exactAll++
            confusion [row.expected] = confusion [row.expected] || {}
            confusion [row.expected] [pred] = (confusion [row.expected] [pred] || 0) + 1
            if (row.expected === pred) exact++
            else mismatches.push ({id: row.id, partition: key, label: row.label, expected: row.expected, predicted: pred, confidence: d.confidence})
        }
        else if (row.label === 'yes' ? !predActionable : predActionable)
            mismatches.push ({id: row.id, partition: key, label: row.label, expected: null, predicted: pred, confidence: d.confidence})
    }
    for (const p of Object.values (parts)) finalize (p)
    return {parts, confusion, mismatches, missing, exact, exactAll, belowThr, actionable, total: labeled.length}
}

function blank () { return {tp: 0, fp: 0, fn: 0, tn: 0, precision: 0, recall: 0} }

function tally (p, labelYes, predYes) {
    if (labelYes && predYes) p.tp++
    else if (!labelYes && predYes) p.fp++
    else if (labelYes && !predYes) p.fn++
    else p.tn++
}

function finalize (p) {
    p.precision = p.tp + p.fp ? p.tp / (p.tp + p.fp) : 0
    p.recall = p.tp + p.fn ? p.tp / (p.tp + p.fn) : 0
}

function printReport ({parts, confusion, mismatches, missing, exact, exactAll, belowThr, actionable, total}, {PROJECT_DIR, FLOOR}) {
    const names = Object.keys (parts).filter (k => k !== '__all__').sort ()
    console.log (`eval: ${total} case(s) (${names.map (n => `${n} ${countOf (parts, n)}`).join (', ')}), digest from ${PROJECT_DIR}`)
    for (const n of [...names, '__all__'])
        console.log (`${n === '__all__' ? 'overall' : n.padEnd (8)} TP ${parts [n].tp} FP ${parts [n].fp} FN ${parts [n].fn} TN ${parts [n].tn} | precision ${parts [n].precision.toFixed (3)} recall ${parts [n].recall.toFixed (3)}`)
    console.log (`disposition agreement: ${exact}/${exactAll} exact`)
    console.log (`confusion expected\\predicted  ${DISPOSITIONS.map (d => d.padEnd (16)).join ('')}`)
    for (const e of DISPOSITIONS)
        console.log (`  ${e.padEnd (26)} ${DISPOSITIONS.map (p => String (confusion [e]?.[p] || 0).padEnd (16)).join ('')}`)
    if (mismatches.length) {
        console.log ('mismatches:')
        for (const m of mismatches)
            console.log (`  - ${m.id} [${m.partition}] label ${m.label}${m.expected ? ` (expected ${m.expected})` : ''} -> predicted ${m.predicted} conf ${m.confidence ?? '?'}`)
    }
    console.log (`draft threshold: MIN_CONFIDENCE ${MIN_CONFIDENCE} is a hypothesis to test (Task 21) — ${belowThr} of ${actionable} actionable prediction(s) sit below it and would not reach drafting`)
    console.log (FLOOR === undefined
        ? 'precision floor: not set (set EVAL_PRECISION_FLOOR after the first measured baseline)'
        : `precision floor: ${FLOOR}`)
}

// per-partition case count for the header line
function countOf (parts, name) {
    const p = parts [name]
    return p.tp + p.fp + p.fn + p.tn
}

module.exports = {main, score, situationOf}

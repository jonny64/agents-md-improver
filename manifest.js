// manifest.js — run manifest per OUT_DIR (Task 18). scan.js records the run's
// configuration; consuming stages compare it against their own view before
// appending. Prompt tuning lands as uncommitted edits to prompts/, so the
// prompt-content hash — not the git rev — is what makes drift visible; the rev
// rides along for the record. No env reads at module scope: require-safe.
const {createHash} = require ('node:crypto')
const {existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync} = require ('node:fs')
const {join, resolve} = require ('node:path')
const {buildRulesDigest} = require ('./prompts.js')

const sha256 = s => createHash ('sha256').update (s).digest ('hex')

// hash over the whole judgement surface: prompts/*.txt texts + prompts.js
// question structure — any wording edit, committed or not, moves this
function promptHash () {
    const dir  = join (__dirname, 'prompts')
    const parts = []
    for (const n of readdirSync (dir).filter (n => n.endsWith ('.txt')).sort ())
        parts.push (n + '\n' + readFileSync (join (dir, n), 'utf8'))
    parts.push ('prompts.js\n' + readFileSync (join (__dirname, 'prompts.js'), 'utf8'))
    return sha256 (parts.join ('\n---\n'))
}

function gitRev () {
    try {
        return require ('node:child_process').execSync ('git rev-parse HEAD', {cwd: __dirname, encoding: 'utf8'}).trim ()
    }
    catch { return null } // not a repo — the prompt hash still covers the tuning surface
}

function digestHash (projectDir) {
    return sha256 (buildRulesDigest (projectDir))
}

// defaults duplicated from draft.js / validate.js — keep in sync
function currentModels () {
    return {
        draft:    process.env.DRAFT_MODEL    || 'z-ai/glm-5.3-flash',
        validate: process.env.VALIDATE_MODEL || 'moonshotai/kimi-k3',
    }
}

// window bounds shared by scan.js (mtime file filter) and the manifest record.
// SINCE/UNTIL ('YYYY-MM-DD', mtime-based, inclusive) pin an explicit window —
// SINCE overrides DAYS; UNTIL alone caps the DAYS window
function windowBounds () {
    const since = process.env.SINCE || null
    const until = process.env.UNTIL || null
    const days  = Number (process.env.DAYS || 30)
    const sinceMs = since ? dayBound (since, false) : Date.now () - days * 86_400_000
    const untilMs = until ? dayBound (until, true) : Infinity
    return {since, until, days: since ? null : days, cutoff: new Date (sinceMs).toISOString (), sinceMs, untilMs}
}

function dayBound (s, endOfDay) {
    const t = Date.parse (`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
    if (!Number.isFinite (t)) throw new Error (`bad ${endOfDay ? 'UNTIL' : 'SINCE'} date "${s}" — expected YYYY-MM-DD`)
    return t
}

// scan.js calls this once per run (both the scanned and the no-logs paths —
// downstream stages see zero situations either way, but the config record stands)
function writeManifest (outDir, projectDir) {
    const {since, until, days, cutoff} = windowBounds ()
    const manifest = {
        created:      new Date ().toISOString (),
        project_dir:  resolve (projectDir),
        prompt_hash:  promptHash (),
        git_rev:      gitRev (),
        digest_hash:  digestHash (projectDir),
        models:       currentModels (),
        since,
        until,
        days,
        cutoff,
    }
    mkdirSync (outDir, {recursive: true}) // scan calls this before anything else creates OUT_DIR
    writeFileSync (join (outDir, 'manifest.json'), JSON.stringify (manifest, null, 2) + '\n')
    return manifest
}

// consuming stages call this before touching outputs.
// 'none'   — no manifest (fresh or hand-crafted OUT_DIR): proceed silently
// 'ok'     — configuration matches the scan
// 'warn'   — drift that mixes configurations if the run continues (stderr note)
// 'refuse' — OUT_DIR belongs to a different project: refuse to reuse it
function checkManifest (outDir, projectDir) {
    const f = join (outDir, 'manifest.json')
    if (!existsSync (f)) return {status: 'none', reasons: []}
    let m
    try { m = JSON.parse (readFileSync (f, 'utf8')) }
    catch { return {status: 'warn', reasons: ['manifest.json unreadable — configuration unknown']} }
    const here = resolve (projectDir)
    if (m.project_dir && m.project_dir !== here)
        return {status: 'refuse', reasons: [`OUT_DIR was scanned for ${m.project_dir} but PROJECT_DIR is now ${here} — use a fresh OUT_DIR`]}
    const reasons = []
    if (m.prompt_hash && m.prompt_hash !== promptHash ()) reasons.push ('prompts changed since scan')
    if (m.digest_hash && m.digest_hash !== digestHash (here)) reasons.push ('existing-rules digest changed since scan')
    const models = currentModels ()
    for (const k of ['draft', 'validate'])
        if (m.models?.[k] && m.models [k] !== models [k]) reasons.push (`${k} model changed since scan (${m.models [k]} -> ${models [k]})`)
    return {status: reasons.length ? 'warn' : 'ok', reasons, manifest: m}
}

// stage glue: refuse throws (the stage exits non-zero before any append or API
// call), warn prints to stderr and lets the stage continue — resumability wins
function guardManifest (outDir, projectDir) {
    const {status, reasons} = checkManifest (outDir, projectDir)
    if (status === 'refuse') throw new Error (reasons.join ('; '))
    if (reasons.length) console.error (`warning: mixed configuration — ${reasons.join ('; ')}`)
    return status
}

module.exports = {writeManifest, checkManifest, guardManifest, promptHash, windowBounds}

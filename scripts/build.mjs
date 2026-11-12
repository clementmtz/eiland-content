#!/usr/bin/env node
// Valide les îlots, génère les audios manquants avec Azure Speech et écrit les manifests.
//
//   node scripts/build.mjs                 → valide + génère + manifest (toutes les langues)
//   node scripts/build.mjs --lang nl-BE    → une seule langue
//   node scripts/build.mjs --validate-only → valide seulement (aucun appel réseau, aucune écriture)
//   node scripts/build.mjs --dry-run       → valide et liste ce qui serait généré ou supprimé
//
// Variables d'environnement : AZURE_SPEECH_KEY, AZURE_SPEECH_REGION (jamais dans le dépôt).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const LANG_DIR = path.join(ROOT, "languages");
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const KBPS = 48;
const SSML_VERSION = 1; // incrémenter si le gabarit SSML change → tout est régénéré
const SCHEMA = 1;
const CONCURRENCY = 4;
// Palier gratuit Azure (F0) : 20 synthèses par minute. Monter AZURE_TTS_RPM en palier payant (S0).
const RPM = Math.max(1, Number(process.env.AZURE_TTS_RPM) || 18);
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 60000 / RPM;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const VALIDATE_ONLY = flag("--validate-only");
const DRY = flag("--dry-run");
const ONLY = opt("--lang");

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISLAND_KEYS = new Set(["id", "emoji", "title_fr", "order", "sentences"]);
const SENTENCE_KEYS = new Set(["id", "nl", "fr", "note"]);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeIfChanged = (p, s) => {
  if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === s) return false;
  fs.writeFileSync(p, s);
  return true;
};
const xmlEsc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

function validateLanguage(code, dir) {
  const errors = [];
  const err = (where, msg) => errors.push(`${code}/${where} : ${msg}`);
  let lang;
  try { lang = readJSON(path.join(dir, "language.json")); } catch (e) { err("language.json", `illisible (${e.message})`); return { errors }; }
  for (const k of ["code", "name", "voice"]) if (typeof lang[k] !== "string" || !lang[k].trim()) err("language.json", `champ « ${k} » manquant`);
  if (lang.code && lang.code !== code) err("language.json", `code « ${lang.code} » différent du dossier « ${code} »`);
  lang.rate = lang.rate || "0%";

  const islDir = path.join(dir, "islands");
  const files = fs.existsSync(islDir) ? fs.readdirSync(islDir).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) err("islands/", "aucun îlot");
  const islands = [];
  const islandIds = new Set();
  const sentenceIds = new Map();
  for (const f of files) {
    const where = `islands/${f}`;
    let isl;
    try { isl = readJSON(path.join(islDir, f)); } catch (e) { err(where, `JSON invalide (${e.message})`); continue; }
    if (typeof isl !== "object" || Array.isArray(isl) || !isl) { err(where, "doit être un objet"); continue; }
    for (const k of Object.keys(isl)) if (!ISLAND_KEYS.has(k)) err(where, `champ inconnu « ${k} »`);
    if (typeof isl.id !== "string" || !ID_RE.test(isl.id)) err(where, `id invalide « ${isl.id} » (minuscules, chiffres, tirets)`);
    else if (isl.id !== f.slice(0, -5)) err(where, `id « ${isl.id} » différent du nom de fichier`);
    if (islandIds.has(isl.id)) err(where, `id d'îlot en double « ${isl.id} »`);
    islandIds.add(isl.id);
    if (typeof isl.emoji !== "string" || !isl.emoji.trim()) err(where, "champ « emoji » manquant");
    if (typeof isl.title_fr !== "string" || !isl.title_fr.trim()) err(where, "champ « title_fr » manquant");
    if (typeof isl.order !== "number" || !Number.isFinite(isl.order)) err(where, "champ « order » doit être un nombre");
    if (!Array.isArray(isl.sentences) || isl.sentences.length < 2) { err(where, "il faut au moins 2 phrases"); continue; }
    isl.sentences.forEach((s, i) => {
      const w = `${where} phrase ${i + 1}`;
      if (typeof s !== "object" || !s) { err(w, "doit être un objet"); return; }
      for (const k of Object.keys(s)) if (!SENTENCE_KEYS.has(k)) err(w, `champ inconnu « ${k} »`);
      if (typeof s.id !== "string" || !ID_RE.test(s.id)) err(w, `id invalide « ${s.id} »`);
      else if (sentenceIds.has(s.id)) err(w, `id de phrase en double « ${s.id} » (déjà dans ${sentenceIds.get(s.id)})`);
      else sentenceIds.set(s.id, f);
      for (const k of ["nl", "fr"]) if (typeof s[k] !== "string" || !s[k].trim()) err(w, `champ « ${k} » manquant`);
      if (s.note != null && (typeof s.note !== "string" || !s.note.trim())) err(w, "« note » doit être un texte non vide");
    });
    islands.push(isl);
  }
  return { errors, lang, islands };
}

/// Les pistes audio d'une langue : la phrase apprise, et sa traduction si `voice_fr` est défini.
function tracks(lang) {
  const t = [{ key: "nl", text: (s) => s.nl, voice: lang.voice, xmlLang: lang.code, suffix: "" }];
  if (lang.voice_fr) t.push({ key: "fr", text: (s) => s.fr, voice: lang.voice_fr, xmlLang: lang.voice_fr.slice(0, 5), suffix: "-fr" });
  return t;
}

function audioName(lang, tr, s) {
  const hash = sha(JSON.stringify([tr.text(s).trim(), tr.voice, lang.rate, OUTPUT_FORMAT, SSML_VERSION])).slice(0, 12);
  return { hash, file: `${s.id}${tr.suffix}-${hash}.mp3` };
}

function ssml(lang, tr, text) {
  return `<speak version="1.0" xml:lang="${tr.xmlLang}" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${tr.voice}"><prosody rate="${lang.rate}">${xmlEsc(text.trim())}</prosody></voice></speak>`;
}

async function synth(lang, tr, text, key, region) {
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  for (let attempt = 1; ; attempt++) {
    await throttle();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
        "User-Agent": "eiland-content-build",
      },
      body: ssml(lang, tr, text),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) throw new Error(`audio trop court (${buf.length} octets)`);
      return buf;
    }
    const retry = res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 8) throw new Error(`Azure HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const wait = Math.min(60000, Number(res.headers.get("retry-after")) * 1000 || 3000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function buildLanguage(code) {
  const dir = path.join(LANG_DIR, code);
  const { errors, lang, islands } = validateLanguage(code, dir);
  if (errors.length) return { code, errors };
  const n = islands.reduce((a, x) => a + x.sentences.length, 0);
  console.log(`${code} : ${islands.length} îlots, ${n} phrases valides`);
  if (VALIDATE_ONLY) return { code, errors: [] };

  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  const wanted = new Map();
  const trs = tracks(lang);
  for (const isl of islands) for (const s of isl.sentences) for (const tr of trs) wanted.set(`${s.id}|${tr.key}`, { s, tr, ...audioName(lang, tr, s) });
  const present = new Set(fs.readdirSync(audioDir).filter((f) => f.endsWith(".mp3")));
  const missing = [...wanted.values()].filter((w) => !present.has(w.file));
  const keep = new Set([...wanted.values()].map((w) => w.file));
  const orphans = [...present].filter((f) => !keep.has(f));

  console.log(`${code} : ${missing.length} audio(s) à générer, ${orphans.length} orphelin(s) à supprimer`);
  if (missing.length && !DRY) console.log(`  débit : ${RPM} par minute, environ ${Math.ceil(missing.length / RPM)} min`);
  if (DRY) {
    missing.forEach((w) => console.log(`  + ${w.file}  « ${w.tr.text(w.s)} »`));
    orphans.forEach((f) => console.log(`  - ${f}`));
    return { code, errors: [] };
  }

  if (missing.length) {
    const key = process.env.AZURE_SPEECH_KEY, region = process.env.AZURE_SPEECH_REGION;
    if (!key || !region) return { code, errors: [`${code} : AZURE_SPEECH_KEY et AZURE_SPEECH_REGION sont requis pour générer ${missing.length} audio(s)`] };
    const failed = [];
    let done = 0;
    await pool(missing, CONCURRENCY, async (w) => {
      try {
        const buf = await synth(lang, w.tr, w.tr.text(w.s), key, region);
        fs.writeFileSync(path.join(audioDir, w.file), buf);
        done++;
        if (done % 20 === 0 || done === missing.length) console.log(`  ${done}/${missing.length}`);
      } catch (e) { failed.push(`${code}/${w.s.id} (${w.tr.key}) : ${e.message}`); }
    });
    if (failed.length) return { code, errors: failed };
  }
  for (const f of orphans) fs.unlinkSync(path.join(audioDir, f));

  const manifestIslands = islands
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((isl) => ({
      id: isl.id, emoji: isl.emoji, title_fr: isl.title_fr, order: isl.order,
      sentences: isl.sentences.map((s) => {
        const o = { id: s.id, nl: s.nl.trim(), fr: s.fr.trim() };
        if (s.note) o.note = s.note.trim();
        for (const tr of trs) {
          const w = wanted.get(`${s.id}|${tr.key}`);
          const size = fs.statSync(path.join(audioDir, w.file)).size;
          const k = tr.key === "nl" ? "" : `_${tr.key}`;
          o[`audio${k}`] = `audio/${w.file}`;
          o[`hash${k}`] = w.hash;
          o[`bytes${k}`] = size;
          o[`durationMs${k}`] = Math.round((size * 8) / KBPS); // MP3 à débit constant
        }
        return o;
      }),
    }));
  const body = { schema: SCHEMA, language: { code: lang.code, name: lang.name, name_fr: lang.name_fr || lang.name, voice: lang.voice, ...(lang.voice_fr ? { voice_fr: lang.voice_fr } : {}) }, islands: manifestIslands };
  const version = sha(JSON.stringify(body)).slice(0, 16);
  const out = JSON.stringify({ schema: SCHEMA, version, language: body.language, islands: manifestIslands }, null, 2) + "\n";
  const changed = writeIfChanged(path.join(dir, "manifest.json"), out);
  console.log(`${code} : manifest ${changed ? "mis à jour" : "inchangé"} (version ${version})`);
  return { code, errors: [], entry: { code: lang.code, name: lang.name, name_fr: lang.name_fr || lang.name, version, islands: manifestIslands.length, sentences: n } };
}

const codes = fs.readdirSync(LANG_DIR).filter((d) => fs.statSync(path.join(LANG_DIR, d)).isDirectory() && (!ONLY || d === ONLY)).sort();
if (!codes.length) { console.error(`Aucune langue trouvée${ONLY ? ` pour « ${ONLY} »` : ""}.`); process.exit(1); }

const results = [];
for (const c of codes) results.push(await buildLanguage(c));
const errors = results.flatMap((r) => r.errors);
if (errors.length) {
  console.error(`\n${errors.length} erreur(s) :`);
  errors.forEach((e) => console.error(`  ✗ ${e}`));
  process.exit(1);
}
if (!VALIDATE_ONLY && !DRY && !ONLY) {
  const index = JSON.stringify({ schema: SCHEMA, languages: results.map((r) => r.entry) }, null, 2) + "\n";
  writeIfChanged(path.join(LANG_DIR, "index.json"), index);
}
console.log("OK");

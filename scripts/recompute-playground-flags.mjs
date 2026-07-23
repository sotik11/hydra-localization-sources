/**
 * One-off: recompute PlayGround voice flags after the typeFlags fix
 * (звук/голос were not recognised, so entries fell back to hasText).
 *
 * Surgical on purpose. Recomputing every flag from the stored JSON is NOT
 * equivalent to a real run: at generation time typeFlags() sees the RAW h1 and
 * the page's variant labels, while the JSON only keeps the CLEANED title — a
 * blind recompute drops flags on 77 entries. So we only ever ADD voice flags,
 * and we clear hasText solely where it was the "no modality found" fallback
 * (stored flags are exactly { hasText: true } and the old regex matched
 * nothing). Everything page-derived is left untouched.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data", "playground.json");
const KEYS = [
  "hasText",
  "hasVoice",
  "hasTextures",
  "hasNeuralText",
  "hasNeuralVoice",
  "hasNeuralDub",
];

const OLD_VOICE = /ozvuch|озвуч|закадр/;
const NEW_VOICE = /ozvuch|озвуч|закадр|zvuk|звук|golos|голос/;

/** typeFlags without the final fallback, so we can tell a real hit from it. */
function flagsNoFallback(slug, title, voiceRe) {
  const s = `${slug} ${title || ""}`.toLowerCase();
  const aiModel =
    /deepseek|chatgpt|gpt[\s_-]?[0-9o]|\bclaude\b|gemini|gigachat|yandexgpt|\bdeepl\b|\bllama\b|mistral|\bqwen\b|copilot|revoiceai|elevenlabs|silero|\bxtts\b|tortoise|\brvc\b/i;
  const neuro =
    /nejro|neuro|нейро|машинн|mashinn|ии[\s_-]?(?:озвуч|дубляж|перевод|текст)|ii[_-](?:ozvuch|dub|perevod|tekst)|от[\s_-]?ии(?:[\s_).\]]|$)|ot[\s_-]ii(?:[\s_]|$)/.test(
      s
    ) || aiModel.test(s);
  const isText = (/tekst/.test(s) && !/tekstur/.test(s)) || /текст/.test(s);
  const isTextures = /tekstur|текстур/.test(s);
  const isVoice = voiceRe.test(s);
  const isDub = /dublyazh|dubljazh|dubl|дубляж/.test(s);
  return {
    hasText: isText && !neuro,
    hasVoice: (isVoice || isDub) && !neuro,
    hasTextures: isTextures,
    hasNeuralText: neuro && isText,
    hasNeuralVoice: neuro && isVoice,
    hasNeuralDub: neuro && isDub,
  };
}

const slugOf = (entry) =>
  (entry.studioUrl || entry.pageUrl || "").split("/").pop().replace(/-\d+$/, "");

const doc = JSON.parse(readFileSync(DATA, "utf8"));
const list = doc.localizations;

let addedVoice = 0;
let addedNeuralVoice = 0;
let clearedText = 0;
const changed = [];

for (const entry of list) {
  const slug = slugOf(entry);
  const before = KEYS.filter((k) => entry[k]);

  const oldFlags = flagsNoFallback(slug, entry.title, OLD_VOICE);
  const newFlags = flagsNoFallback(slug, entry.title, NEW_VOICE);

  const gainedVoice =
    (newFlags.hasVoice && !entry.hasVoice) ||
    (newFlags.hasNeuralVoice && !entry.hasNeuralVoice);
  if (!gainedVoice) continue;

  // hasText was the fallback only if nothing matched before AND that fallback
  // is the single flag on the entry (otherwise it came from the page).
  const oldMatchedNothing = !Object.values(oldFlags).some(Boolean);
  const textIsFallbackOnly =
    oldMatchedNothing &&
    entry.hasText === true &&
    before.length === 1 &&
    before[0] === "hasText";

  if (newFlags.hasVoice && !entry.hasVoice) {
    entry.hasVoice = true;
    addedVoice++;
  }
  if (newFlags.hasNeuralVoice && !entry.hasNeuralVoice) {
    entry.hasNeuralVoice = true;
    addedNeuralVoice++;
  }
  if (textIsFallbackOnly && !newFlags.hasText && !newFlags.hasNeuralText) {
    entry.hasText = false;
    clearedText++;
  }

  changed.push({ title: entry.title, before, after: KEYS.filter((k) => entry[k]) });
}

copyFileSync(DATA, `${DATA}.pre-voicefix.backup`);
writeFileSync(DATA, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

console.log(`entries            : ${list.length}`);
console.log(`changed            : ${changed.length}`);
console.log(`  + hasVoice       : ${addedVoice}`);
console.log(`  + hasNeuralVoice : ${addedNeuralVoice}`);
console.log(`  - bogus hasText  : ${clearedText}`);
console.log(`backup             : playground.json.pre-voicefix.backup\n`);
console.log("sample:");
for (const c of changed.slice(0, 10)) {
  console.log(
    `  • ${(c.title || "").slice(0, 34).padEnd(36)} ${c.before.join(",") || "-"}  ->  ${c.after.join(",")}`
  );
}

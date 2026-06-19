// One-off: extract intern Connor Broschard's stadium-quiz HTML into static
// image files + a metadata module. Re-run if Connor sends an updated HTML.
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] || "/Users/naterasmussen/Downloads/nw_baseball_quiz_9.html";
const html = fs.readFileSync(SRC, "utf8");
const m = html.match(/const ALL_TEAMS = (\[.*?\]);\s*\n\n\/\/ ── STATE/s);
if (!m) { console.error("Could not find ALL_TEAMS array"); process.exit(1); }
const teams = JSON.parse(m[1]);

const outDir = path.join(__dirname, "..", "public", "stadium-quiz");
fs.mkdirSync(outDir, { recursive: true });

function slug(name) {
  return name.toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s-]/g, "")
    .trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

const seen = new Set();
const meta = teams.map((t) => {
  let s = slug(t.name);
  while (seen.has(s)) s += "-x";
  seen.add(s);
  const easyFile = `${s}-easy.jpg`;
  const hardFile = `${s}-hard.jpg`;
  fs.writeFileSync(path.join(outDir, easyFile), Buffer.from(t.easy, "base64"));
  fs.writeFileSync(path.join(outDir, hardFile), Buffer.from(t.hard, "base64"));
  return { name: t.name, field: t.field, conference: t.conference, easy: easyFile, hard: hardFile };
});

fs.writeFileSync(
  path.join(__dirname, "..", "src", "data", "stadiumQuiz.js"),
  "// Auto-generated from intern Connor Broschard's stadium quiz HTML.\n" +
  "// Images live in /public/stadium-quiz/. Regenerate via\n" +
  "// `node scripts/extract_stadium_quiz.cjs <path-to-html>` if Connor sends an update.\n" +
  "export const STADIUM_TEAMS = " + JSON.stringify(meta, null, 2) + "\n"
);

const sizes = fs.readdirSync(outDir).reduce((a, f) => a + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`Wrote ${meta.length} teams, ${meta.length * 2} images`);
console.log(`Total image bytes on disk: ${(sizes / 1024 / 1024).toFixed(2)} MB`);
console.log("Sample:", JSON.stringify(meta[0]));

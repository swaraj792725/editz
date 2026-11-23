/**
 * ExtendScript is ES3. Parse the host lib with acorn at ecmaVersion 3 and reject
 * ES5+ library calls that old Premiere builds lack.
 */
import { readFileSync } from "node:fs";
import { parse } from "acorn";

const files = process.argv.slice(2);
if (files.length === 0) files.push("apps/premiere-cep/host/editz.jsx");
const banned = [/\.forEach\(/, /\.map\(/, /\.filter\(/, /\.indexOf\(/, /\.trim\(/, /Object\.keys\(/, /Array\.isArray\(/, /\bJSON\.stringify\(/];
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    parse(src, { ecmaVersion: 3, sourceType: "script" });
  } catch (e) {
    console.error(`${f}: ES3 parse error: ${(e as Error).message}`);
    bad++;
  }
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const re of banned) if (re.test(code)) {
      console.error(`${f}:${i + 1}: ES5+ API ${re.source} not in ExtendScript`);
      bad++;
    }
  });
}
if (bad) process.exit(1);
console.log(`ES3 OK: ${files.join(", ")}`);

/** Writes the M0 golden fixture: golden/golden-20.ir.json + .xml (bins) for manual import tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { assertProject } from "@editz/ir";
import { projectToFcp7Xml } from "@editz/compilers";
import { twentyClipProject } from "../packages/ir/test/fixtures.ts";

const root = process.argv[2] ?? "/Users/Shared/Editz Golden/media";
const p = assertProject(twentyClipProject(root));
mkdirSync("golden", { recursive: true });
writeFileSync("golden/golden-20.ir.json", JSON.stringify(p, null, 2) + "\n");
writeFileSync("golden/golden-20.xml", projectToFcp7Xml(p, { includeBins: true }));
console.log(`golden/golden-20.ir.json + golden-20.xml (media root: ${root})`);

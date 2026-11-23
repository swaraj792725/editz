/**
 * MCP smoke test: start the daemon over stdio like Claude does and call tools.
 * Usage: tsx apps/daemon/scripts/smoke.ts '<tool>' '<json args>' ['<tool>' '<json args>' ...]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", entry], env: process.env as Record<string, string>, stderr: "inherit" });
const client = new Client({ name: "editz-smoke", version: "0" });
await client.connect(transport);

const argv = process.argv.slice(2);
if (!argv.length) console.log((await client.listTools()).tools.map((t) => t.name).join("\n"));
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i]!;
  const r = await client.callTool({ name, arguments: JSON.parse(argv[i + 1] ?? "{}") });
  console.log(`\n=== ${name}${r.isError ? " (ERROR)" : ""}`);
  for (const c of r.content as any[]) console.log(c.type === "text" ? c.text : `[${c.type} ${c.mimeType} ${c.data.length} b64 chars]`);
}
await client.close();

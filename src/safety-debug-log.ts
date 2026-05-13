// ---------------------------------------------------------------------------
// Per-decision debug log for the safety hook.
//
// Off by default. Enabled by setting `safety.debug_log` to either a file path
// (lines appended directly) or a directory (one file per UTC date inside).
// One JSONL line per decision; nested `stages` array preserves the per-stage
// chain so a single grep on `decision_id` reconstructs the full evaluation.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import type { SafetyDecisionLog } from "./types.js";

function targetFile(configValue: string): string {
    // If the path exists, honor what's already there.
    try {
        const info = fs.statSync(configValue);
        if (info.isDirectory()) {
            const day = new Date().toISOString().slice(0, 10);
            return path.join(configValue, `safety-${day}.jsonl`);
        }
        return configValue;
    } catch {
        // Doesn't exist - infer intent from the last path component. A dot in
        // the basename (e.g. "safety.jsonl") means file; no dot means directory.
        const base = path.basename(configValue);
        if (base.includes(".")) return configValue;
        const day = new Date().toISOString().slice(0, 10);
        return path.join(configValue, `safety-${day}.jsonl`);
    }
}

export function writeDecisionLog(log: SafetyDecisionLog, configValue: string | undefined): void {
    if (!configValue) return;
    try {
        const file = targetFile(configValue);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(log) + "\n");
    } catch (e) {
        process.stderr.write(`Safety debug log write failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
}

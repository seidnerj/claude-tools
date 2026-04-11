// ---------------------------------------------------------------------------
// Session cost calculation from JSONL token usage data
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import type { SessionCost, ModelUsage } from "./types.js";
import { findSessionFile } from "./find-session.js";

// ---------------------------------------------------------------------------
// Pricing table (USD per million tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
}

/** Per-model pricing in USD per million tokens.
 *  Source: https://docs.anthropic.com/en/docs/about-claude/pricing
 *  Cache write = 1.25x base input (5-minute ephemeral cache).
 *  Cache read = 0.1x base input.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
    "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
    "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
    "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    "claude-sonnet-3-7": { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
    "claude-haiku-3-5": { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1.0 },
    "claude-opus-3": { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
    "claude-haiku-3": { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheReadPerMTok: 0.03, cacheWritePerMTok: 0.3 },
};

// ---------------------------------------------------------------------------
// Model ID normalization
// ---------------------------------------------------------------------------

/** Strip date suffixes and normalize model IDs to canonical pricing keys.
 *  e.g. "claude-haiku-4-5-20251001" -> "claude-haiku-4-5"
 */
function normalizeModelId(raw: string): string {
    const stripped = raw.replace(/-\d{8}$/, "");
    if (MODEL_PRICING[stripped]) return stripped;
    for (const key of Object.keys(MODEL_PRICING)) {
        if (stripped.startsWith(key)) return key;
    }
    return stripped;
}

// ---------------------------------------------------------------------------
// Cost calculation from parsed entries
// ---------------------------------------------------------------------------

interface UsageData {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface AssistantMessage {
    model?: string;
    usage?: UsageData;
}

/** Calculate cost from pre-parsed JSONL entries. */
export function calculateCost(entries: Array<Record<string, unknown>>, sessionId: string, projectPath: string): SessionCost {
    const usageByModel = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    let apiDurationMs = 0;
    let firstTimestamp = "";
    let lastTimestamp = "";

    for (const entry of entries) {
        const t = entry.type as string | undefined;
        const ts = entry.timestamp as string | undefined;

        if (ts) {
            if (!firstTimestamp) firstTimestamp = ts;
            lastTimestamp = ts;
        }

        if (t === "system" && entry.subtype === "turn_duration") {
            apiDurationMs += (entry.durationMs as number) || 0;
            continue;
        }

        if (t !== "assistant") continue;

        const msg = entry.message as AssistantMessage | undefined;
        if (!msg?.usage || !msg.model) continue;

        const modelKey = normalizeModelId(msg.model);
        const usage = msg.usage;

        const existing = usageByModel.get(modelKey) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        existing.input += usage.input_tokens || 0;
        existing.output += usage.output_tokens || 0;
        existing.cacheRead += usage.cache_read_input_tokens || 0;
        existing.cacheWrite += usage.cache_creation_input_tokens || 0;
        usageByModel.set(modelKey, existing);
    }

    const models: ModelUsage[] = [];
    let totalCost = 0;

    for (const [model, usage] of usageByModel) {
        const pricing = MODEL_PRICING[model];
        let cost = 0;
        if (pricing) {
            cost =
                (usage.input * pricing.inputPerMTok +
                    usage.output * pricing.outputPerMTok +
                    usage.cacheRead * pricing.cacheReadPerMTok +
                    usage.cacheWrite * pricing.cacheWritePerMTok) /
                1_000_000;
        }

        models.push({
            model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            cost,
        });

        totalCost += cost;
    }

    models.sort((a, b) => b.cost - a.cost);

    let wallDurationMs = 0;
    if (firstTimestamp && lastTimestamp) {
        wallDurationMs = new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
        if (wallDurationMs < 0) wallDurationMs = 0;
    }

    return {
        sessionId,
        projectPath,
        totalCost: Math.round(totalCost * 100) / 100,
        durations: { apiDurationMs, wallDurationMs },
        models,
    };
}

// ---------------------------------------------------------------------------
// Public API: calculate cost from session ID
// ---------------------------------------------------------------------------

/** Calculate the cost breakdown for a session by reading its JSONL file. */
export function getSessionCost(sessionId: string, projectPath?: string): SessionCost {
    const { filepath, projectPath: resolvedProject } = findSessionFile(sessionId, projectPath);

    const content = fs.readFileSync(filepath, "utf-8");
    const entries: Array<Record<string, unknown>> = [];

    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            entries.push(JSON.parse(trimmed));
        } catch {
            continue;
        }
    }

    return calculateCost(entries, sessionId, resolvedProject);
}

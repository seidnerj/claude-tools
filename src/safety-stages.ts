// ---------------------------------------------------------------------------
// Stage runners for the safety classifier.
//
// Two-stage flow: S1 (64 tok XML, no thinking, no ALLOW) -> S2 (4096 tok JSON
// with thinking) on escalation. Single-stage modes: single_fast (256 tok XML)
// or single_thinking (4096 tok JSON with thinking).
// ---------------------------------------------------------------------------

import { configGet, configGetObject } from "./utils.js";
import type { SafetyCheckResult, ClassifierStage, SafetyUserRules } from "./types.js";
import { buildSystemPrompt, parseXmlVerdict, buildStageDirective } from "./safety-prompts.js";

export const DEFAULT_SAFETY_MODEL = "claude-opus-4-6";
const SAFETY_TIMEOUT_MS = 30_000;

const BUDGETS: Record<ClassifierStage, number> = {
    s1: 64,
    s2: 4096,
    single_fast: 256,
    single_thinking: 4096,
};

const STOP_SEQUENCES: Record<ClassifierStage, string[] | undefined> = {
    s1: ["</block>"],
    s2: undefined,
    single_fast: ["</block>"],
    single_thinking: undefined,
};

const THINKING_STAGES: Set<ClassifierStage> = new Set(["s2", "single_thinking"]);

/** Sentinel reason returned by S1 to indicate the action escalates to S2. */
export const S1_ESCALATE_SENTINEL = "__S1_ESCALATE__";

function buildBillingHeaderBlock(): { type: string; text: string } | null {
    const cch = configGet("safety.billing_cch");
    const ccVersion = configGet("safety.billing_cc_version");
    if (!cch || !ccVersion) {
        process.stderr.write(
            "LLM safety check: billing_cch and billing_cc_version must be configured.\n" +
                "  claude config set safety.billing_cch <value>\n" +
                "  claude config set safety.billing_cc_version <value>\n" +
                "Capture these values from Claude Code traffic via Proxyman.\n"
        );
        return null;
    }
    return {
        type: "text",
        text: `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=hook; cch=${cch};`,
    };
}

/**
 * Make a single Anthropic API call for a given classifier stage.
 * Returns the raw text response or null on error.
 */
export async function callApi(apiKey: string, stage: ClassifierStage, userMessage: string, model?: string): Promise<string | null> {
    const billingBlock = buildBillingHeaderBlock();
    if (!billingBlock) return null;

    const safetyModel = model || configGet("safety.model", DEFAULT_SAFETY_MODEL) || DEFAULT_SAFETY_MODEL;
    const supportsThinking = /sonnet-4-[56]|opus-4-[56]/.test(safetyModel);

    const cacheControl = { type: "ephemeral" as const, ttl: "1h" as const };
    const userRules = configGetObject("safety.user_rules") as SafetyUserRules | undefined;
    const systemText = buildSystemPrompt(userRules);

    const requestBody: Record<string, unknown> = {
        model: safetyModel,
        max_tokens: BUDGETS[stage],
        system: [
            { ...billingBlock, cache_control: cacheControl },
            { type: "text", text: systemText, cache_control: cacheControl },
        ],
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: userMessage, cache_control: cacheControl }],
            },
        ],
    };
    if (THINKING_STAGES.has(stage) && supportsThinking) {
        requestBody.thinking = { type: "adaptive" };
        const isOpus = /opus-4-[56]/.test(safetyModel);
        requestBody.output_config = { effort: isOpus ? "max" : "high" };
    }
    const stops = STOP_SEQUENCES[stage];
    if (stops) requestBody.stop_sequences = stops;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAFETY_TIMEOUT_MS);

    const betaHeaders = [
        "claude-code-20250219",
        "context-1m-2025-08-07",
        "interleaved-thinking-2025-05-14",
        "redact-thinking-2026-02-12",
        "context-management-2025-06-27",
        "prompt-caching-scope-2026-01-05",
        "advanced-tool-use-2025-11-20",
        "effort-2025-11-24",
    ];
    let resp: Response;
    try {
        resp = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": betaHeaders.join(","),
                "anthropic-dangerous-direct-browser-access": "true",
                "x-api-key": apiKey,
                "x-app": "cli",
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!resp.ok) {
        const errBody = await resp.text();
        process.stderr.write(`LLM safety check API error ${resp.status}: ${errBody.slice(0, 200)}\n`);
        return null;
    }

    const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
    for (const block of data.content ?? []) {
        if (block.type === "text" && block.text) return block.text.trim();
    }
    return null;
}

function parseJsonVerdict(text: string): SafetyCheckResult | null {
    try {
        const cleaned = text
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();
        return JSON.parse(cleaned) as SafetyCheckResult;
    } catch {
        return null;
    }
}

/** Run a single classifier call and parse its output for the given stage. */
export async function runStage(apiKey: string, stage: ClassifierStage, actionMessage: string, model?: string): Promise<SafetyCheckResult | null> {
    const directive = buildStageDirective(stage);
    const fullMessage = `${actionMessage}\n\n${directive}`;
    const text = await callApi(apiKey, stage, fullMessage, model);
    if (text === null) return null;

    if (stage === "s1" || stage === "single_fast") {
        const xml = parseXmlVerdict(text);
        if (xml.block === null) return null;
        if (stage === "s1") {
            // S1: "no" = approve clear; "yes" = escalate to S2 (sentinel reason)
            return xml.block === "no"
                ? { decision: "approve", reason: "Stage 1 cleared" }
                : { decision: "needs_context", reason: S1_ESCALATE_SENTINEL };
        }
        // single_fast: "yes" = deny; "no" = approve
        return xml.block === "yes"
            ? { decision: "deny", reason: xml.reason || "Single-stage fast classifier denied" }
            : { decision: "approve", reason: xml.reason || "Single-stage fast classifier approved" };
    }

    return parseJsonVerdict(text);
}

/** Two-stage classifier: S1 fast gate, then S2 on escalate. */
export async function runTwoStage(apiKey: string, actionMessage: string, model?: string): Promise<SafetyCheckResult | null> {
    const s1 = await runStage(apiKey, "s1", actionMessage, model);
    if (!s1) return null;
    if (s1.decision === "approve") return s1;
    if (s1.decision === "deny") return s1;
    // Anything else (including the S1_ESCALATE_SENTINEL) -> run S2
    return runStage(apiKey, "s2", actionMessage, model);
}

/** Single-stage classifier (fast or thinking variant). */
export async function runSingleStage(
    apiKey: string,
    mode: "single_fast" | "single_thinking",
    actionMessage: string,
    model?: string
): Promise<SafetyCheckResult | null> {
    return runStage(apiKey, mode, actionMessage, model);
}

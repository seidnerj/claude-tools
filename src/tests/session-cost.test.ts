import { describe, it, expect } from "vitest";
import { calculateCost, MODEL_PRICING } from "../session-cost.js";

describe("MODEL_PRICING", () => {
    it("contains pricing for known models", () => {
        expect(MODEL_PRICING["claude-opus-4-6"]).toBeDefined();
        expect(MODEL_PRICING["claude-sonnet-4-6"]).toBeDefined();
        expect(MODEL_PRICING["claude-haiku-4-5"]).toBeDefined();
    });

    it("has consistent pricing structure", () => {
        for (const [, pricing] of Object.entries(MODEL_PRICING)) {
            expect(pricing.inputPerMTok).toBeGreaterThan(0);
            expect(pricing.outputPerMTok).toBeGreaterThan(0);
            expect(pricing.cacheReadPerMTok).toBeGreaterThan(0);
            expect(pricing.cacheWritePerMTok).toBeGreaterThan(0);
        }
    });
});

describe("calculateCost", () => {
    it("calculates cost for a simple session with one model", () => {
        const entries = [
            {
                type: "user",
                timestamp: "2026-01-01T10:00:00Z",
                message: { content: "Hello" },
            },
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Hi" }],
                    usage: {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                    },
                },
            },
        ];

        const result = calculateCost(entries, "test-session", "/test");

        expect(result.sessionId).toBe("test-session");
        expect(result.models).toHaveLength(1);
        expect(result.models[0].model).toContain("haiku");
        expect(result.models[0].inputTokens).toBe(100);
        expect(result.models[0].outputTokens).toBe(50);
        expect(result.models[0].cost).toBeGreaterThan(0);
    });

    it("aggregates usage across multiple assistant entries for same model", () => {
        const entries = [
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Response 1" }],
                    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
            {
                type: "assistant",
                timestamp: "2026-01-01T10:01:00Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Response 2" }],
                    usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.models).toHaveLength(1);
        expect(result.models[0].inputTokens).toBe(300);
        expect(result.models[0].outputTokens).toBe(150);
    });

    it("separates usage by model", () => {
        const entries = [
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-opus-4-6",
                    content: [{ type: "text", text: "Opus response" }],
                    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
            {
                type: "assistant",
                timestamp: "2026-01-01T10:01:00Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Haiku response" }],
                    usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.models).toHaveLength(2);
    });

    it("accounts for cache read and write tokens", () => {
        const entries = [
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-opus-4-6",
                    content: [{ type: "text", text: "Response" }],
                    usage: {
                        input_tokens: 10,
                        output_tokens: 50,
                        cache_read_input_tokens: 500000,
                        cache_creation_input_tokens: 100000,
                    },
                },
            },
        ];

        const result = calculateCost(entries, "test", "/test");
        const model = result.models[0];
        expect(model.cacheReadTokens).toBe(500000);
        expect(model.cacheWriteTokens).toBe(100000);
        // Opus 4.6: cache read = $0.50/MTok, cache write = $6.25/MTok
        // 500k cache read = $0.25, 100k cache write = $0.625
        // 10 input = ~$0, 50 output = ~$0.00125
        expect(model.cost).toBeGreaterThan(0.8);
    });

    it("calculates wall and API durations", () => {
        const entries = [
            { type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Start" } },
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Mid" }],
                    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
            { type: "system", subtype: "turn_duration", durationMs: 30000, timestamp: "2026-01-01T10:00:35Z" },
            { type: "system", subtype: "turn_duration", durationMs: 15000, timestamp: "2026-01-01T10:01:00Z" },
            { type: "user", timestamp: "2026-01-01T10:05:00Z", message: { content: "End" } },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.durations.apiDurationMs).toBe(45000);
        expect(result.durations.wallDurationMs).toBe(300000);
    });

    it("handles entries with no usage data gracefully", () => {
        const entries = [
            { type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" } },
            { type: "assistant", timestamp: "2026-01-01T10:00:05Z", message: { content: "Hi" } },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.totalCost).toBe(0);
        expect(result.models).toHaveLength(0);
    });

    it("normalizes model IDs with date suffixes", () => {
        const entries = [
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Response" }],
                    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.models[0].model).toMatch(/haiku/);
    });

    it("returns zero cost for empty entries", () => {
        const result = calculateCost([], "test", "/test");
        expect(result.totalCost).toBe(0);
        expect(result.models).toHaveLength(0);
    });

    it("sorts models by cost descending", () => {
        const entries = [
            {
                type: "assistant",
                timestamp: "2026-01-01T10:00:05Z",
                message: {
                    model: "claude-haiku-4-5-20251001",
                    content: [{ type: "text", text: "Cheap" }],
                    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
            {
                type: "assistant",
                timestamp: "2026-01-01T10:01:00Z",
                message: {
                    model: "claude-opus-4-6",
                    content: [{ type: "text", text: "Expensive" }],
                    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                },
            },
        ];

        const result = calculateCost(entries, "test", "/test");
        expect(result.models[0].model).toContain("opus");
        expect(result.models[1].model).toContain("haiku");
    });
});

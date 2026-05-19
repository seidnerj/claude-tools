// ---------------------------------------------------------------------------
// API key validity check via the count_tokens endpoint (free, no output).
// ---------------------------------------------------------------------------

import * as https from "node:https";
import type { KeyValidationResult } from "../types.js";

export function validateKey(apiKey: string): Promise<KeyValidationResult> {
    const body = JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        messages: [{ role: "user", content: "a" }],
    });

    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: "api.anthropic.com",
                path: "/v1/messages/count_tokens",
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                    "content-length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let raw = "";
                res.on("data", (chunk: Buffer) => {
                    raw += chunk.toString();
                });
                res.on("end", () => {
                    try {
                        const data = JSON.parse(raw) as {
                            input_tokens?: number;
                            error?: { type: string; message: string };
                        };
                        if (data.input_tokens !== undefined) {
                            resolve({ valid: true });
                            return;
                        }
                        const msg = data.error?.message ?? "Unknown error";
                        if (data.error?.type === "authentication_error") {
                            resolve({ valid: false, error: "invalid_key", message: msg });
                            return;
                        }
                        if (msg.includes("usage limits")) {
                            const match = msg.match(/regain access on (.+?) at/);
                            resolve({ valid: false, error: "quota_exhausted", message: msg, quotaResetsAt: match?.[1] });
                            return;
                        }
                        resolve({ valid: false, error: "unknown", message: msg });
                    } catch {
                        resolve({ valid: false, error: "unknown", message: raw });
                    }
                });
            }
        );
        req.on("error", (err: Error) => resolve({ valid: false, error: "network_error", message: err.message }));
        req.write(body);
        req.end();
    });
}

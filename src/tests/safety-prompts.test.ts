import { describe, it, expect } from "vitest";
import { buildSystemPrompt, SYSTEM_PROMPT } from "../safety-prompts.js";

describe("buildSystemPrompt", () => {
    it("returns prompt with no user rules and replaces placeholders cleanly", () => {
        const out = buildSystemPrompt();
        expect(out).not.toContain("<user_block_rules>");
        expect(out).not.toContain("<user_allow_rules>");
        expect(out).not.toContain("<user_environment>");
        expect(out).toContain("(none configured)");
    });

    it("injects user-supplied block rules as bullets", () => {
        const out = buildSystemPrompt({ block_rules: ["No production deploys", "No DROP TABLE"] });
        expect(out).toContain("- No production deploys");
        expect(out).toContain("- No DROP TABLE");
    });

    it("injects user-supplied allow rules", () => {
        const out = buildSystemPrompt({ allow_rules: ["Reading from internal docs"] });
        expect(out).toContain("- Reading from internal docs");
    });

    it("injects environment lines and replaces the (none configured) default", () => {
        const out = buildSystemPrompt({ environment: ["repo: github.com/me/proj", "bucket: s3://my-bucket"] });
        expect(out).toContain("- repo: github.com/me/proj");
        expect(out).toContain("- bucket: s3://my-bucket");
        expect(out).not.toContain("(none configured)");
    });

    it("base SYSTEM_PROMPT still contains placeholders before substitution", () => {
        expect(SYSTEM_PROMPT).toContain("<user_block_rules>");
        expect(SYSTEM_PROMPT).toContain("<user_allow_rules>");
        expect(SYSTEM_PROMPT).toContain("<user_environment>");
    });
});

// ---------------------------------------------------------------------------
// Claude Code changelog - parse, query, and fetch the CHANGELOG.md
// ---------------------------------------------------------------------------

import type {
    Changelog,
    ChangelogEntry,
    ChangelogVersion,
    ChangelogVersionResult,
    ChangelogDiff,
    ChangelogSearchHit,
    ChangelogSearchResult,
} from "./types.js";

const CHANGELOG_URL = "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md";

const CATEGORY_VERBS: Record<string, string> = {
    added: "Added",
    fixed: "Fixed",
    improved: "Improved",
    changed: "Changed",
    removed: "Removed",
};

const CATEGORY_PREFIXES: Record<string, string> = {
    "security:": "Security",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compare two dotted semver strings numerically. Returns <0, 0, or >0. */
function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = pa[i] ?? 0;
        const nb = pb[i] ?? 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

/** Infer a category from the leading words of an entry. */
function categorize(text: string): string {
    const lower = text.toLowerCase();
    for (const [prefix, category] of Object.entries(CATEGORY_PREFIXES)) {
        if (lower.startsWith(prefix)) return category;
    }
    const firstWord = lower.replace(/^\[.*?\]\s*/, "").split(/\s/)[0];
    return CATEGORY_VERBS[firstWord] ?? "Other";
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse raw changelog markdown into structured data. */
export function parseChangelog(markdown: string): Changelog {
    const versions: ChangelogVersion[] = [];
    const versionHeaderRe = /^## (\d+\.\d+\.\d+)/;

    let currentVersion: ChangelogVersion | null = null;

    for (const line of markdown.split("\n")) {
        const headerMatch = line.match(versionHeaderRe);
        if (headerMatch) {
            currentVersion = { version: headerMatch[1], entries: [] };
            versions.push(currentVersion);
            continue;
        }

        if (!currentVersion) continue;

        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
            const text = trimmed.slice(2).trim();
            if (text) {
                currentVersion.entries.push({ category: categorize(text), text });
            }
        }
    }

    return { versions };
}

// ---------------------------------------------------------------------------
// Version lookup
// ---------------------------------------------------------------------------

/** Get entries for a specific version. Returns null if not found. */
export function getVersion(changelog: Changelog, version: string): ChangelogVersionResult | null {
    const found = changelog.versions.find((v) => v.version === version);
    if (!found) return null;
    return { version: found.version, entries: found.entries };
}

// ---------------------------------------------------------------------------
// Version diff
// ---------------------------------------------------------------------------

/** Get all changes between two versions. fromVersion is exclusive, toVersion is inclusive. */
export function diffVersions(changelog: Changelog, options?: { fromVersion?: string; toVersion?: string }): ChangelogDiff {
    let fromVersion = options?.fromVersion ?? "";
    let toVersion = options?.toVersion ?? "";

    if (fromVersion && !changelog.versions.some((v) => v.version === fromVersion)) {
        throw new Error(`Version "${fromVersion}" not found in changelog`);
    }
    if (toVersion && !changelog.versions.some((v) => v.version === toVersion)) {
        throw new Error(`Version "${toVersion}" not found in changelog`);
    }

    // Swap if reversed
    if (fromVersion && toVersion && compareSemver(fromVersion, toVersion) > 0) {
        [fromVersion, toVersion] = [toVersion, fromVersion];
    }

    // Default toVersion to the latest
    if (!toVersion && fromVersion) {
        toVersion = changelog.versions[0].version;
    }

    // Filter to versions in range, then sort oldest-first
    const inRange = changelog.versions.filter((v) => {
        if (fromVersion && compareSemver(v.version, fromVersion) <= 0) return false;
        if (toVersion && compareSemver(v.version, toVersion) > 0) return false;
        return true;
    });

    const sorted = [...inRange].sort((a, b) => compareSemver(a.version, b.version));

    // Build merged categories
    const merged: Record<string, string[]> = {};
    for (const ver of sorted) {
        for (const entry of ver.entries) {
            if (!merged[entry.category]) merged[entry.category] = [];
            merged[entry.category].push(entry.text);
        }
    }

    return { fromVersion, toVersion, versions: sorted, merged };
}

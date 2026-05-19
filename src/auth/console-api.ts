// ---------------------------------------------------------------------------
// platform.claude.com helpers: org discovery + key metadata fetch.
// ---------------------------------------------------------------------------

import { getAdminCreds, storeKeyMeta } from "./metadata.js";

export async function fetchOrgId(sessionKey: string): Promise<string | null> {
    try {
        const resp = await fetch("https://platform.claude.com/api/bootstrap?statsig_hashing_algorithm=djb2&growthbook_format=sdk", {
            headers: {
                Cookie: `sessionKey=${sessionKey}`,
                "Content-Type": "application/json",
                "anthropic-client-platform": "web_console",
            },
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            account?: { memberships?: Array<{ organization?: { uuid?: string; capabilities?: string[] } }> };
        };
        const apiOrg = data?.account?.memberships?.find((m) => m.organization?.capabilities?.includes("api"));
        return apiOrg?.organization?.uuid ?? null;
    } catch {
        return null;
    }
}

export async function fetchAndStoreKeyMeta(directory: string, apiKey: string, creds?: { sessionKey: string }): Promise<boolean> {
    const sessionKey = creds?.sessionKey ?? getAdminCreds(directory)?.sessionKey ?? process.env.ANTHROPIC_API_PLAN_ADMIN_SESSION_KEY;
    if (!sessionKey) return false;
    const orgId = await fetchOrgId(sessionKey);
    if (!orgId) return false;

    try {
        const resp = await fetch(`https://platform.claude.com/api/console/organizations/${orgId}/api_keys?limit=100`, {
            headers: {
                Cookie: `sessionKey=${sessionKey}`,
                "Content-Type": "application/json",
                "anthropic-client-platform": "web_console",
            },
        });
        if (!resp.ok) return false;
        type KeyEntry = { id: string; workspace_id: string | null; partial_key_hint: string; status?: string };
        const raw = (await resp.json()) as KeyEntry[] | { data?: KeyEntry[] };
        const keys = (Array.isArray(raw) ? raw : (raw.data ?? [])).filter((k) => k.status !== "archived");
        const match = keys.find((k) => {
            const [prefix, suffix] = k.partial_key_hint.split("...");
            return prefix && suffix && apiKey.startsWith(prefix) && apiKey.endsWith(suffix);
        });
        if (!match) return false;
        return storeKeyMeta(directory, match.id, match.workspace_id ?? "");
    } catch {
        return false;
    }
}

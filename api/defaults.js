import { put, list, del } from '@vercel/blob';

// Shared across the team — single source of truth
const DEFAULTS_PREFIX = 'manifest-jd-defaults';
// Per-user drafts — keyed by sanitized hiring manager name
const AUTOSAVE_PREFIX = 'manifest-jd-autosave';

// Sanitize a user identifier for safe use in blob paths.
// Strips everything non-alphanumeric, lowercases, trims to 64 chars.
function sanitizeUser(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
}

// Compose a prefix for the request. Autosave gets per-user scope.
function resolvePrefix(type, user) {
    if (type === 'autosave') {
        const safe = sanitizeUser(user);
        // If no user id provided, fall back to a shared 'guest' bucket so the
        // tool still functions (but Push to CMS is gated on name anyway).
        return `${AUTOSAVE_PREFIX}-${safe || 'guest'}`;
    }
    return DEFAULTS_PREFIX;
}

// Read latest blob under a prefix. Uses random-suffix URLs so we pick the
// newest by uploadedAt — avoids the eventual-consistency traps we hit with
// fixed-key overwrites on Vercel Blob.
async function readLatest(prefix) {
    const { blobs } = await list({ prefix });
    if (blobs.length === 0) return null;
    const latest = blobs.reduce((a, b) =>
        new Date(a.uploadedAt) > new Date(b.uploadedAt) ? a : b
    );
    const response = await fetch(latest.url, { cache: 'no-store' });
    return response.json();
}

// Atomic write: put() with random suffix → new URL per write, then
// best-effort cleanup of older blobs with the same prefix.
async function writeAtomic(prefix, data) {
    const result = await put(`${prefix}.json`, JSON.stringify(data), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
    });
    try {
        const { blobs } = await list({ prefix });
        const toDelete = blobs.filter(b => b.url !== result.url);
        await Promise.allSettled(toDelete.map(b => del(b.url)));
    } catch (_) { /* cleanup is best-effort */ }
    return result;
}

async function deleteAll(prefix) {
    const { blobs } = await list({ prefix });
    await Promise.allSettled(blobs.map(b => del(b.url)));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const type = req.query?.type || 'defaults';
    const user = req.query?.user || '';
    const prefix = resolvePrefix(type, user);

    try {
        if (req.method === 'GET') {
            const data = await readLatest(prefix);
            return res.json(data || {});
        }

        if (req.method === 'POST') {
            const data = req.body;
            if (!data || typeof data !== 'object') {
                return res.status(400).json({ error: 'Invalid data' });
            }
            await writeAtomic(prefix, data);
            return res.json({ ok: true });
        }

        if (req.method === 'DELETE') {
            // Only allow deleting per-user autosave, not shared defaults
            if (type !== 'autosave') {
                return res.status(403).json({ error: 'Cannot delete shared defaults via this endpoint' });
            }
            await deleteAll(prefix);
            return res.json({ ok: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Defaults API error:', err);
        res.status(500).json({ error: 'Failed to access storage: ' + err.message });
    }
}

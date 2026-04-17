import { put, list, del } from '@vercel/blob';

const TEMPLATES_PREFIX = 'manifest-jd-templates';

// Read the most-recently-uploaded blob matching our prefix.
// Using addRandomSuffix:true elsewhere means each write creates a unique URL,
// so we always fetch the latest by uploadedAt and avoid CDN/cache staleness.
async function getTemplatesBlob() {
    const { blobs } = await list({ prefix: TEMPLATES_PREFIX });
    if (blobs.length === 0) return [];
    const latest = blobs.reduce((a, b) =>
        new Date(a.uploadedAt) > new Date(b.uploadedAt) ? a : b
    );
    // Random-suffix URLs are unique per write — no CDN cache collision, but
    // still pass no-store for safety.
    const response = await fetch(latest.url, { cache: 'no-store' });
    return response.json();
}

// Write a new blob with a random suffix (unique URL), then clean up older blobs.
// This pattern avoids eventual-consistency races that plague fixed-URL overwrites.
async function saveTemplatesBlob(templates) {
    const result = await put(`${TEMPLATES_PREFIX}.json`, JSON.stringify(templates), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
    });

    // Best-effort cleanup of older blobs. We keep the one we just wrote
    // (matched by URL) and delete the rest.
    try {
        const { blobs } = await list({ prefix: TEMPLATES_PREFIX });
        const toDelete = blobs.filter(b => b.url !== result.url);
        await Promise.allSettled(toDelete.map(b => del(b.url)));
    } catch (_) { /* cleanup is best-effort */ }

    return result;
}

// Verify a specific write by fetching directly from its URL (skips list()).
async function fetchByUrl(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to verify write: ${response.status}`);
    return response.json();
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        if (req.method === 'GET') {
            const templates = await getTemplatesBlob();
            return res.json(templates);
        }

        if (req.method === 'POST') {
            const template = req.body;
            if (!template || !template.name) {
                return res.status(400).json({ error: 'Template must have a name' });
            }
            template.id = template.id || Date.now();
            template.createdAt = template.createdAt || new Date().toISOString();

            const templates = await getTemplatesBlob();
            templates.push(template);
            await saveTemplatesBlob(templates);
            return res.json({ ok: true, template });
        }

        if (req.method === 'DELETE') {
            // Vercel's runtime may deliver DELETE body as a string
            let body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (_) { body = {}; }
            }
            const id = body?.id;
            if (!id) return res.status(400).json({ error: 'Missing template id' });

            const beforeTemplates = await getTemplatesBlob();
            const filtered = beforeTemplates.filter(t => String(t.id) !== String(id));

            if (beforeTemplates.length === filtered.length) {
                // Already gone — idempotent success
                return res.json({ ok: true, deleted: false, remaining: filtered.length });
            }

            // Write the new list. Verify by fetching from the returned URL
            // directly, which bypasses list() eventual consistency.
            const writeResult = await saveTemplatesBlob(filtered);
            const verify = await fetchByUrl(writeResult.url);
            const stillPresent = verify.some(t => String(t.id) === String(id));

            if (stillPresent) {
                return res.status(500).json({
                    error: 'Write verified at URL but ID still present — data corruption?',
                });
            }

            return res.json({
                ok: true,
                deleted: true,
                remaining: verify.length,
                url: writeResult.url,
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Templates API error:', err);
        return res.status(500).json({ error: 'Template storage error: ' + err.message });
    }
}

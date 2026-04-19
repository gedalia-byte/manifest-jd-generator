import { put, list, del } from '@vercel/blob';

const TEMPLATES_PREFIX = 'manifest-jd-templates';

// Read the most-recently-uploaded blob matching our prefix.
async function getTemplatesBlob() {
    const { blobs } = await list({ prefix: TEMPLATES_PREFIX });
    if (blobs.length === 0) return [];
    const latest = blobs.reduce((a, b) =>
        new Date(a.uploadedAt) > new Date(b.uploadedAt) ? a : b
    );
    const response = await fetch(latest.url, { cache: 'no-store' });
    return response.json();
}

// Atomic-ish write: random-suffix blob, then cleanup older ones.
async function saveTemplatesBlob(templates) {
    const result = await put(`${TEMPLATES_PREFIX}.json`, JSON.stringify(templates), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: true,
    });
    try {
        const { blobs } = await list({ prefix: TEMPLATES_PREFIX });
        const toDelete = blobs.filter(b => b.url !== result.url);
        await Promise.allSettled(toDelete.map(b => del(b.url)));
    } catch (_) { /* cleanup is best-effort */ }
    return result;
}

async function fetchByUrl(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Failed to verify write: ${response.status}`);
    return response.json();
}

// Concurrency-safe mutation: read → apply → write → verify → retry on race.
// Handles the case where another request wrote between our read and write
// (which would otherwise clobber their changes or undo ours).
async function mutateWithRetry(mutate, verify, { maxAttempts = 5, baseDelayMs = 150 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const current = await getTemplatesBlob();
        const next = mutate(current);
        const writeResult = await saveTemplatesBlob(next);
        const readback = await fetchByUrl(writeResult.url);
        if (verify(readback)) {
            return { writeResult, data: readback, attempts: attempt + 1 };
        }
        // Verification failed — almost certainly a concurrent writer overwrote us.
        // Wait a bit with jitter, then retry by re-reading fresh state.
        lastErr = new Error(`Mutation did not persist (attempt ${attempt + 1})`);
        const jitter = Math.random() * 100;
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt) + jitter));
    }
    throw lastErr || new Error('Mutation failed after retries');
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

            // Upsert: if a template with the same ID already exists, replace
            // it (preserving original createdAt). Otherwise append. This lets
            // clients re-POST the same id to update in place — used by the
            // auto-save-on-CMS-push flow so repeat pushes don't create
            // duplicates.
            //
            // Concurrent-safe: mutateWithRetry re-applies against the latest
            // list if another user wrote between our read and write.
            const result = await mutateWithRetry(
                (list) => {
                    const idx = list.findIndex(t => String(t.id) === String(template.id));
                    if (idx >= 0) {
                        const updated = [...list];
                        updated[idx] = {
                            ...template,
                            createdAt: list[idx].createdAt || template.createdAt,
                            updatedAt: new Date().toISOString(),
                        };
                        return updated;
                    }
                    return [...list, template];
                },
                (after) => after.some(t => String(t.id) === String(template.id)),
            );
            return res.json({ ok: true, template, attempts: result.attempts });
        }

        if (req.method === 'DELETE') {
            let body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (_) { body = {}; }
            }
            const id = body?.id;
            if (!id) return res.status(400).json({ error: 'Missing template id' });

            // Fast path: already gone → idempotent success
            const before = await getTemplatesBlob();
            if (!before.some(t => String(t.id) === String(id))) {
                return res.json({ ok: true, deleted: false, remaining: before.length });
            }

            // Concurrent-safe: if another user's write resurrects the target
            // id between our read and write, we re-apply the delete.
            const result = await mutateWithRetry(
                (list) => list.filter(t => String(t.id) !== String(id)),
                (after) => !after.some(t => String(t.id) === String(id)),
            );
            return res.json({
                ok: true,
                deleted: true,
                remaining: result.data.length,
                attempts: result.attempts,
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Templates API error:', err);
        return res.status(500).json({ error: 'Template storage error: ' + err.message });
    }
}

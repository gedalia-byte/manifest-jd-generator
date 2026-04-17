import { put, list, del } from '@vercel/blob';

const TEMPLATES_KEY = 'manifest-jd-templates.json';

async function getTemplatesBlob() {
    return getLatestTemplatesBlob();
}

async function saveTemplatesBlob(templates) {
    // Atomic write — put() at the same key with addRandomSuffix:false overwrites
    // in place. Avoids the del→list→put race where eventual consistency in Vercel
    // Blob can leave stale or duplicate blobs during the window between operations.
    await put(TEMPLATES_KEY, JSON.stringify(templates), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
    });

    // Cleanup: if any orphaned blobs exist from past del→put races, remove them.
    // We keep the one whose URL matches our canonical key.
    const { blobs } = await list({ prefix: TEMPLATES_KEY });
    if (blobs.length > 1) {
        // Sort by uploadedAt desc — keep the newest, delete the rest
        const sorted = [...blobs].sort((a, b) =>
            new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
        );
        for (let i = 1; i < sorted.length; i++) {
            try { await del(sorted[i].url); } catch (_) { /* best-effort cleanup */ }
        }
    }
}

async function getLatestTemplatesBlob() {
    const { blobs } = await list({ prefix: TEMPLATES_KEY });
    if (blobs.length === 0) return [];
    // Always pick the most recently uploaded blob — defensive against leaks
    const latest = blobs.reduce((a, b) =>
        new Date(a.uploadedAt) > new Date(b.uploadedAt) ? a : b
    );
    const response = await fetch(latest.url + '?t=' + Date.now(), { cache: 'no-store' });
    return response.json();
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Don't let the browser cache template list — it changes when users add/delete
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        // GET — list all templates
        if (req.method === 'GET') {
            const templates = await getTemplatesBlob();
            return res.json(templates);
        }

        // POST — add a template
        if (req.method === 'POST') {
            const template = req.body;
            if (!template || !template.name) {
                return res.status(400).json({ error: 'Template must have a name' });
            }
            // Add ID and timestamp
            template.id = template.id || Date.now();
            template.createdAt = template.createdAt || new Date().toISOString();

            const templates = await getTemplatesBlob();
            templates.push(template);
            await saveTemplatesBlob(templates);
            return res.json({ ok: true, template });
        }

        // DELETE — remove a template by ID
        if (req.method === 'DELETE') {
            // Vercel sometimes gives body as a string for DELETE — handle both
            let body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (_) { body = {}; }
            }
            const id = body?.id;
            if (!id) return res.status(400).json({ error: 'Missing template id' });

            const beforeTemplates = await getTemplatesBlob();
            const before = beforeTemplates.length;
            const filtered = beforeTemplates.filter(t => String(t.id) !== String(id));
            const targetCount = filtered.length;

            if (before === targetCount) {
                // Not found — treat as success (idempotent)
                return res.json({ ok: true, deleted: false, remaining: targetCount });
            }

            await saveTemplatesBlob(filtered);

            // Verify — read back and confirm the ID is gone.
            // Retry once with small delay to account for Blob eventual consistency.
            let verify = await getTemplatesBlob();
            let stillPresent = verify.some(t => String(t.id) === String(id));
            if (stillPresent) {
                await new Promise(r => setTimeout(r, 400));
                await saveTemplatesBlob(filtered); // re-write
                verify = await getTemplatesBlob();
                stillPresent = verify.some(t => String(t.id) === String(id));
            }

            if (stillPresent) {
                return res.status(500).json({ error: 'Delete did not persist — please retry' });
            }

            return res.json({ ok: true, deleted: true, remaining: verify.length });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Templates API error:', err);
        res.status(500).json({ error: 'Failed to access template storage: ' + err.message });
    }
}

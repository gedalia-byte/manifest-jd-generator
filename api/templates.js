import { put, list, del } from '@vercel/blob';

const TEMPLATES_KEY = 'manifest-jd-templates.json';

async function getTemplatesBlob() {
    const { blobs } = await list({ prefix: TEMPLATES_KEY });
    if (blobs.length === 0) return [];
    // Fetch the latest blob with cache-busting — the Blob CDN caches by URL
    // and addRandomSuffix:false keeps URLs constant, so we must bypass cache
    const response = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
    return response.json();
}

async function saveTemplatesBlob(templates) {
    // Delete old blob first
    const { blobs } = await list({ prefix: TEMPLATES_KEY });
    for (const blob of blobs) {
        await del(blob.url);
    }
    // Save new blob
    await put(TEMPLATES_KEY, JSON.stringify(templates), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
    });
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
            const { id } = req.body || {};
            if (!id) return res.status(400).json({ error: 'Missing template id' });

            let templates = await getTemplatesBlob();
            templates = templates.filter(t => String(t.id) !== String(id));
            await saveTemplatesBlob(templates);
            return res.json({ ok: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Templates API error:', err);
        res.status(500).json({ error: 'Failed to access template storage: ' + err.message });
    }
}

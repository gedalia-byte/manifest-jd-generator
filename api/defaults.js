import { put, list, del } from '@vercel/blob';

const DEFAULTS_KEY = 'manifest-jd-defaults.json';
const AUTOSAVE_KEY = 'manifest-jd-autosave.json';

async function getBlob(key) {
    const { blobs } = await list({ prefix: key });
    if (blobs.length === 0) return null;
    const response = await fetch(blobs[0].url);
    return response.json();
}

async function saveBlob(key, data) {
    const { blobs } = await list({ prefix: key });
    for (const blob of blobs) {
        await del(blob.url);
    }
    await put(key, JSON.stringify(data), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
    });
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Determine which store to use based on ?type= param
    const type = req.query?.type || 'defaults';
    const key = type === 'autosave' ? AUTOSAVE_KEY : DEFAULTS_KEY;

    try {
        if (req.method === 'GET') {
            const data = await getBlob(key);
            return res.json(data || {});
        }

        if (req.method === 'POST') {
            const data = req.body;
            if (!data || typeof data !== 'object') {
                return res.status(400).json({ error: 'Invalid data' });
            }
            await saveBlob(key, data);
            return res.json({ ok: true });
        }

        return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
        console.error('Defaults API error:', err);
        res.status(500).json({ error: 'Failed to access storage: ' + err.message });
    }
}

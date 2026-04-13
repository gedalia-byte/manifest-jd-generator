import { connect } from "framer-api"

// Increase Vercel function timeout (Pro plan: up to 60s)
export const config = {
    maxDuration: 60,
};

const PROJECT_URL = process.env.FRAMER_PROJECT_URL
const FRAMER_API_KEY = process.env.FRAMER_API_KEY

async function withFramer(fn) {
    if (!FRAMER_API_KEY || !PROJECT_URL) {
        throw new Error('Framer env vars not configured. Need FRAMER_API_KEY and FRAMER_PROJECT_URL.');
    }

    console.log('Connecting to Framer...', { projectUrl: PROJECT_URL?.substring(0, 40) + '...' });
    const framer = await connect(PROJECT_URL, FRAMER_API_KEY);
    console.log('Connected to Framer');

    try {
        return await fn(framer);
    } finally {
        await framer.disconnect();
        console.log('Disconnected from Framer');
    }
}

async function getJobsCollection(framer) {
    const collections = await framer.getCollections()
    console.log('Collections found:', collections.map(c => c.name));
    const collection = collections.find(c => c.name === "Careers")
    if (!collection) {
        throw new Error(`Framer collection 'Careers' not found. Available: ${collections.map(c => c.name).join(', ')}`)
    }
    return collection
}

async function buildFieldData(collection, job) {
    const fields = await collection.getFields()
    console.log('Fields found:', fields.map(f => f.name));
    const field = Object.fromEntries(fields.map(f => [f.name, f]))

    const data = {};
    const fieldMap = {
        "Title": job.title,
        "Location": job.location,
        "Level": job.level,
        "Reports To": job.reportsTo,
        "About Manifest": job.aboutCompany,
        "About the Team": job.aboutTeam,
        "Ideal Experience": job.idealExperience,
        "Responsibilities": job.responsibilities,
        "For You": job.goodFit,
        "Not For You": job.notAFit,
        "Comp Band": job.compBand,
    };

    for (const [name, value] of Object.entries(fieldMap)) {
        if (field[name]) {
            data[field[name].id] = { type: "string", value: value || '' };
        } else {
            console.warn(`Field "${name}" not found in Framer collection`);
        }
    }

    return data;
}

// Find an existing item by matching the slug
async function findItemBySlug(collection, slug) {
    const items = await collection.getItems();
    console.log(`Looking for slug "${slug}" among ${items.length} items`);
    for (const item of items) {
        if (item.slug === slug) {
            console.log(`Found existing item: id=${item.id}, slug=${item.slug}`);
            return item;
        }
    }
    return null;
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Health check
    if (req.method === 'GET') {
        return res.json({
            status: 'ok',
            hasApiKey: !!FRAMER_API_KEY,
            hasProjectUrl: !!PROJECT_URL,
            nodeVersion: process.version,
        });
    }

    try {
        if (req.method === 'POST') {
            const { job } = req.body

            if (!job) return res.status(400).json({ error: 'Missing job data' })
            if (!job.title) return res.status(400).json({ error: 'Missing job title' })

            console.log(`sync-to-framer: push title="${job.title}" slug="${job.slug}"`);

            const result = await withFramer(async (framer) => {
                const collection = await getJobsCollection(framer)
                const fieldData = await buildFieldData(collection, job)

                // Check if an item with this slug already exists
                const existing = await findItemBySlug(collection, job.slug);

                if (existing) {
                    // Update existing item
                    console.log('Updating existing item:', existing.id);
                    await existing.setAttributes({ fieldData });
                    return { success: true, action: 'updated', itemId: existing.id, slug: job.slug }
                }

                // Create new item — let Framer assign the ID
                console.log('Creating new item with slug:', job.slug);
                await collection.addItems([{
                    slug: job.slug,
                    fieldData,
                }]);
                return { success: true, action: 'created', slug: job.slug }
            });

            return res.json(result);
        }

        if (req.method === 'DELETE') {
            const { slug } = req.body
            if (!slug) return res.status(400).json({ error: 'Missing slug' })

            console.log(`sync-to-framer: DELETE slug="${slug}"`);

            const result = await withFramer(async (framer) => {
                const collection = await getJobsCollection(framer)
                const existing = await findItemBySlug(collection, slug);
                if (!existing) return { success: true, action: 'not found (already deleted)' }
                await existing.delete()
                return { success: true, action: 'deleted' }
            });

            return res.json(result);
        }

        return res.status(405).json({ error: 'Method not allowed' })

    } catch (err) {
        console.error('sync-to-framer error:', err.message, err.stack);
        return res.status(500).json({
            error: err.message,
            hint: err.message.includes('env') ? 'Check FRAMER_API_KEY and FRAMER_PROJECT_URL in Vercel env vars' :
                  err.message.includes('timeout') ? 'Connection timed out — Framer may be slow, try again' :
                  'Check Vercel function logs for details'
        })
    }
}

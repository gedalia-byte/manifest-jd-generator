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
    // Field names must match Framer CMS collection EXACTLY (case-sensitive)
    const fieldMap = {
        "Title": job.title,
        "Location": job.location,
        "Employment type": job.employmentType,
        "Function": job.jobFunction,
        "Level": job.level,
        "Reports to": job.reportsTo,
        "Salary range": job.compBand,
        "About Manifest": job.aboutCompany,
        "About the team": job.aboutTeam,
        "About the role": job.aboutRole,
        "Ideal experience": job.idealExperience,
        "This for you if": job.goodFit,
        "Not for you if": job.notAFit,
        // Fields below don't exist in Framer yet — add them in Framer to sync
        "Responsibilities": job.responsibilities,
        "Created By": job.createdBy,
    };

    for (const [name, rawValue] of Object.entries(fieldMap)) {
        const f = field[name];
        if (!f) {
            console.warn(`Field "${name}" not found in Framer collection`);
            continue;
        }
        const value = rawValue || '';

        if (f.type === 'enum') {
            // Enum fields require the case id, not the case name. Look up the
            // case whose name matches our value (case-insensitive).
            const cases = f.cases || [];
            if (!value) {
                // Empty enum — skip the write rather than guessing a default
                console.warn(`Skipping empty enum value for "${name}"`);
                continue;
            }
            const match = cases.find(c =>
                String(c.name || '').toLowerCase() === String(value).toLowerCase()
            );
            if (!match) {
                console.warn(
                    `Enum value "${value}" not found in cases for "${name}". ` +
                    `Available cases: ${cases.map(c => c.name).join(', ')}`
                );
                continue;
            }
            data[f.id] = { type: 'enum', value: match.id };
        } else if (f.type === 'string') {
            data[f.id] = { type: 'string', value };
        } else {
            // Unknown type — try the value as-is and let Framer complain
            data[f.id] = { type: f.type, value };
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

    // Health check + debug/list endpoints
    if (req.method === 'GET') {
        // ?debug=fields returns the actual Framer collection field names
        if (req.query?.debug === 'fields') {
            try {
                const result = await withFramer(async (framer) => {
                    const collection = await getJobsCollection(framer);
                    const fields = await collection.getFields();
                    return {
                        collectionName: collection.name,
                        fields: fields.map(f => {
                            const out = {
                                name: f.name,
                                type: f.type,
                                id: f.id,
                            };
                            if (f.cases) {
                                // Dump every property — the SDK might use
                                // any of name/key/label/id for case fields
                                out.cases = f.cases.map(c => {
                                    const obj = {};
                                    for (const k of Object.getOwnPropertyNames(c)) obj[k] = c[k];
                                    return obj;
                                });
                                out.caseKeys = f.cases.length
                                    ? Object.getOwnPropertyNames(f.cases[0])
                                    : [];
                            }
                            // Dump all enumerable + own properties on the field too
                            out._allFieldKeys = Object.getOwnPropertyNames(f);
                            return out;
                        })
                    };
                });
                return res.json(result);
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }
        // ?debug=item&slug=X returns the raw fieldData stored in Framer for
        // that slug — used to diagnose field-mapping issues (e.g. wrong text
        // showing up in a field).
        if (req.query?.debug === 'item' && req.query?.slug) {
            try {
                const slug = req.query.slug;
                const result = await withFramer(async (framer) => {
                    const collection = await getJobsCollection(framer);
                    const fields = await collection.getFields();
                    const item = await findItemBySlug(collection, slug);
                    if (!item) return { found: false, slug };
                    // Build a human-readable map of field name → stored value
                    const byName = {};
                    for (const f of fields) {
                        const stored = item.fieldData?.[f.id];
                        byName[f.name] = stored?.value ?? null;
                    }
                    return {
                        found: true,
                        slug: item.slug,
                        itemId: item.id,
                        fieldsByName: byName,
                    };
                });
                return res.json(result);
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }
        // ?list=titles returns all existing job titles — used for Job Title
        // autocomplete. Cached briefly by the client.
        if (req.query?.list === 'titles') {
            try {
                const result = await withFramer(async (framer) => {
                    const collection = await getJobsCollection(framer);
                    const fields = await collection.getFields();
                    const titleField = fields.find(f => f.name === 'Title');
                    if (!titleField) return { titles: [] };
                    const items = await collection.getItems();
                    const titles = items
                        .map(item => item.fieldData?.[titleField.id]?.value)
                        .filter(t => t && typeof t === 'string');
                    // De-dupe and sort
                    return { titles: Array.from(new Set(titles)).sort() };
                });
                // Cache for 60s on CDN since titles don't change constantly
                res.setHeader('Cache-Control', 'public, max-age=60');
                return res.json(result);
            } catch (err) {
                return res.status(500).json({ error: err.message, titles: [] });
            }
        }
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

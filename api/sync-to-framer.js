import { connect } from "framer-api"

const PROJECT_URL = process.env.FRAMER_PROJECT_URL
const FRAMER_API_KEY = process.env.FRAMER_API_KEY

async function getJobsCollection(framer) {
    const collections = await framer.getCollections()
    const collection = collections.find(c => c.name === "Careers")
    if (!collection) throw new Error("Framer collection 'Careers' not found.")
    return collection
}

async function buildFieldData(collection, job) {
    const fields = await collection.getFields()
    const field = Object.fromEntries(fields.map(f => [f.name, f]))

    return {
        [field["Title"].id]:            { type: "string", value: job.title },
        [field["Location"].id]:         { type: "string", value: job.location },
        [field["Level"].id]:            { type: "string", value: job.level },
        [field["Reports To"].id]:       { type: "string", value: job.reportsTo },
        [field["Ideal Experience"].id]: { type: "string", value: job.idealExperience },
        [field["Responsibilities"].id]: { type: "string", value: job.responsibilities },
        [field["For You"].id]:          { type: "string", value: job.goodFit },
        [field["Not For You"].id]:      { type: "string", value: job.notAFit },
        [field["Comp Band"].id]:        { type: "string", value: job.compBand },
    }
}

export default async function handler(req, res) {
    if (!FRAMER_API_KEY || !PROJECT_URL) {
        return res.status(500).json({ error: 'Framer env vars not configured' })
    }

    const framer = await connect(PROJECT_URL, FRAMER_API_KEY)

    try {
        if (req.method === 'POST') {
            const { action, job, jobId } = req.body

            if (!job)   return res.status(400).json({ error: 'Missing job data' })
            if (!jobId) return res.status(400).json({ error: 'Missing jobId' })

            const collection = await getJobsCollection(framer)
            const fieldData = await buildFieldData(collection, job)

            if (action === 'create') {
                await collection.addItems([{
                    id: jobId,
                    slug: job.slug,
                    fieldData,
                }])
                return res.json({ success: true })
            }

            if (action === 'update') {
                const items = await collection.getItems()
                const item = items.find(i => i.id === jobId)
                if (!item) return res.status(404).json({ error: 'Item not found in Framer' })
                await item.setAttributes({ fieldData })
                return res.json({ success: true })
            }

            return res.status(400).json({ error: 'Invalid action — use "create" or "update"' })
        }

        if (req.method === 'DELETE') {
            const { jobId } = req.body
            if (!jobId) return res.status(400).json({ error: 'Missing jobId' })

            const collection = await getJobsCollection(framer)
            const items = await collection.getItems()
            const item = items.find(i => i.id === jobId)
            if (!item) return res.status(404).json({ error: 'Item not found in Framer' })
            await item.delete()
            return res.json({ success: true })
        }

        return res.status(405).json({ error: 'Method not allowed' })

    } catch (err) {
        console.error('sync-to-framer error:', err)
        return res.status(500).json({ error: err.message })
    } finally {
        await framer.disconnect()
    }
}

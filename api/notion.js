export const config = {
    maxDuration: 60,
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const NOTION_API_KEY = process.env.NOTION_API_KEY;
    const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

    if (!NOTION_API_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not configured' });
    if (!NOTION_PARENT_PAGE_ID) return res.status(500).json({ error: 'NOTION_PARENT_PAGE_ID not configured' });

    const { title, meta, sections } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });

    const children = [];

    if (meta) {
        children.push({
            object: 'block', type: 'callout',
            callout: { icon: { type: 'emoji', emoji: '\uD83D\uDCCB' }, rich_text: [{ type: 'text', text: { content: meta } }] }
        });
        children.push({ object: 'block', type: 'divider', divider: {} });
    }

    for (const section of (sections || [])) {
        children.push({
            object: 'block', type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: section.heading } }] }
        });

        if (section.type === 'bullets') {
            for (const line of section.content.split('\n').map(l => l.trim()).filter(l => l)) {
                children.push({
                    object: 'block', type: 'bulleted_list_item',
                    bulleted_list_item: { rich_text: [{ type: 'text', text: { content: line } }] }
                });
            }
        } else {
            for (const para of section.content.split('\n').map(l => l.trim()).filter(l => l)) {
                children.push({
                    object: 'block', type: 'paragraph',
                    paragraph: { rich_text: [{ type: 'text', text: { content: para } }] }
                });
            }
        }
    }

    try {
        const response = await fetch('https://api.notion.com/v1/pages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28'
            },
            body: JSON.stringify({
                parent: { page_id: NOTION_PARENT_PAGE_ID },
                icon: { type: 'emoji', emoji: '\uD83D\uDCDD' },
                properties: { title: { title: [{ text: { content: title } }] } },
                children
            })
        });

        const data = await response.json();
        if (!response.ok) return res.status(response.status).json({ error: data.message || `Notion API error (${response.status})` });

        return res.json({ url: data.url, id: data.id });
    } catch (err) {
        console.error('Notion API error:', err);
        return res.status(500).json({ error: 'Failed to reach Notion API' });
    }
}

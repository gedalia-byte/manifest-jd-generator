const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID || '1ca9717da31f806d9fb4d69aa6d03a4a'; // HR and Hiring page

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint for Anthropic API
app.post('/api/format', async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const { system, userMessage, model } = req.body;
    if (!system || !userMessage) {
        return res.status(400).json({ error: 'Missing system or userMessage' });
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: model || 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system,
                messages: [{ role: 'user', content: userMessage }]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || `Anthropic API error (${response.status})`
            });
        }

        res.json({ text: data.content?.[0]?.text?.trim() || '' });
    } catch (err) {
        console.error('Anthropic API error:', err);
        res.status(500).json({ error: 'Failed to reach Anthropic API' });
    }
});

// Save job description to Notion
app.post('/api/notion', async (req, res) => {
    if (!NOTION_API_KEY) {
        return res.status(500).json({ error: 'NOTION_API_KEY not configured on server' });
    }

    const { title, meta, sections } = req.body;
    if (!title) {
        return res.status(400).json({ error: 'Missing title' });
    }

    // Build Notion block children from sections
    const children = [];

    // Meta line (callout block)
    if (meta) {
        children.push({
            object: 'block',
            type: 'callout',
            callout: {
                icon: { type: 'emoji', emoji: '\uD83D\uDCCB' },
                rich_text: [{ type: 'text', text: { content: meta } }]
            }
        });
        children.push({ object: 'block', type: 'divider', divider: {} });
    }

    for (const section of sections) {
        // Section heading
        children.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: section.heading } }]
            }
        });

        if (section.type === 'bullets') {
            const lines = section.content.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                children.push({
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: [{ type: 'text', text: { content: line } }]
                    }
                });
            }
        } else {
            // Paragraphs
            const paras = section.content.split('\n').map(l => l.trim()).filter(l => l);
            for (const para of paras) {
                children.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: para } }]
                    }
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
                properties: {
                    title: {
                        title: [{ text: { content: title } }]
                    }
                },
                children
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Notion API error:', JSON.stringify(data, null, 2));
            return res.status(response.status).json({
                error: data.message || `Notion API error (${response.status})`
            });
        }

        res.json({ url: data.url, id: data.id });
    } catch (err) {
        console.error('Notion API error:', err);
        res.status(500).json({ error: 'Failed to reach Notion API' });
    }
});

app.listen(PORT, () => {
    console.log(`Manifest JD Generator running on port ${PORT}`);
    if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set — Smart Format disabled');
    if (!NOTION_API_KEY) console.warn('WARNING: NOTION_API_KEY not set — Notion export disabled');
});

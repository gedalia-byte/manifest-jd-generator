export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const { system, userMessage } = req.body;
    if (!system || !userMessage) return res.status(400).json({ error: 'Missing system or userMessage' });

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                system: system,
                messages: [{ role: 'user', content: userMessage }]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || `Claude API error (${response.status})`
            });
        }

        const text = data.content?.[0]?.text?.trim() || '';
        res.json({ text });
    } catch (err) {
        console.error('Claude API error:', err);
        res.status(500).json({ error: 'Failed to reach Claude API' });
    }
}

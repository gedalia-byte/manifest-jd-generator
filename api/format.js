export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const { system, userMessage } = req.body;
    if (!system || !userMessage) return res.status(400).json({ error: 'Missing system or userMessage' });

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: system }] },
                    contents: [{ parts: [{ text: userMessage }] }],
                    generationConfig: { maxOutputTokens: 1024 }
                })
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({
                error: data.error?.message || `Gemini API error (${response.status})`
            });
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        res.json({ text });
    } catch (err) {
        console.error('Gemini API error:', err);
        res.status(500).json({ error: 'Failed to reach Gemini API' });
    }
}

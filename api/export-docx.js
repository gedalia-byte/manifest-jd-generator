import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle, TabStopPosition, TabStopType } from 'docx';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { title, meta, sections } = req.body;
    if (!title) return res.status(400).json({ error: 'Missing title' });

    const children = [];

    // Title
    children.push(new Paragraph({
        children: [new TextRun({ text: title, bold: true, size: 48, font: 'Calibri', color: '2A2826' })],
        spacing: { after: 80 },
    }));

    // Meta line
    if (meta) {
        children.push(new Paragraph({
            children: [new TextRun({ text: meta, size: 22, font: 'Calibri', color: '7A746C' })],
            spacing: { after: 300 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DCD6CD', space: 12 } },
        }));
    }

    // Sections
    for (const section of (sections || [])) {
        // Section heading
        children.push(new Paragraph({
            children: [new TextRun({ text: section.heading.toUpperCase(), bold: true, size: 22, font: 'Calibri', color: '2A2826',
                allCaps: true, characterSpacing: 40 })],
            spacing: { before: 360, after: 120 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DCD6CD', space: 6 } },
        }));

        if (section.type === 'bullets') {
            const lines = section.content.split('\n').map(l => l.trim()).filter(l => l);
            for (const line of lines) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: line, size: 22, font: 'Calibri', color: '4A4540' })],
                    bullet: { level: 0 },
                    spacing: { after: 60 },
                }));
            }
        } else {
            const paras = section.content.split('\n').map(l => l.trim()).filter(l => l);
            for (const para of paras) {
                children.push(new Paragraph({
                    children: [new TextRun({ text: para, size: 22, font: 'Calibri', color: '4A4540' })],
                    spacing: { after: 120 },
                }));
            }
        }
    }

    try {
        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        margin: { top: 1200, right: 1200, bottom: 1200, left: 1200 },
                    },
                },
                children,
            }],
        });

        const buffer = await Packer.toBuffer(doc);

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${slug}.docx"`);
        res.send(Buffer.from(buffer));
    } catch (err) {
        console.error('DOCX export error:', err);
        res.status(500).json({ error: 'Failed to generate document' });
    }
}

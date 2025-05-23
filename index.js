import express from 'express';
import fetch from 'node-fetch';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import dayjs from 'dayjs';

const app = express();
app.use(express.json({ limit: '25mb' }));

// Optional: API key check (set API_KEY_SECRET in Render env vars)
app.use((req, res, next) => {
  const incomingKey = req.headers['x-api-key'];
  if (process.env.API_KEY_SECRET && incomingKey !== process.env.API_KEY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

app.post('/tag', async (req, res) => {
  try {
    const { pdf_url, underwriter_name, lender_name } = req.body;
    if (!pdf_url || !underwriter_name || !lender_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const timestamp = dayjs().format('YYYY-MM-DD HH:mm:ss');
    const qrText = `Underwriter: ${underwriter_name}\nLender: ${lender_name}\nDate: ${timestamp}`;

    const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0 });
    const qrImageBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');

    const pdfBytes = await fetch(pdf_url).then(res => res.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const qrImage = await pdfDoc.embedPng(qrImageBytes);

    const pages = pdfDoc.getPages();
    for (const page of pages) {
      page.drawImage(qrImage, {
        x: page.getWidth() - 100,
        y: 20,
        width: 80,
        height: 80,
        opacity: 0.01,
      });
    }

    const modifiedPdf = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=\"watermarked.pdf\"');
    res.send(Buffer.from(modifiedPdf));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process PDF' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Aquamark Lenders running on port ${PORT}`));

const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const { PDFDocument } = require("pdf-lib");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");
const QRCode = require("qrcode");
const axios = require("axios");
require("dotenv").config();

const app = express();
const port = process.env.PORT;
const TABLE_NAME = "lenders";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
app.use(cors());
app.use(fileUpload());

// === Rate limit tracking for test key ===
let testKeyUsage = [];
const MAX_TEST_CALLS_PER_HOUR = 100;

app.post("/watermark", async (req, res) => {
  const apiKey = req.headers.authorization?.split(" ")[1];
  const validKeys = [process.env.AQUAMARK_API_KEY, process.env.AQUAMARK_TEST_KEY];

  if (!validKeys.includes(apiKey)) {
    return res.status(403).send("Unauthorized");
  }

  const isTestKey = apiKey === process.env.AQUAMARK_TEST_KEY;
  if (isTestKey) {
    const now = Date.now();
    testKeyUsage = testKeyUsage.filter(ts => now - ts < 60 * 60 * 1000);

    if (testKeyUsage.length >= MAX_TEST_CALLS_PER_HOUR) {
      return res.status(429).send("Test key rate limit reached (100 per hour). Please try again later.");
    }

    testKeyUsage.push(now);
  }

  const { user_email, company = "unknown", name = "unknown" } = req.body;
  const file = req.files?.file;
  if (!user_email || !file) return res.status(400).send("Missing file or user_email");

  let pdfBytes = file.data;
  try {
    await PDFDocument.load(pdfBytes, { ignoreEncryption: false });
  } catch {
    fs.writeFileSync("input.pdf", pdfBytes);
    await new Promise((resolve) => {
      exec(`qpdf --decrypt input.pdf decrypted.pdf`, (err) => {
        if (!err) pdfBytes = fs.readFileSync("decrypted.pdf");
        resolve();
      });
    });
    fs.unlinkSync("input.pdf");
    if (fs.existsSync("decrypted.pdf")) fs.unlinkSync("decrypted.pdf");
  }

  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  const logoPath = `${user_email}.png`;
  const { data: logoData } = supabase.storage.from("lenders").getPublicUrl(logoPath);
  if (!logoData?.publicUrl) return res.status(404).send("Logo URL fetch failed");

  const logoUrl = `${logoData.publicUrl}?t=${Date.now()}`;
  const logoRes = await fetch(logoUrl);
  if (!logoRes.ok) return res.status(404).send("Logo fetch failed");

  const logoBytes = await logoRes.arrayBuffer();

  const today = new Date().toISOString().split("T")[0];
  const payload = encodeURIComponent(`ProtectedByAquamark|${company}|${name}|${today}`);
  const qrText = `https://aquamark.io/q.html?data=${payload}`;
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
  const qrImageRes = await axios.get(qrDataUrl, { responseType: "arraybuffer" });
  const qrBytes = qrImageRes.data;

  const overlayDoc = await PDFDocument.create();
  const [overlayPage] = [overlayDoc.addPage([pdfDoc.getPage(0).getWidth(), pdfDoc.getPage(0).getHeight()])];

  const embeddedLogo = await overlayDoc.embedPng(logoBytes);
  const embeddedQR = await overlayDoc.embedPng(qrBytes);
  const { width, height } = overlayPage.getSize();

  // === UPDATED LOGO PLACEMENT AND SIZE ===
  const maxLogoWidth = 400;
  const maxLogoHeight = 200;
  const originalWidth = embeddedLogo.width;
  const originalHeight = embeddedLogo.height;

  let targetWidth = maxLogoWidth;
  let targetHeight = (originalHeight / originalWidth) * targetWidth;
  if (targetHeight > maxLogoHeight) {
    targetHeight = maxLogoHeight;
    targetWidth = (originalWidth / originalHeight) * targetHeight;
  }

  const logoX = (width - targetWidth) / 2;
  const logoY = height - targetHeight - 20;

  overlayPage.drawImage(embeddedLogo, {
    x: logoX,
    y: logoY,
    width: targetWidth,
    height: targetHeight,
    opacity: 0.9,
  });

  const qrSize = 30;
  const padding = 10;
  const qrX = width - padding - qrSize;
  const qrY = height - padding - qrSize;

  overlayPage.drawImage(embeddedQR, {
    x: qrX,
    y: qrY,
    width: qrSize,
    height: qrSize,
    opacity: 0.4,
  });

  const overlayBytes = await overlayDoc.save();
  const overlayLoaded = await PDFDocument.load(overlayBytes);
  const [overlayXObject] = await pdfDoc.embedPages([overlayLoaded.getPage(0)]);

  pdfDoc.getPages().forEach((page) => {
    page.drawPage(overlayXObject, { x: 0, y: 0, width, height });
  });

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const numPages = pdfDoc.getPageCount();

  const { data: existingRow } = await supabase
    .from(TABLE_NAME)
    .select("*")
    .eq("user_email", user_email)
    .eq("year", year)
    .eq("month", month)
    .single();

  if (existingRow) {
    await supabase
      .from(TABLE_NAME)
      .update({
        files_used: (existingRow.files_used || 0) + 1,
        pages_used: (existingRow.pages_used || 0) + numPages,
      })
      .eq("id", existingRow.id);
  } else {
    await supabase.from(TABLE_NAME).insert({
      user_email,
      company_name: company,
      contact_name: name,
      year,
      month,
      files_used: 1,
      pages_used: numPages,
    });
  }

  const finalPdf = await pdfDoc.save();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${file.name.replace(/\.pdf$/i, "")}-protected.pdf"`);
  res.send(Buffer.from(finalPdf));
});

app.listen(port, () => {
  console.log(`✅ Aquamark Lender API running on port ${port}`);
});

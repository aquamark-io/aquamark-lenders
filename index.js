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

app.post("/watermark", async (req, res) => {
  const apiKey = req.headers.authorization?.split(" ")[1];
  if (apiKey !== process.env.AQUAMARK_API_KEY) return res.status(403).send("Unauthorized");

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

  // Fetch logo with cache busting
const logoPath = `${user_email}.png`;
const { data: logoData } = supabase.storage.from("lenders").getPublicUrl(logoPath);
if (!logoData?.publicUrl) return res.status(404).send("Logo URL fetch failed");

const logoUrl = `${logoData.publicUrl}?t=${Date.now()}`;
const logoRes = await fetch(logoUrl);
if (!logoRes.ok) return res.status(404).send("Logo fetch failed");

const logoBytes = await logoRes.arrayBuffer();
const logoImage = await pdfDoc.embedPng(logoBytes);


  // Generate QR code
  const today = new Date().toISOString().split("T")[0];
  const payload = encodeURIComponent(`ProtectedByAquamark|${company}|${name}|${today}`);
  const qrText = `https://aquamark.io/q.html?data=${payload}`;
  const qrDataUrl = await QRCode.toDataURL(qrText, { margin: 0, scale: 5 });
  const qrImageRes = await axios.get(qrDataUrl, { responseType: "arraybuffer" });
  const qrImage = await pdfDoc.embedPng(qrImageRes.data);

  // Placement on each page
  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    // Normalize logo into fixed bounding box
    const maxLogoWidth = 200;
    const maxLogoHeight = 100;

    const originalWidth = logoImage.width;
    const originalHeight = logoImage.height;

    let targetWidth = maxLogoWidth;
    let targetHeight = (originalHeight / originalWidth) * targetWidth;

    if (targetHeight > maxLogoHeight) {
      targetHeight = maxLogoHeight;
      targetWidth = (originalWidth / originalHeight) * targetHeight;
    }

    const qrSize = 40;
    const padding = 20;

    const qrX = width - padding - qrSize;
const qrY = height - padding - qrSize;

    const logoX = qrX - targetWidth - 20; // space between logo and QR
    const logoY = height - padding - targetHeight + 10;

    page.drawImage(logoImage, {
      x: logoX,
      y: logoY,
      width: targetWidth,
      height: targetHeight,
      opacity: 0.4
    });

    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
      opacity: 0.4
    });
  }

  // Usage tracking
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

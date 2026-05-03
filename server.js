require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");
const multer = require("multer");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const mammoth = require("mammoth");
const PDFDocument = require("pdfkit");
const { Document, Packer, Paragraph, TextRun } = require("docx");
const path = require("path");

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/improve", async (req, res) => {
  const { cv = "", job_title = "", job_description = "", options = {}, include_fun_fact = false } = req.body;

  if (!cv.trim()) return res.status(400).json({ error: "CV text is required" });

  const improveParts = [];
  if (options.phrasing)     improveParts.push("- Improve wording and phrasing to sound more professional and impactful");
  if (options.ats)          improveParts.push("- Optimize for ATS: use standard section headers, include relevant keywords, avoid tables/graphics in text");
  if (options.buzzwords)    improveParts.push(`- Add relevant industry buzzwords and power verbs appropriate for: ${job_title || "the target role"}`);
  if (options.achievements) improveParts.push("- Reframe duties as achievements with quantifiable impact where possible (e.g. 'Managed team' → 'Led team of 8, reducing delivery time by 30%')");

  if (!improveParts.length) improveParts.push("- Improve overall quality, phrasing, and ATS compatibility");

  const jobContext = [
    job_title       ? `Target Job Title: ${job_title}` : "",
    job_description ? `Job Description:\n${job_description}` : "",
  ].filter(Boolean).join("\n");

  const funFactInstruction = include_fun_fact
    ? `\nAfter the improved CV, add a section titled "=== INTERESTING FACT ===" and write one genuinely interesting, memorable fact about the candidate based on their CV — something that would make an interviewer curious. Make it human, warm, and specific.`
    : "";

  const prompt = `You are an expert CV/resume consultant and HR specialist.
${jobContext}

Improve the following CV according to these instructions:
${improveParts.join("\n")}

Important rules:
- Keep all factual information accurate — do not invent experience or credentials
- Maintain the same structure and sections unless ATS optimization requires renaming headers
- Return ONLY the improved CV text (and the interesting fact section if requested), no commentary
- Use clear section headers in ALL CAPS or with standard formatting
${funFactInstruction}

CV TO IMPROVE:
${cv}`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

app.post("/analyze", async (req, res) => {
  const { cv = "", job_title = "" } = req.body;
  if (!cv.trim()) return res.status(400).json({ error: "CV text is required" });

  const prompt = `You are an ATS and HR expert. Analyze this CV${job_title ? ` for the role: ${job_title}` : ""}.

Return ONLY valid JSON in this exact format:
{
  "ats_score": <number 0-100>,
  "top_issues": ["issue 1", "issue 2", "issue 3"],
  "strengths": ["strength 1", "strength 2"]
}

CV:
${cv.slice(0, 3000)}`;

  try {
    const msg = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.choices[0].message.content;
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/parse-cv", upload.single("cv"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { mimetype, buffer, originalname } = req.file;
  const name = originalname.toLowerCase();
  try {
    let text = "";
    if (mimetype === "application/pdf" || name.endsWith(".pdf")) {
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (name.endsWith(".docx") || mimetype.includes("wordprocessingml")) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: "Please upload a PDF or DOCX file" });
    }
    res.json({ text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function fetchUrl(url, depth = 0) {
  if (depth > 3) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? require("https") : require("http");
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    };
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => done(() => reject(new Error("Timeout — the site took too long to respond"))), 14000);

    const req = lib.get(url, { headers }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.destroy();
        const next = resp.headers.location.startsWith("http") ? resp.headers.location : new URL(resp.headers.location, url).href;
        return done(() => resolve(fetchUrl(next, depth + 1)));
      }
      if (resp.statusCode === 999 || resp.statusCode === 403) {
        resp.destroy();
        return done(() => reject(new Error(`Site blocked the request (HTTP ${resp.statusCode}) — paste the description manually`)));
      }
      let data = "", bytes = 0;
      resp.setEncoding("utf8");
      resp.on("data", chunk => {
        data += chunk;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 400 * 1024) { resp.destroy(); done(() => resolve(data)); }
      });
      resp.on("end", () => done(() => resolve(data)));
      resp.on("error", (e) => done(() => reject(e)));
    });
    req.on("error", (e) => done(() => reject(e)));
  });
}

app.post("/fetch-job", async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Valid URL required" });
  try {
    const html = await fetchUrl(url);
    const raw = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#\d+;/g, "")
      .replace(/\s{3,}/g, "\n\n")
      .trim()
      .slice(0, 12000);

    const msg = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: `Extract the job posting from this page text. Return ONLY valid JSON with two fields:
{"title": "<job title>", "description": "<full job description including requirements and responsibilities>"}

If you cannot find a job posting, return {"title": "", "description": ""}.

Page text:
${raw}`
      }]
    });

    const json = JSON.parse(msg.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/parse-job-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: "Unsupported image type" });
  try {
    const base64 = req.file.buffer.toString("base64");
    const msg = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${req.file.mimetype};base64,${base64}` } },
          { type: "text", text: "Extract the complete job title and job description from this screenshot. Return only the text, no commentary." }
        ]
      }]
    });
    res.json({ text: msg.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function buildPDF(text) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 55, size: "A4" });
    const chunks = [];
    doc.on("data", c => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) { doc.moveDown(0.3); continue; }
      const isHeader = t === t.toUpperCase() && t.length > 2 && /[A-Z]/.test(t);
      const isBullet = t.startsWith("- ") || t.startsWith("• ");
      if (isHeader) {
        doc.moveDown(0.4).fontSize(12).font("Helvetica-Bold").text(t).moveDown(0.15);
      } else if (isBullet) {
        doc.fontSize(10).font("Helvetica").text(t, { indent: 12 });
      } else {
        doc.fontSize(10).font("Helvetica").text(t);
      }
    }
    doc.end();
  });
}

function buildDOCX(text) {
  const children = text.split("\n").map(line => {
    const t = line.trim();
    const isHeader = t && t === t.toUpperCase() && t.length > 2 && /[A-Z]/.test(t);
    return new Paragraph({
      spacing: { before: isHeader ? 200 : 0, after: 60 },
      children: [new TextRun({ text: t, bold: isHeader, size: isHeader ? 24 : 20, font: "Calibri" })]
    });
  });
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

app.post("/download", async (req, res) => {
  const { text, format } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  try {
    if (format === "pdf") {
      const buf = await buildPDF(text);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=\"improved-cv.pdf\"");
      res.send(buf);
    } else if (format === "docx") {
      const buf = await buildDOCX(text);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", "attachment; filename=\"improved-cv.docx\"");
      res.send(buf);
    } else {
      res.status(400).json({ error: "format must be pdf or docx" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CV Improver running at http://localhost:${PORT}`));

'use strict';
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { convertReport, KNOWN_SECTIONS } = require('./src/converter');

const PORT = Number(process.env.PORT) || 4000;
const WORK = path.join(os.tmpdir(), 'jmeter-report-pdf');
fs.mkdirSync(WORK, { recursive: true });

const app = express();
const upload = multer({
  dest: path.join(WORK, '_incoming'),
  preservePath: true, // keep folder structure sent by the browser
  limits: { fileSize: 1024 * 1024 * 1024, files: 20000, fieldSize: 10 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/sections', (_req, res) => res.json(KNOWN_SECTIONS.map(({ key, title }) => ({ key, title }))));

/** Resolve a client-supplied relative path safely inside base (no ../ escapes). */
function safeJoin(base, rel) {
  const clean = String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  if (!clean) return null;
  const full = path.resolve(base, clean);
  return full.startsWith(path.resolve(base) + path.sep) ? full : null;
}

function extractZip(zipFile, dest) {
  const zip = new AdmZip(zipFile);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const target = safeJoin(dest, entry.entryName);
    if (!target) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

// One conversion at a time keeps memory use predictable.
let queue = Promise.resolve();
const enqueue = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

app.post('/api/convert', upload.array('files'), async (req, res) => {
  const jobId = crypto.randomBytes(6).toString('hex');
  const jobDir = path.join(WORK, jobId);
  const files = req.files || [];
  const started = Date.now();
  try {
    if (!files.length) return res.status(400).json({ error: 'No files received. Select the JMeter report folder (or a .zip of it).' });
    fs.mkdirSync(jobDir, { recursive: true });
    let paths = [];
    try { paths = JSON.parse(req.body.paths || '[]'); } catch { paths = []; }

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rel = paths[i] || f.originalname;
      if (files.length === 1 && /\.zip$/i.test(rel)) {
        extractZip(f.path, jobDir);
        continue;
      }
      const target = safeJoin(jobDir, rel);
      if (!target) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(f.path, target);
    }

    const sections = String(req.body.sections || '').split(',').map((s) => s.trim()).filter(Boolean);
    const log = (m) => console.log(`[${jobId}] ${m}`);
    log(`received ${files.length} file(s)`);
    const result = await enqueue(() => convertReport(jobDir, {
      title: req.body.title,
      format: req.body.format,
      landscape: req.body.orientation !== 'portrait',
      sections,
      cover: req.body.cover !== 'false',
      hideOverview: req.body.hideOverview !== 'false',
      log,
    }));

    const base = (result.title || 'JMeter_Report').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'JMeter_Report';
    const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${base}_${stamp}.pdf"`,
      'X-Pdf-Pages': String(result.pages),
      'X-Elapsed-Ms': String(Date.now() - started),
      'Access-Control-Expose-Headers': 'Content-Disposition, X-Pdf-Pages, X-Elapsed-Ms',
    });
    res.send(result.pdf);
  } catch (err) {
    console.error(`[${jobId}] failed:`, err);
    res.status(422).json({ error: err.message || String(err) });
  } finally {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Upload failed' });
});

app.listen(PORT, () => {
  console.log(`\n  JMeter Report -> PDF is running:  http://localhost:${PORT}\n`);
});

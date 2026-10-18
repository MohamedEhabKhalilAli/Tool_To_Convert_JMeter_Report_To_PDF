'use strict';
/**
 * JMeter HTML Dashboard -> PDF converter.
 *
 * Opens every page of a JMeter HTML report in headless Chrome, expands all
 * (lazy-loaded) graph panels, hides navigation chrome, prints each page to PDF,
 * then merges everything behind a cover page (summary + table of contents)
 * and stamps page numbers.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Known JMeter dashboard pages, in report order.
const KNOWN_SECTIONS = [
  { key: 'dashboard', title: 'Dashboard', file: 'index.html' },
  { key: 'overtime', title: 'Charts - Over Time', file: 'content/pages/OverTime.html' },
  { key: 'throughput', title: 'Charts - Throughput', file: 'content/pages/Throughput.html' },
  { key: 'responsetimes', title: 'Charts - Response Times', file: 'content/pages/ResponseTimes.html' },
  { key: 'custom', title: 'Custom Graphs', file: 'content/pages/CustomsGraphs.html' },
];

const PAPER_MM = { A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };
const MARGIN_MM = { top: 10, right: 10, bottom: 14, left: 10 };
const PX_PER_MM = 96 / 25.4;

/** Find the folder that holds the report's index.html (next to a "content" folder). */
function findReportRoot(dir) {
  const candidates = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const names = entries.map((e) => e.name);
    if (names.includes('index.html') && names.includes('content')) candidates.push({ d, depth });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'sbadmin2-1.0.7') {
        walk(path.join(d, e.name), depth + 1);
      }
    }
  };
  walk(dir, 0);
  if (!candidates.length) {
    throw new Error('No JMeter HTML report found. The folder must contain index.html and a "content" folder (the output of "jmeter -g results.jtl -o report").');
  }
  candidates.sort((a, b) => a.depth - b.depth);
  return candidates[0].d;
}

function listSections(root) {
  const sections = KNOWN_SECTIONS.filter((s) => fs.existsSync(path.join(root, s.file)));
  // Any extra pages a custom template might add
  const pagesDir = path.join(root, 'content', 'pages');
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir).filter((n) => n.toLowerCase().endsWith('.html')).sort()) {
      const rel = `content/pages/${f}`;
      if (!sections.some((s) => s.file === rel)) {
        sections.push({ key: f.replace(/\.html$/i, '').toLowerCase(), title: f.replace(/\.html$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2'), file: rel });
      }
    }
  }
  return sections;
}

async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--disable-web-security'];
  const tried = [];
  const exe = process.env.CHROME_PATH;
  if (exe) return puppeteer.launch({ headless: true, executablePath: exe, args });
  try {
    return await puppeteer.launch({ headless: true, args });
  } catch (e) {
    tried.push(e.message.split('\n')[0]);
  }
  // Fallback: a locally installed Chrome / Edge (useful when the bundled browser download was blocked)
  const fallbacks = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of fallbacks) {
    if (p && fs.existsSync(p)) return puppeteer.launch({ headless: true, executablePath: p, args });
  }
  throw new Error(`Could not start Chrome. Run "npx puppeteer browsers install chrome" or set CHROME_PATH to chrome.exe / msedge.exe. (${tried.join('; ')})`);
}

const PRINT_CSS = (hideOverview) => `
  nav.navbar, .navbar-static-top, .sidebar, #side-menu, .modal, .modal-backdrop { display: none !important; }
  html, body { background: #fff !important; }
  #wrapper { padding: 0 !important; width: 100% !important; }
  #page-wrapper { margin: 0 !important; border: 0 !important; padding: 0 6px !important; min-height: 0 !important; }
  a[href]:after { content: none !important; }
  .collapse { display: block !important; height: auto !important; visibility: visible !important; }
  .panel { box-shadow: none !important; }
  .panel:has(.flot-chart), .panel:has(#generalInfos) { break-inside: avoid; page-break-inside: avoid; }
  .panel-heading .pull-right, .panel-heading .btn, .panel-heading .fa-chevron-up, .panel-heading .fa-chevron-down { display: none !important; }
  table { page-break-inside: auto; }
  tr, td, th { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  .tablesorter-header { background-image: none !important; }
  .jm2pdf-section { font: 600 20px/1.3 "Segoe UI", Arial, sans-serif; color: #1f3a5f; border-bottom: 3px solid #c0392b;
                    padding: 4px 2px 6px; margin: 0 0 12px; }
  #page-wrapper .flot-chart { height: 320px !important; }
  #page-wrapper .col-lg-6 { width: 100% !important; float: none !important; }
  .panel-footer { padding: 4px 10px !important; }
  .col-lg-12.portlet { margin-bottom: 0 !important; }
  .panel { margin-bottom: 12px !important; }
  ${hideOverview ? `[id^="overview"] { display: none !important; }
  .flot-chart > div:not(.flot-chart-content) { display: none !important; }
  .flot-chart > .flot-chart-content { width: 100% !important; }` : ''}
`;

/** Runs inside the report page: expand every panel so lazy charts get drawn. */
function expandAllPanels() {
  const els = Array.from(document.querySelectorAll('.collapse')).filter(
    (el) => !el.closest('nav') && !el.classList.contains('navbar-collapse')
  );
  for (const el of els) {
    el.classList.add('in');
    el.style.height = 'auto';
    if (typeof window.collapse === 'function') {
      try { window.collapse(el, false); } catch (e) { /* ignore single graph failures */ }
    }
  }
  // Redraw charts drawn before our print CSS changed their size
  if (window.jQuery) {
    window.jQuery('.flot-chart-content').each(function () {
      const plot = window.jQuery(this).data('plot');
      if (plot) { try { plot.resize(); plot.setupGrid(); plot.draw(); } catch (e) { /* ignore */ } }
    });
  }
  if (location.hash) history.replaceState(null, '', location.pathname);
  window.scrollTo(0, 0);
  return els.length;
}

/** Runs inside the page: true once every visible chart container has been drawn. */
function chartsReady() {
  const boxes = Array.from(document.querySelectorAll('.flot-chart-content')).filter(
    (el) => el.offsetParent !== null && !el.closest('.modal')
  );
  return boxes.every((el) => el.querySelector('canvas') || el.textContent.trim().length > 0 ||
    (el.closest('.panel-body') && /no data|empty/i.test(el.closest('.panel-body').textContent)));
}

async function renderSection(browser, root, section, opt, log) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => log(`  [page script warning] ${section.title}: ${String(err.message || err).slice(0, 160)}`));
  try {
    await page.setViewport({ width: opt.layoutWidth, height: 1200, deviceScaleFactor: 2 });
    await page.emulateMediaType('screen');
    const url = pathToFileURL(path.join(root, section.file)).href;
    await page.goto(url, { waitUntil: 'load', timeout: opt.timeoutMs });
    await page.addStyleTag({ content: PRINT_CSS(opt.hideOverview) });
    await page.evaluate(expandAllPanels);
    await page.evaluate((title, isDashboard) => {
      // Test info block is repeated on every chart page - keep it only on the dashboard
      if (!isDashboard) {
        const gi = document.querySelector('#generalInfos');
        const box = gi && gi.closest('.panel');
        if (box) box.remove();
      }
      const host = document.querySelector('#page-wrapper') || document.body;
      const h = document.createElement('div');
      h.className = 'jm2pdf-section';
      h.textContent = title;
      host.insertBefore(h, host.firstChild);
    }, section.title, section.key === 'dashboard');
    try {
      await page.waitForFunction(chartsReady, { timeout: Math.min(opt.timeoutMs, 30000), polling: 250 });
    } catch { log(`  [warn] some charts in "${section.title}" did not finish drawing in time`); }
    await new Promise((r) => setTimeout(r, 700));

    const info = await page.evaluate(() => ({
      charts: document.querySelectorAll('canvas.flot-base').length,
      panels: document.querySelectorAll('#page-wrapper .panel').length,
    }));
    if (section.key !== 'dashboard' && info.charts === 0) {
      return { skipped: true, reason: 'no charts' };
    }
    const pdf = await page.pdf({
      format: opt.format,
      landscape: opt.landscape,
      printBackground: true,
      scale: opt.scale,
      margin: { top: `${MARGIN_MM.top}mm`, right: `${MARGIN_MM.right}mm`, bottom: `${MARGIN_MM.bottom}mm`, left: `${MARGIN_MM.left}mm` },
    });
    let meta = null;
    if (section.key === 'dashboard') meta = await page.evaluate(extractDashboardMeta);
    return { pdf: Buffer.from(pdf), meta, charts: info.charts };
  } finally {
    await page.close();
  }
}

/** Runs inside index.html: pull test info + key totals for the cover page. */
function extractDashboardMeta() {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim().replace(/^"(.*)"$/, '$1') : '');
  const info = [];
  document.querySelectorAll('#generalInfos tr').forEach((tr) => {
    const td = tr.querySelectorAll('td');
    if (td.length >= 2) info.push([txt(td[0]), txt(td[1])]);
  });
  const readTotal = (sel) => {
    const table = document.querySelector(sel);
    if (!table) return null;
    const heads = Array.from(table.querySelectorAll('thead tr:last-child th')).map(txt);
    const row = table.querySelector('tbody.tablesorter-no-sort tr') ||
      Array.from(table.querySelectorAll('tbody tr')).find((r) => /total/i.test(txt(r.cells[0])));
    if (!row) return null;
    return heads.map((h, i) => [h, txt(row.cells[i])]);
  };
  const statsRows = document.querySelectorAll('#statisticsTable tbody:not(.tablesorter-no-sort) tr').length;
  const errorRows = document.querySelectorAll('#errorsTable tbody:not(.tablesorter-no-sort) tr').length;
  return { info, stats: readTotal('#statisticsTable'), apdex: readTotal('#apdexTable'), statsRows, errorRows, pageTitle: document.title };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function coverHtml(title, meta, toc, generatedAt) {
  const stats = (meta && meta.stats) || [];
  const pick = (re) => { const f = stats.find(([h]) => re.test(h)); return f ? f[1] : null; };
  const apdex = meta && meta.apdex ? (meta.apdex.find(([h]) => /^apdex$/i.test(h)) || [])[1] : null;
  const kpis = [
    ['Samples', pick(/^#?samples$/i)],
    ['Error %', pick(/error\s*%/i)],
    ['Average (ms)', pick(/^average/i)],
    ['90th pct (ms)', pick(/90/)],
    ['95th pct (ms)', pick(/95/)],
    ['Throughput (/s)', pick(/transactions|throughput/i)],
    ['APDEX', apdex],
  ].filter(([, v]) => v);
  const infoRows = ((meta && meta.info) || []).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const tocRows = toc.map((t) => `<tr><td>${esc(t.title)}</td><td class="dots"></td><td class="pg">${t.page}</td></tr>`).join('');
  const errPct = parseFloat(pick(/error\s*%/i));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: #1d2733; }
    .band { background: #1f3a5f; color: #fff; padding: 34px 40px 28px; border-bottom: 6px solid #c0392b; }
    .band small { letter-spacing: .14em; text-transform: uppercase; opacity: .75; font-size: 12px; }
    .band h1 { margin: 8px 0 4px; font-size: 32px; font-weight: 600; }
    .band p { margin: 0; opacity: .8; font-size: 13px; }
    .wrap { padding: 26px 40px; }
    h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #1f3a5f; margin: 0 0 10px; }
    .kpis { display: grid; grid-template-columns: repeat(${Math.max(kpis.length, 1)}, 1fr); gap: 10px; margin-bottom: 26px; }
    .kpi { border: 1px solid #d9dfe7; border-radius: 6px; padding: 12px 14px; }
    .kpi b { display: block; font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .kpi span { font-size: 11px; color: #5b6878; text-transform: uppercase; letter-spacing: .05em; }
    .kpi.bad b { color: #c0392b; } .kpi.good b { color: #1e8449; }
    .cols { display: grid; grid-template-columns: 1.2fr 1fr; gap: 34px; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    .info th { text-align: left; width: 38%; color: #5b6878; font-weight: 500; }
    .info th, .info td { padding: 7px 8px; border-bottom: 1px solid #e6e9ee; vertical-align: top; word-break: break-word; }
    .toc td { padding: 7px 0; }
    .toc .dots { border-bottom: 1px dotted #9aa5b1; width: 100%; }
    .toc .pg { text-align: right; padding-left: 8px; font-variant-numeric: tabular-nums; }
    .toc td:first-child { white-space: nowrap; padding-right: 8px; }
  </style></head><body>
    <div class="band"><small>Performance Test Report</small><h1>${esc(title)}</h1><p>Generated ${esc(generatedAt)} from the Apache JMeter HTML dashboard</p></div>
    <div class="wrap">
      ${kpis.length ? `<h2>Overall results</h2><div class="kpis">${kpis.map(([k, v]) => {
        const cls = k === 'Error %' ? (errPct > 1 ? 'bad' : 'good') : '';
        return `<div class="kpi ${cls}"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
      }).join('')}</div>` : ''}
      <div class="cols">
        <div><h2>Test information</h2><table class="info">${infoRows || '<tr><td>No test information found in report</td></tr>'}
          ${meta ? `<tr><th>Samplers / transactions</th><td>${meta.statsRows}</td></tr><tr><th>Error types</th><td>${meta.errorRows}</td></tr>` : ''}</table></div>
        <div><h2>Contents</h2><table class="toc">${tocRows}</table></div>
      </div>
    </div></body></html>`;
}

/**
 * Convert a JMeter HTML report folder to a PDF.
 * @param {string} reportDir folder containing (somewhere inside) index.html + content/
 * @param {object} options { title, format, landscape, sections:[keys], cover, hideOverview, scale, log }
 * @returns {Promise<{pdf: Buffer, pages: number, sections: object[]}>}
 */
async function convertReport(reportDir, options = {}) {
  const log = options.log || (() => {});
  const format = PAPER_MM[options.format] ? options.format : 'A4';
  const landscape = options.landscape !== false;
  const scale = Math.min(Math.max(Number(options.scale) || 0.72, 0.4), 1);
  const [w, h] = PAPER_MM[format];
  const paperWidthMm = landscape ? h : w;
  const printableWidthPx = (paperWidthMm - MARGIN_MM.left - MARGIN_MM.right) * PX_PER_MM;
  const opt = {
    format, landscape, scale,
    layoutWidth: Math.round(printableWidthPx / scale),
    hideOverview: options.hideOverview !== false,
    timeoutMs: Number(options.timeoutMs) || 180000,
  };

  const root = findReportRoot(reportDir);
  let sections = listSections(root);
  if (Array.isArray(options.sections) && options.sections.length) {
    sections = sections.filter((s) => options.sections.includes(s.key));
  }
  if (!sections.length) throw new Error('None of the selected report pages exist in this report.');
  log(`Report root: ${root}`);

  const browser = await launchBrowser();
  const rendered = [];
  let meta = null;
  try {
    for (const s of sections) {
      log(`Rendering ${s.title} ...`);
      const r = await renderSection(browser, root, s, opt, log);
      if (r.skipped) { log(`  skipped (${r.reason})`); continue; }
      if (r.meta) meta = r.meta;
      rendered.push({ ...s, pdf: r.pdf });
    }
    if (!rendered.length) throw new Error('Nothing could be rendered from this report.');

    const title = (options.title || '').trim() ||
      (meta && meta.pageTitle && meta.pageTitle !== 'Apache JMeter Dashboard' ? meta.pageTitle : 'JMeter Performance Test Report');
    const generatedAt = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

    // Merge
    const out = await PDFDocument.create();
    const docs = await Promise.all(rendered.map((r) => PDFDocument.load(r.pdf)));
    const withCover = options.cover !== false;
    let pageNo = withCover ? 2 : 1;
    const toc = rendered.map((r, i) => { const t = { title: r.title, page: pageNo }; pageNo += docs[i].getPageCount(); return t; });

    if (withCover) {
      const p = await browser.newPage();
      await p.setContent(coverHtml(title, meta, toc, generatedAt), { waitUntil: 'load' });
      const coverPdf = await p.pdf({ format, landscape, printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      await p.close();
      const cover = await PDFDocument.load(coverPdf);
      const [first] = await out.copyPages(cover, [0]);
      out.addPage(first);
    }
    for (const d of docs) {
      const pages = await out.copyPages(d, d.getPageIndices());
      pages.forEach((pg) => out.addPage(pg));
    }

    // Footer: title + page x of y
    const font = await out.embedFont(StandardFonts.Helvetica);
    const total = out.getPageCount();
    const safeTitle = title.replace(/[^\x20-\x7E]/g, '');
    out.getPages().forEach((pg, i) => {
      if (withCover && i === 0) return;
      const { width } = pg.getSize();
      const y = 16;
      const right = `Page ${i + 1} of ${total}`;
      pg.drawLine({ start: { x: 28, y: y + 12 }, end: { x: width - 28, y: y + 12 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) });
      pg.drawText(safeTitle.slice(0, 90), { x: 28, y, size: 8, font, color: rgb(0.36, 0.41, 0.47) });
      pg.drawText(right, { x: width - 28 - font.widthOfTextAtSize(right, 8), y, size: 8, font, color: rgb(0.36, 0.41, 0.47) });
    });
    out.setTitle(title);
    out.setProducer('JMeter Report to PDF');
    out.setCreator('JMeter Report to PDF');
    const pdf = Buffer.from(await out.save());
    log(`Done: ${total} pages`);
    return { pdf, pages: total, title, sections: toc };
  } finally {
    await browser.close();
  }
}

module.exports = { convertReport, findReportRoot, listSections, KNOWN_SECTIONS };

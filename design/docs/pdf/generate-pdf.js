#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// --- Paths ---
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MD_PATH = path.join(ROOT, 'design', 'docs', 'commissioning-guide.md');
const SCREENSHOTS_DIR = path.join(ROOT, 'design', 'docs', 'commissioning-screenshots');
const OUTPUT_PATH = path.join(__dirname, 'commissioning-guide.pdf');

// --- Colors (Stitch dark editorial) ---
const C = {
  bg: '#0c0e12',
  card: '#1b2029',
  gold: '#e9c349',
  teal: '#43aea4',
  text: '#e0e5f5',
  muted: '#a5abb9',
  error: '#ee7d77',
  codeBg: '#111319',
  tableBorder: '#2a2f3d',
  tableRowAlt: '#151920',
};

// --- Base64 image cache ---
const imageCache = {};

function loadImageBase64(relPath) {
  if (imageCache[relPath]) return imageCache[relPath];
  // relPath is relative to the markdown file location
  const absPath = path.resolve(path.dirname(MD_PATH), relPath);
  if (!fs.existsSync(absPath)) {
    console.warn('Warning: image not found:', absPath);
    return '';
  }
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext;
  const b64 = `data:${mime};base64,${buf.toString('base64')}`;
  imageCache[relPath] = b64;
  return b64;
}

// --- Markdown Parser ---

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFormat(text) {
  // Images: ![alt](path)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function(_, alt, src) {
    const b64 = loadImageBase64(src);
    if (!b64) return '<em>[Image not found: ' + escapeHtml(src) + ']</em>';
    return '<img src="' + b64 + '" alt="' + escapeHtml(alt) + '" class="screenshot" />';
  });
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bold+italic: ***text*** or ___text___
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text* (but not inside **)
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  return text;
}

function parseMarkdown(md) {
  const lines = md.split('\n');
  const sections = []; // Each section = { level, title, html, isCover }
  let currentSection = null;
  let i = 0;

  function ensureSection() {
    if (!currentSection) {
      currentSection = { level: 0, title: '', html: '', isCover: false };
    }
  }

  function pushSection() {
    if (currentSection) {
      sections.push(currentSection);
      currentSection = null;
    }
  }

  function append(html) {
    ensureSection();
    currentSection.html += html + '\n';
  }

  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2];

      if (level === 1) {
        // Cover page — start a new section
        pushSection();
        currentSection = { level: 1, title: title, html: '', isCover: true };
        i++;
        continue;
      }

      if (level === 2) {
        // Major section — page break
        pushSection();
        currentSection = { level: 2, title: title, html: '', isCover: false };
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        append('<h2 id="' + id + '">' + inlineFormat(escapeHtml(title)) + '</h2>');
        append('<div class="gold-rule"></div>');
        i++;
        continue;
      }

      if (level === 3) {
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        append('<h3 id="' + id + '">' + inlineFormat(escapeHtml(title)) + '</h3>');
        i++;
        continue;
      }

      if (level === 4) {
        append('<h4>' + inlineFormat(escapeHtml(title)) + '</h4>');
        i++;
        continue;
      }
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      append('<hr class="gold-hr" />');
      i++;
      continue;
    }

    // Code block
    if (line.match(/^```/)) {
      const lang = line.replace(/^```/, '').trim();
      let code = '';
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        code += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++; // skip closing ```
      const langClass = lang ? ' class="lang-' + lang + '"' : '';
      append('<pre class="code-block"><code' + langClass + '>' + code.trimEnd() + '</code></pre>');
      continue;
    }

    // Table
    if (line.match(/^\|/)) {
      let tableHtml = '<table>\n';
      // Header row
      const headerCells = line.split('|').filter(function(c, idx, arr) { return idx > 0 && idx < arr.length - 1; });
      tableHtml += '<thead><tr>';
      headerCells.forEach(function(cell) {
        tableHtml += '<th>' + inlineFormat(cell.trim()) + '</th>';
      });
      tableHtml += '</tr></thead>\n<tbody>\n';
      i++;
      // Skip separator row
      if (i < lines.length && lines[i].match(/^\|[\s\-:|]+\|/)) {
        i++;
      }
      // Body rows
      while (i < lines.length && lines[i].match(/^\|/)) {
        const cells = lines[i].split('|').filter(function(c, idx, arr) { return idx > 0 && idx < arr.length - 1; });
        tableHtml += '<tr>';
        cells.forEach(function(cell) {
          tableHtml += '<td>' + inlineFormat(cell.trim()) + '</td>';
        });
        tableHtml += '</tr>\n';
        i++;
      }
      tableHtml += '</tbody></table>';
      append(tableHtml);
      continue;
    }

    // Blockquote
    if (line.match(/^>\s/)) {
      let quoteLines = [];
      while (i < lines.length && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      append('<blockquote class="callout">' + inlineFormat(quoteLines.join(' ')) + '</blockquote>');
      continue;
    }

    // Checkbox list
    if (line.match(/^- \[([ x])\]/)) {
      let listHtml = '<ul class="checklist">';
      while (i < lines.length && lines[i].match(/^- \[([ x])\]/)) {
        const checked = lines[i].match(/^- \[x\]/);
        const text = lines[i].replace(/^- \[[ x]\]\s*/, '');
        const symbol = checked ? '<span class="check checked">&#9745;</span>' : '<span class="check">&#9744;</span>';
        listHtml += '<li>' + symbol + ' ' + inlineFormat(text) + '</li>';
        i++;
      }
      listHtml += '</ul>';
      append(listHtml);
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      let listHtml = '<ol>';
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        const text = lines[i].replace(/^\d+\.\s+/, '');
        listHtml += '<li>' + inlineFormat(text) + '</li>';
        // Check for sub-items (indented lines or continuation)
        i++;
        while (i < lines.length && lines[i].match(/^\s{2,}/) && !lines[i].match(/^\s*$/)) {
          const subLine = lines[i].trim();
          // Sub-item could be a list item or continuation
          if (subLine.match(/^- /)) {
            listHtml += '<ul><li>' + inlineFormat(subLine.replace(/^- /, '')) + '</li></ul>';
          } else {
            listHtml += '<br/>' + inlineFormat(subLine);
          }
          i++;
        }
      }
      listHtml += '</ol>';
      append(listHtml);
      continue;
    }

    // Unordered list
    if (line.match(/^- /)) {
      let listHtml = '<ul>';
      while (i < lines.length && lines[i].match(/^- /)) {
        const text = lines[i].replace(/^- /, '');
        listHtml += '<li>' + inlineFormat(text) + '</li>';
        i++;
      }
      listHtml += '</ul>';
      append(listHtml);
      continue;
    }

    // Image on its own line (already handled by inline, but just in case)
    if (line.match(/^!\[/)) {
      append('<p>' + inlineFormat(line) + '</p>');
      i++;
      continue;
    }

    // Italic caption line (starts with *)
    if (line.match(/^\*[^*]/) && line.match(/\*$/)) {
      append('<p class="caption"><em>' + inlineFormat(line.slice(1, -1)) + '</em></p>');
      i++;
      continue;
    }

    // Bold metadata lines (like **Feature**: ...)
    if (line.match(/^\*\*[^*]+\*\*:/)) {
      ensureSection();
      if (currentSection.isCover) {
        currentSection.html += '<p class="meta">' + inlineFormat(line) + '</p>\n';
      } else {
        append('<p>' + inlineFormat(line) + '</p>');
      }
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Regular paragraph
    let para = line;
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
           !lines[i].match(/^#{1,4}\s/) && !lines[i].match(/^```/) &&
           !lines[i].match(/^\|/) && !lines[i].match(/^>/) &&
           !lines[i].match(/^- /) && !lines[i].match(/^\d+\./) &&
           !lines[i].match(/^---/) && !lines[i].match(/^!\[/)) {
      para += ' ' + lines[i];
      i++;
    }
    append('<p>' + inlineFormat(para) + '</p>');
  }

  pushSection();
  return sections;
}

// --- Build HTML ---

function buildCoverPage(section) {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="cover-page">
      <div class="cover-content">
        <div class="cover-brand">HELIOS CANOPY</div>
        <h1 class="cover-title">${escapeHtml(section.title)}</h1>
        <div class="cover-subtitle">Solar Thermal Greenhouse Heating System</div>
        <div class="cover-subtitle">Southwest Finland</div>
        <div class="cover-meta">
          ${section.html}
          <p class="meta"><strong>Generated</strong>: ${today}</p>
        </div>
        <div class="cover-decoration">
          <div class="cover-line"></div>
          <div class="cover-diamond">&#9670;</div>
          <div class="cover-line"></div>
        </div>
      </div>
    </div>`;
}

function buildTOC(sections) {
  let tocHtml = `
    <div class="toc-page">
      <h2 class="toc-heading">Table of Contents</h2>
      <div class="gold-rule"></div>
      <div class="toc-list">`;

  let sectionNum = 0;
  sections.forEach(function(s) {
    if (s.level === 2) {
      sectionNum++;
      const id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      tocHtml += `
        <div class="toc-entry">
          <span class="toc-number">${String(sectionNum).padStart(2, '0')}</span>
          <span class="toc-title">${escapeHtml(s.title)}</span>
          <span class="toc-dots"></span>
        </div>`;
    }
  });

  tocHtml += `
      </div>
    </div>`;
  return tocHtml;
}

function buildHTML(sections) {
  let body = '';

  // Cover page
  const cover = sections.find(function(s) { return s.isCover; });
  if (cover) {
    body += buildCoverPage(cover);
  }

  // Table of contents
  body += buildTOC(sections);

  // Content sections
  sections.forEach(function(s) {
    if (s.isCover) return;
    if (s.level === 2) {
      body += '<div class="section-page">\n' + s.html + '</div>\n';
    } else {
      body += s.html;
    }
  });

  const today = new Date().toISOString().slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Helios Canopy - Commissioning Guide</title>
<style>
  @page {
    size: A4;
    margin: 0;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    width: 210mm;
    background: ${C.bg};
    color: ${C.text};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* --- Cover Page --- */
  .cover-page {
    page-break-after: always;
    width: 210mm;
    height: 297mm;
    display: flex;
    align-items: center;
    justify-content: center;
    background: ${C.bg};
    position: relative;
    overflow: hidden;
  }

  .cover-page::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, ${C.gold}, ${C.teal});
  }

  .cover-page::after {
    content: '';
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: linear-gradient(90deg, ${C.teal}, ${C.gold});
  }

  .cover-content {
    text-align: center;
    padding: 40mm 30mm;
  }

  .cover-brand {
    font-family: Georgia, serif;
    font-size: 13pt;
    letter-spacing: 6px;
    color: ${C.gold};
    margin-bottom: 20mm;
    text-transform: uppercase;
  }

  .cover-title {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 28pt;
    color: ${C.text};
    margin-bottom: 8mm;
    line-height: 1.2;
    font-weight: normal;
  }

  .cover-subtitle {
    font-size: 12pt;
    color: ${C.muted};
    margin-bottom: 3mm;
  }

  .cover-meta {
    margin-top: 15mm;
    color: ${C.muted};
    font-size: 9pt;
  }

  .cover-meta .meta {
    margin: 2mm 0;
  }

  .cover-decoration {
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 20mm;
    gap: 10px;
  }

  .cover-line {
    width: 60px;
    height: 1px;
    background: ${C.gold};
  }

  .cover-diamond {
    color: ${C.gold};
    font-size: 10pt;
  }

  /* --- TOC --- */
  .toc-page {
    page-break-after: always;
    padding: 25mm 20mm;
    min-height: 297mm;
    background: ${C.bg};
  }

  .toc-heading {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 20pt;
    color: ${C.text};
    margin-bottom: 3mm;
    font-weight: normal;
  }

  .toc-list {
    margin-top: 10mm;
  }

  .toc-entry {
    display: flex;
    align-items: baseline;
    padding: 3mm 0;
    border-bottom: 1px solid ${C.tableBorder};
  }

  .toc-number {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
    color: ${C.gold};
    font-size: 10pt;
    width: 25px;
    flex-shrink: 0;
  }

  .toc-title {
    color: ${C.text};
    font-size: 11pt;
    flex: 1;
  }

  .toc-dots {
    flex: 1;
    border-bottom: 1px dotted ${C.tableBorder};
    margin: 0 8px;
    min-width: 40px;
  }

  /* --- Content Sections --- */
  .section-page {
    page-break-before: always;
    padding: 25mm 20mm 20mm 20mm;
    background: ${C.bg};
  }

  h2 {
    font-family: Georgia, serif;
    font-style: italic;
    font-size: 18pt;
    color: ${C.text};
    margin-bottom: 2mm;
    font-weight: normal;
    padding-top: 0;
  }

  h3 {
    font-family: Georgia, serif;
    font-size: 13pt;
    color: ${C.gold};
    margin-top: 8mm;
    margin-bottom: 3mm;
    font-weight: normal;
  }

  h4 {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    color: ${C.teal};
    margin-top: 6mm;
    margin-bottom: 2mm;
    font-weight: 600;
  }

  .gold-rule {
    height: 2px;
    background: linear-gradient(90deg, ${C.gold}, transparent);
    margin-bottom: 6mm;
    border: none;
  }

  hr.gold-hr {
    height: 1px;
    background: linear-gradient(90deg, ${C.gold}40, ${C.gold}, ${C.gold}40);
    border: none;
    margin: 8mm 0;
  }

  p {
    margin-bottom: 3mm;
    color: ${C.text};
  }

  p.caption {
    color: ${C.muted};
    font-size: 8.5pt;
    margin-top: -1mm;
    margin-bottom: 5mm;
    font-style: italic;
    line-height: 1.4;
  }

  strong {
    color: ${C.text};
    font-weight: 600;
  }

  em {
    font-style: italic;
  }

  a {
    color: ${C.teal};
    text-decoration: none;
  }

  code {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
    background: ${C.codeBg};
    color: ${C.gold};
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 9pt;
  }

  pre.code-block {
    background: ${C.codeBg};
    border: 1px solid ${C.tableBorder};
    border-left: 3px solid ${C.gold};
    border-radius: 6px;
    padding: 4mm;
    margin: 4mm 0 5mm 0;
    overflow-x: auto;
    page-break-inside: avoid;
  }

  pre.code-block code {
    background: none;
    padding: 0;
    color: #c8cede;
    font-size: 8.5pt;
    line-height: 1.5;
  }

  /* --- Tables --- */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 4mm 0 5mm 0;
    font-size: 9pt;
    page-break-inside: avoid;
  }

  thead tr {
    background: ${C.gold}20;
    border-bottom: 2px solid ${C.gold};
  }

  th {
    color: ${C.gold};
    font-weight: 600;
    text-align: left;
    padding: 2.5mm 3mm;
    font-size: 9pt;
  }

  td {
    padding: 2mm 3mm;
    color: ${C.text};
    border-bottom: 1px solid ${C.tableBorder};
  }

  tbody tr:nth-child(even) {
    background: ${C.tableRowAlt};
  }

  /* --- Lists --- */
  ul, ol {
    margin: 3mm 0 4mm 6mm;
    color: ${C.text};
  }

  li {
    margin-bottom: 1.5mm;
    padding-left: 1mm;
  }

  li::marker {
    color: ${C.gold};
  }

  /* Nested lists */
  li ul {
    margin: 1mm 0 1mm 4mm;
  }

  /* --- Checklists --- */
  ul.checklist {
    list-style: none;
    margin-left: 2mm;
  }

  ul.checklist li {
    padding-left: 0;
    margin-bottom: 2mm;
  }

  .check {
    color: ${C.muted};
    font-size: 12pt;
    margin-right: 2mm;
    vertical-align: middle;
  }

  .check.checked {
    color: ${C.teal};
  }

  /* --- Blockquotes / Callouts --- */
  blockquote.callout {
    background: ${C.card};
    border-left: 3px solid ${C.teal};
    border-radius: 0 6px 6px 0;
    padding: 4mm 5mm;
    margin: 4mm 0 5mm 0;
    color: ${C.text};
    font-size: 9.5pt;
    page-break-inside: avoid;
  }

  /* --- Screenshots --- */
  img.screenshot {
    display: block;
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    border: 1px solid ${C.gold}40;
    margin: 4mm auto 2mm auto;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
  }

  /* --- Flowchart ASCII art box --- */
  pre.code-block code.lang-undefined,
  pre.code-block code:not([class]) {
    color: ${C.teal};
  }

  /* --- Print adjustments --- */
  @media print {
    body {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// --- Main ---
async function main() {
  console.log('Reading markdown...');
  const md = fs.readFileSync(MD_PATH, 'utf8');

  console.log('Parsing markdown...');
  const sections = parseMarkdown(md);
  console.log('Found ' + sections.length + ' sections');

  console.log('Building HTML...');
  const html = buildHTML(sections);

  // Write intermediate HTML for debugging (optional)
  const htmlPath = path.join(__dirname, 'commissioning-guide.html');
  fs.writeFileSync(htmlPath, html);
  console.log('Wrote intermediate HTML: ' + htmlPath);

  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle' });

  const today = new Date().toISOString().slice(0, 10);

  console.log('Generating PDF...');
  await page.pdf({
    path: OUTPUT_PATH,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '25mm',
      bottom: '20mm',
      left: '20mm',
      right: '20mm',
    },
    displayHeaderFooter: true,
    headerTemplate: `
      <div style="width: 100%; font-size: 8px; padding: 0 10mm; display: flex; justify-content: space-between; align-items: center; color: #a5abb9; font-family: Georgia, serif;">
        <span style="color: #e9c349; letter-spacing: 2px; font-size: 8px;">HELIOS CANOPY</span>
        <span style="font-style: italic; font-size: 7.5px;">Commissioning Guide</span>
      </div>`,
    footerTemplate: `
      <div style="width: 100%; font-size: 8px; padding: 0 10mm; display: flex; justify-content: space-between; align-items: center; color: #a5abb9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
        <span></span>
        <span style="color: #e9c349;"><span class="pageNumber"></span></span>
        <span style="font-size: 7px;">${today}</span>
      </div>`,
  });

  await browser.close();

  // Clean up intermediate HTML
  fs.unlinkSync(htmlPath);

  const stats = fs.statSync(OUTPUT_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log('PDF generated: ' + OUTPUT_PATH + ' (' + sizeMB + ' MB)');
}

main().catch(function(err) {
  console.error('Error:', err);
  process.exit(1);
});

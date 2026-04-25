/**
 * Minimal YAML 1.2 loader for the subset used by `system.yaml` and
 * `design/diagrams/topology-layout.yaml`. Supports:
 *
 *   - Block mappings:   key: value
 *   - Block sequences:  - item
 *   - Plain / single-quoted / double-quoted scalars
 *   - Folded block scalars (>, >-, >+)
 *   - Literal block scalars (|, |-, |+)
 *   - Flow sequences:   [a, b, c]      (single-line, scalar elements)
 *   - Flow mappings:    {x: 1, y: 2}   (single-line, scalar values)
 *   - Line comments (# …) outside of quoted strings
 *
 * Out of scope: anchors / aliases / tags / merge keys / multi-document
 * streams / nested flow collections beyond one level. Throws on any
 * input that uses those features.
 *
 * Browser-side YAML still uses the full js-yaml at playground/vendor/.
 */

'use strict';

function load(text) {
  if (typeof text !== 'string') {
    throw new TypeError('yaml-load: input must be a string');
  }
  const lines = scanLines(text);
  if (lines.length === 0) return null;
  // The whole document is a single block node at the smallest indent.
  const ctx = { lines, idx: 0 };
  const baseIndent = lines[0].indent;
  return parseBlock(ctx, baseIndent);
}

// ── Lexer: strip comments / blank lines, compute indents ────────────────────

function scanLines(text) {
  const out = [];
  const raw = text.split(/\r?\n/);
  for (let lineNum = 0; lineNum < raw.length; lineNum++) {
    const line = raw[lineNum];
    const stripped = stripComment(line);
    if (stripped.trim() === '') continue;
    let indent = 0;
    while (indent < stripped.length && stripped.charCodeAt(indent) === 0x20) indent++;
    out.push({ raw: line, content: stripped.slice(indent), indent, lineNum: lineNum + 1 });
  }
  return out;
}

// Remove trailing # comments, but ignore # inside quoted strings.
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"' && line.charAt(i - 1) !== '\\') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === '#') {
      if (i === 0 || line.charCodeAt(i - 1) === 0x20 || line.charCodeAt(i - 1) === 0x09) {
        return line.slice(0, i).replace(/\s+$/, '');
      }
    }
  }
  return line.replace(/\s+$/, '');
}

// ── Block-level parser ──────────────────────────────────────────────────────

function parseBlock(ctx, indent) {
  if (ctx.idx >= ctx.lines.length) return null;
  const line = ctx.lines[ctx.idx];
  if (line.indent < indent) return null;
  if (line.content.startsWith('- ') || line.content === '-') {
    return parseBlockSequence(ctx, line.indent);
  }
  return parseBlockMapping(ctx, line.indent);
}

function parseBlockSequence(ctx, indent) {
  const out = [];
  while (ctx.idx < ctx.lines.length) {
    const line = ctx.lines[ctx.idx];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(yamlErr(line, 'unexpected indent in sequence'));
    if (!(line.content.startsWith('- ') || line.content === '-')) break;
    const itemContent = line.content === '-' ? '' : line.content.slice(2);
    ctx.idx++;
    if (itemContent === '') {
      // Nested block — must be deeper indent.
      out.push(parseBlock(ctx, indent + 1));
      continue;
    }
    // Block scalar as sequence item: "- >-" / "- |+" / etc.
    if (itemContent === '|' || itemContent === '|-' || itemContent === '|+'
        || itemContent === '>' || itemContent === '>-' || itemContent === '>+') {
      out.push(parseBlockScalar(ctx, indent, itemContent));
      continue;
    }
    // Could be: scalar, "key: value" (mapping starting on dash line),
    // or "key:" (mapping with nested block).
    const colonIdx = findKeyColon(itemContent);
    if (colonIdx === -1) {
      out.push(parseInlineScalar(itemContent));
      continue;
    }
    // Mapping starting on the same line as the dash. The "virtual"
    // indent of this mapping is `indent + 2` (after "- ").
    const mapEntries = {};
    const inlineKey = itemContent.slice(0, colonIdx).trim();
    const inlineVal = itemContent.slice(colonIdx + 1).trim();
    parseMappingEntry(ctx, indent + 2, mapEntries, inlineKey, inlineVal);
    while (ctx.idx < ctx.lines.length) {
      const next = ctx.lines[ctx.idx];
      if (next.indent < indent + 2) break;
      if (next.indent > indent + 2) throw new Error(yamlErr(next, 'inconsistent indent in inline mapping'));
      const nextColon = findKeyColon(next.content);
      if (nextColon === -1) break;
      const k = next.content.slice(0, nextColon).trim();
      const v = next.content.slice(nextColon + 1).trim();
      ctx.idx++;
      parseMappingEntry(ctx, indent + 2, mapEntries, k, v);
    }
    out.push(mapEntries);
  }
  return out;
}

function parseBlockMapping(ctx, indent) {
  const out = {};
  while (ctx.idx < ctx.lines.length) {
    const line = ctx.lines[ctx.idx];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new Error(yamlErr(line, 'unexpected indent in mapping'));
    if (line.content.startsWith('- ') || line.content === '-') break;
    const colonIdx = findKeyColon(line.content);
    if (colonIdx === -1) throw new Error(yamlErr(line, 'expected "key:" in mapping'));
    const key = parseInlineScalar(line.content.slice(0, colonIdx).trim());
    const valStr = line.content.slice(colonIdx + 1).trim();
    ctx.idx++;
    parseMappingEntry(ctx, indent, out, key, valStr);
  }
  return out;
}

function parseMappingEntry(ctx, indent, out, key, valStr) {
  if (valStr === '' || valStr === '~') {
    // Either null, or block content on next line(s).
    if (ctx.idx < ctx.lines.length && ctx.lines[ctx.idx].indent > indent) {
      out[key] = parseBlock(ctx, ctx.lines[ctx.idx].indent);
    } else {
      out[key] = valStr === '~' ? null : null;
    }
    return;
  }
  if (valStr === '|' || valStr === '|-' || valStr === '|+'
      || valStr === '>' || valStr === '>-' || valStr === '>+') {
    out[key] = parseBlockScalar(ctx, indent, valStr);
    return;
  }
  out[key] = parseInlineScalar(valStr);
}

// Find the colon that separates "key:" — must be followed by space, EOL, or end of input.
// Skips colons inside quoted strings or flow constructs.
function findKeyColon(s) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0) {
      const next = s.charAt(i + 1);
      if (next === '' || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

// ── Block scalars (|, >) ────────────────────────────────────────────────────

function parseBlockScalar(ctx, parentIndent, indicator) {
  const literal = indicator.charAt(0) === '|';
  // Chomping: '-' strip trailing newline, '+' keep all trailing newlines, default: keep one.
  const chomp = indicator.length > 1 ? indicator.charAt(1) : '';
  const lines = [];
  let scalarIndent = -1;
  while (ctx.idx < ctx.lines.length) {
    const line = ctx.lines[ctx.idx];
    if (line.indent <= parentIndent) break;
    if (scalarIndent === -1) scalarIndent = line.indent;
    if (line.indent < scalarIndent) break;
    lines.push(line.raw.slice(scalarIndent));
    ctx.idx++;
  }
  let result;
  if (literal) {
    result = lines.join('\n');
  } else {
    // Folded: empty lines = literal newlines, otherwise consecutive non-empty
    // lines fold into a single space.
    const out = [];
    let buf = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === '') {
        if (buf !== '') { out.push(buf); buf = ''; }
        out.push('');
      } else if (buf === '') {
        buf = lines[i];
      } else {
        buf += ' ' + lines[i];
      }
    }
    if (buf !== '') out.push(buf);
    result = out.join('\n');
  }
  if (chomp === '-') {
    return result.replace(/\n+$/, '');
  }
  if (chomp === '+') {
    return result + '\n';
  }
  // Default: single trailing newline.
  return result.replace(/\n*$/, '\n');
}

// ── Scalar parsing ──────────────────────────────────────────────────────────

function parseInlineScalar(s) {
  if (s.length === 0) return null;
  // Flow collections
  if (s.charAt(0) === '[') return parseFlowSequence(s);
  if (s.charAt(0) === '{') return parseFlowMapping(s);
  // Quoted
  if (s.charAt(0) === '"') return parseDoubleQuoted(s);
  if (s.charAt(0) === "'") return parseSingleQuoted(s);
  return parseScalar(s);
}

function parseScalar(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  // Strict integer
  if (/^-?(0|[1-9][0-9]*)$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s.replace(/^-0$/, '0')) return n;
  }
  // Float
  if (/^-?(0|[1-9][0-9]*)?\.[0-9]+$/.test(s) || /^-?[0-9]+\.[0-9]+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

function parseDoubleQuoted(s) {
  if (s.charAt(s.length - 1) !== '"') throw new Error('Unterminated double-quoted scalar: ' + s);
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s.charAt(i);
    if (ch === '\\') {
      const next = s.charAt(i + 1);
      i++;
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else if (next === '/') out += '/';
      else if (next === '0') out += '\0';
      else out += next;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseSingleQuoted(s) {
  if (s.charAt(s.length - 1) !== "'") throw new Error('Unterminated single-quoted scalar: ' + s);
  // YAML single-quote: only escape is '' (doubled).
  return s.slice(1, s.length - 1).replace(/''/g, "'");
}

// ── Flow collections (single-line, simple) ──────────────────────────────────

function parseFlowSequence(s) {
  if (s.charAt(s.length - 1) !== ']') throw new Error('Unterminated flow sequence: ' + s);
  const inner = s.slice(1, s.length - 1).trim();
  if (inner === '') return [];
  return splitFlow(inner).map(parseInlineScalar);
}

function parseFlowMapping(s) {
  if (s.charAt(s.length - 1) !== '}') throw new Error('Unterminated flow mapping: ' + s);
  const inner = s.slice(1, s.length - 1).trim();
  if (inner === '') return {};
  const out = {};
  for (const part of splitFlow(inner)) {
    const colon = findKeyColon(part);
    if (colon === -1) throw new Error('Bad flow mapping entry: ' + part);
    const k = parseScalar(part.slice(0, colon).trim());
    const v = parseInlineScalar(part.slice(colon + 1).trim());
    out[k] = v;
  }
  return out;
}

// Split a flow-collection inner string by commas, respecting nested
// flow constructs and quoted strings.
function splitFlow(s) {
  const out = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inDouble) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

// ── Errors ──────────────────────────────────────────────────────────────────

function yamlErr(line, msg) {
  return 'yaml-load: ' + msg + ' at line ' + line.lineNum + ': ' + line.raw;
}

module.exports = { load };

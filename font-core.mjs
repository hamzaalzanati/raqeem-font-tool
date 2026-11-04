const FOREGROUND = 0xffff;
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MARK_RE = /^(?:dot|twodots|threedots|fourdots|fivedots|vtwodots|hamza)(?:\.|$)/i;
const UNICODE_GLYPH_RE = /^uni([0-9a-f]{4,6})(?:\.|$)/i;
const MARK_CHAR = /^\p{M}$/u;

function fail(message) { throw new Error(message); }
function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32(b, o) { return (b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]; }
function put16(b, o, n) { b[o] = (n >>> 8) & 255; b[o + 1] = n & 255; }
function put32(b, o, n) { n >>>= 0; b[o] = (n >>> 24) & 255; b[o + 1] = (n >>> 16) & 255; b[o + 2] = (n >>> 8) & 255; b[o + 3] = n & 255; }
function readTag(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function writeTag(b, o, s) { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) || 32; }
function align4(n) { return (n + 3) & ~3; }

export function inspectSfnt(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) fail('حجم الملف غير صالح أو يتجاوز 32 ميغابايت.');
  const signature = readTag(bytes, 0);
  if (!['\u0000\u0001\u0000\u0000', 'OTTO', 'true'].includes(signature)) {
    fail(signature === 'ttcf' ? 'ملف TTC مجموعة خطوط؛ ارفع ملف TTF أو OTF منفردًا.' : 'الملف لا يبدو خط TTF/OTF صالحًا.');
  }
  const count = u16(bytes, 4);
  if (!count || count > 256 || 12 + count * 16 > bytes.length) fail('جدول الخطوط تالف أو غير مكتمل.');
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, tag = readTag(bytes, p), checksum = u32(bytes, p + 4), offset = u32(bytes, p + 8), length = u32(bytes, p + 12);
    if (offset + length > bytes.length || tables.has(tag)) fail('مواضع جداول الخط غير صالحة.');
    tables.set(tag, { tag, checksum, offset, length, bytes: bytes.subarray(offset, offset + length) });
  }
  return { bytes, signature, tables, numTables: count };
}

function decodeUtf16BE(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return out;
}
function encodeUtf16BE(text) {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) put16(out, i * 2, text.charCodeAt(i));
  return out;
}
function decodeNameRecord(raw, platform, encoding) {
  if (platform === 0 || platform === 3) return decodeUtf16BE(raw);
  if (platform === 1 && encoding === 0 && raw.every(x => x < 128)) return String.fromCharCode(...raw);
  return null;
}
function encodeNameRecord(text, platform, encoding) {
  if (platform === 0 || platform === 3) return encodeUtf16BE(text);
  if (platform === 1 && encoding === 0 && /^[\x00-\x7f]*$/.test(text)) return Uint8Array.from(text, c => c.charCodeAt(0));
  return null;
}
function readNameRecords(table) {
  if (!table || table.length < 6) fail('جدول الأسماء غير موجود أو تالف.');
  const format = u16(table, 0);
  if (format !== 0) fail('صيغة جدول أسماء الخط (name format 1) غير مدعومة بعد؛ لن نغيّر الاسم بطريقة قد تفسد بياناته.');
  const count = u16(table, 2), stringOffset = u16(table, 4);
  if (6 + count * 12 > table.length || stringOffset > table.length) fail('جدول أسماء الخط تالف.');
  const records = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12, platform = u16(table, p), encoding = u16(table, p + 2), language = u16(table, p + 4), nameID = u16(table, p + 6), length = u16(table, p + 8), offset = u16(table, p + 10);
    const start = stringOffset + offset;
    if (start + length > table.length) fail('اسم داخل جدول الخط يتجاوز حدود الملف.');
    const raw = table.slice(start, start + length);
    records.push({ nameID, platform, encoding, language, raw, decoded: decodeNameRecord(raw, platform, encoding) });
  }
  return records;
}
function bestName(records, id, fallback = '') {
  const candidates = records.filter(r => r.nameID === id && r.decoded != null);
  const chosen = candidates.find(r => r.platform === 3 && r.language === 0x409) || candidates.find(r => r.platform === 0) || candidates[0];
  return chosen ? chosen.decoded.replace(/\0/g, '') : fallback;
}
function parseNames(table) {
  const records = readNameRecords(table);
  return { records, family: bestName(records, 1, 'خط عربي'), fullName: bestName(records, 4, bestName(records, 1, 'خط عربي')), license: bestName(records, 13, '') };
}

function postGlyphNames(postTable, glyphCount) {
  if (!postTable || postTable.length < 32) fail('لا توجد أسماء محارف موثوقة في جدول post؛ لا يمكن تصنيف الطبقات بأمان.');
  const format = u32(postTable, 0);
  if (format !== 0x00020000) fail(format === 0x00030000 ? 'الخط يستخدم post format 3.0 بأسماء Glyph عامة؛ لا يمكن تمييز النقاط والتشكيل عن جسم الحرف بأمان.' : 'صيغة post في هذا الخط لا تسمح بتصنيف طبقات الألوان بأمان.');
  if (postTable.length < 34) fail('جدول أسماء المحارف تالف.');
  const count = u16(postTable, 32);
  if (count !== glyphCount || 34 + count * 2 > postTable.length) fail('عدد المحارف في post وmaxp لا يتطابق.');
  const indices = [];
  let max = 257;
  for (let i = 0; i < count; i++) { const idx = u16(postTable, 34 + i * 2); indices.push(idx); if (idx > max) max = idx; }
  const customCount = Math.max(0, max - 257), names = [];
  let p = 34 + count * 2;
  for (let i = 0; i < customCount; i++) {
    if (p >= postTable.length) fail('قائمة أسماء المحارف تالف.');
    const size = postTable[p++];
    if (p + size > postTable.length) fail('اسم محرف يتجاوز حدود جدول post.');
    names.push(String.fromCharCode(...postTable.subarray(p, p + size)));
    p += size;
  }
  return indices.map(idx => idx < 258 ? `std#${idx}` : (names[idx - 258] ?? ''));
}

function isMarkLayerName(name) {
  if (MARK_RE.test(name)) return true;
  const m = name.match(UNICODE_GLYPH_RE);
  if (!m) return false;
  const cp = parseInt(m[1], 16);
  if (!Number.isFinite(cp) || cp > 0x10ffff) return false;
  const char = String.fromCodePoint(cp);
  return MARK_CHAR.test(char) || (cp >= 0x0610 && cp <= 0x061a) || (cp >= 0x06d6 && cp <= 0x06ed) || (cp >= 0x08d3 && cp <= 0x08ff) || (cp >= 0x0660 && cp <= 0x0669) || [0x0621, 0x06e5, 0x06e6].includes(cp);
}

function parseCpal(table) {
  if (!table || table.length < 14) fail('لا توجد لوحة ألوان CPAL صالحة.');
  const version = u16(table, 0), entries = u16(table, 2), palettes = u16(table, 4), colorRecords = u16(table, 6), colorOffset = u32(table, 8);
  if (version !== 0) fail('يُدعم حاليًا CPAL الإصدار 0 فقط.');
  if (palettes !== 1) fail('يحتوي الخط على أكثر من لوحة ألوان؛ يلزم التحقق من كل لوحة قبل تعديلها.');
  const paletteIndexOffset = 12;
  if (!entries || paletteIndexOffset + 2 > table.length || colorOffset + colorRecords * 4 > table.length) fail('جدول CPAL تالف.');
  const first = u16(table, paletteIndexOffset);
  if (first + entries > colorRecords || colorOffset + (first + entries) * 4 !== table.length) fail('تخطيط CPAL غير مألوف؛ أوقفنا التصدير لتجنّب تلف الملف.');
  return { version, entries, palettes, colorRecords, colorOffset, first };
}

export function inspectFont(input) {
  const sfnt = inspectSfnt(input), { tables } = sfnt;
  const colr = tables.get('COLR'), cpal = tables.get('CPAL'), post = tables.get('post'), maxp = tables.get('maxp'), name = tables.get('name');
  if (!colr || !cpal) fail('هذا الخط لا يحتوي COLR وCPAL؛ لا توجد طبقات ألوان خطية يمكن تعديلها بأمان.');
  if (colr.length < 14 || u16(colr.bytes, 0) !== 0) fail('يُدعم حاليًا تنسيق COLR الإصدار 0 فقط؛ COLR v1 لا يمكن تقسيم طبقاته بأمان هنا.');
  if (!maxp || maxp.length < 6 || !post) fail('تنقص الخط بيانات المحارف اللازمة لتصنيف الطبقات بأمان.');
  const palette = parseCpal(cpal.bytes);
  const glyphCount = u16(maxp.bytes, 4), names = postGlyphNames(post.bytes, glyphCount);
  if (tables.has('CFF ') || tables.has('CFF2') || !tables.has('glyf')) fail('يستخدم هذا الخط مخطوطات CFF. لا نعدّل أسماء OTF الداخلية بطريقة قد تترك اسمي PostScript متعارضين؛ الإصدار الحالي يصدّر خطوط glyf فقط.');
  const numBase = u16(colr.bytes, 2), baseOffset = u32(colr.bytes, 4), layerOffset = u32(colr.bytes, 8), numLayers = u16(colr.bytes, 12);
  if (baseOffset + numBase * 6 > colr.length || layerOffset + numLayers * 4 > colr.length) fail('جداول طبقات COLR غير مكتملة.');
  let foregroundLayers = 0, semanticMarkLayers = 0, ambiguousLayers = [];
  const bases = [];
  for (let i = 0; i < numBase; i++) {
    const p = baseOffset + i * 6, glyphID = u16(colr.bytes, p), first = u16(colr.bytes, p + 2), count = u16(colr.bytes, p + 4);
    if (glyphID >= glyphCount || first + count > numLayers) fail('مرجع محرف غير صالح داخل COLR.');
    let foreground = 0, marks = 0;
    for (let j = 0; j < count; j++) {
      const lp = layerOffset + (first + j) * 4, layerGlyph = u16(colr.bytes, lp), colorID = u16(colr.bytes, lp + 2);
      if (layerGlyph >= glyphCount) fail('مرجع طبقة غير صالح داخل COLR.');
      if (colorID === FOREGROUND) { foreground++; foregroundLayers++; }
      else {
        if (colorID >= palette.entries) fail('COLR يشير إلى لون غير موجود في CPAL.');
        const layerName = names[layerGlyph] || '';
        if (isMarkLayerName(layerName)) { marks++; semanticMarkLayers++; }
        else if (ambiguousLayers.length < 5) ambiguousLayers.push(layerName || `glyph#${layerGlyph}`);
      }
    }
    if (foreground && marks) bases.push({ glyphID, foreground, marks });
  }
  if (ambiguousLayers.length) {
    const list = [...new Set(ambiguousLayers)].join('، ');
    fail(`توجد طبقات ملوّنة غير معروفة دلاليًا (${list})؛ لن نفترض أنها نقاط أو تشكيل.`);
  }
  if (!foregroundLayers || !semanticMarkLayers || !bases.length) fail('لم نجد في هذا الخط محارف تجمع بوضوح بين جسم حرف وطبقة نقط/تشكيل منفصلة.');
  const nameInfo = parseNames(name?.bytes);
  const colors = [];
  for (let i = 0; i < palette.entries; i++) {
    const p = palette.colorOffset + (palette.first + i) * 4;
    colors.push({ b: cpal.bytes[p], g: cpal.bytes[p + 1], r: cpal.bytes[p + 2], a: cpal.bytes[p + 3] });
  }
  return {
    ...sfnt,
    family: nameInfo.family,
    fullName: nameInfo.fullName,
    license: nameInfo.license,
    glyphCount,
    baseGlyphCount: numBase,
    layerCount: numLayers,
    foregroundLayers,
    markLayers: semanticMarkLayers,
    mixedGlyphs: bases.length,
    paletteEntries: palette.entries,
    originalColors: colors,
    extension: sfnt.signature === 'OTTO' ? 'otf' : 'ttf',
  };
}

function parseHexColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || ''));
  if (!match) fail('لون غير صالح. استخدم صيغة #RRGGBB.');
  const rgb = match[1];
  return { r: parseInt(rgb.slice(0, 2), 16), g: parseInt(rgb.slice(2, 4), 16), b: parseInt(rgb.slice(4, 6), 16), a: 255 };
}
function asciiSlug(s) {
  const base = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '');
  return (base || 'ArabicFont').slice(0, 42);
}
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
function updateNameTable(table, family, uniqueSuffix) {
  const records = readNameRecords(table);
  const oldFull = bestName(records, 4, family);
  const ps = `Raqeem${asciiSlug(family)}`.slice(0, 63);
  const values = new Map([
    [1, family], [3, `${family} | Raqeem | ${uniqueSuffix}`.slice(0, 240)], [4, `${family} ${oldFull.toLowerCase().includes('bold') ? 'Bold' : 'Regular'}`], [6, ps], [16, family],
  ]);
  const updated = [];
  const handled = new Set();
  for (const rec of records) {
    const value = values.get(rec.nameID);
    let raw = rec.raw;
    if (value != null) {
      const encoded = encodeNameRecord(value, rec.platform, rec.encoding);
      if (encoded) { raw = encoded; handled.add(rec.nameID); }
      else if (rec.platform === 1 && rec.encoding === 0) {
        const fallback = rec.nameID === 6 ? ps : `Raqeem ${asciiSlug(family)}`;
        const encodedFallback = encodeNameRecord(fallback, rec.platform, rec.encoding);
        if (encodedFallback) { raw = encodedFallback; handled.add(rec.nameID); }
      }
    }
    updated.push({ ...rec, raw });
  }
  for (const id of [1, 3, 4, 6, 16]) {
    if (handled.has(id)) continue;
    const value = values.get(id);
    updated.push({ nameID: id, platform: 3, encoding: 1, language: 0x409, raw: encodeUtf16BE(value) });
  }
  const header = new Uint8Array(6 + updated.length * 12);
  put16(header, 0, 0); put16(header, 2, updated.length); put16(header, 4, header.length);
  const chunks = [];
  let stringBytes = 0;
  for (let i = 0; i < updated.length; i++) {
    const r = updated[i], p = 6 + i * 12;
    if (r.raw.length > 65535 || stringBytes > 65535) fail('اسم الخط المعدّل أطول من الحد المسموح في جدول name.');
    put16(header, p, r.platform); put16(header, p + 2, r.encoding); put16(header, p + 4, r.language); put16(header, p + 6, r.nameID); put16(header, p + 8, r.raw.length); put16(header, p + 10, stringBytes);
    chunks.push(r.raw); stringBytes += r.raw.length;
  }
  if (header.length + stringBytes > 65535) fail('جدول أسماء الخط المعدّل يتجاوز حد OpenType.');
  const output = new Uint8Array(header.length + stringBytes); output.set(header);
  let p = header.length; for (const c of chunks) { output.set(c, p); p += c.length; }
  return output;
}

export function colorizeFont(input, { mainColor, markColor, familyName } = {}) {
  const info = inspectFont(input);
  const main = parseHexColor(mainColor), mark = parseHexColor(markColor);
  let family = String(familyName || `${info.family} - Raqeem`).trim();
  if (!/(?:[-_ ]Raqeem)$/i.test(family)) family = `${family} - Raqeem`;
  if (family.length < 2 || family.length > 80) fail('اسم الخط يجب أن يتكوّن من 2 إلى 80 حرفًا.');
  const cpalRecord = info.tables.get('CPAL'), colrRecord = info.tables.get('COLR');
  const cp = cpalRecord.bytes.slice(), co = colrRecord.bytes.slice(), palette = parseCpal(cp);
  const newMainIndex = palette.entries;
  for (let i = 0; i < palette.entries; i++) {
    const p = palette.colorOffset + (palette.first + i) * 4;
    cp[p] = mark.b; cp[p + 1] = mark.g; cp[p + 2] = mark.r; cp[p + 3] = mark.a;
  }
  const newCpal = new Uint8Array(cp.length + 4); newCpal.set(cp);
  const appendAt = palette.colorOffset + palette.colorRecords * 4;
  if (appendAt !== cp.length) fail('تعذّر إضافة لون جسم الحرف إلى CPAL دون إعادة بناء غير آمنة.');
  newCpal[appendAt] = main.b; newCpal[appendAt + 1] = main.g; newCpal[appendAt + 2] = main.r; newCpal[appendAt + 3] = main.a;
  put16(newCpal, 2, palette.entries + 1); put16(newCpal, 6, palette.colorRecords + 1);
  const numLayers = u16(co, 12), layerOffset = u32(co, 8);
  for (let i = 0; i < numLayers; i++) {
    const p = layerOffset + i * 4, colorID = u16(co, p + 2);
    if (colorID === FOREGROUND) put16(co, p + 2, newMainIndex);
  }
  const bytesHash = info.bytes.reduce((h, b) => ((Math.imul(h ^ b, 16777619)) >>> 0), 2166136261).toString(16).padStart(8, '0');
  const newName = updateNameTable(info.tables.get('name').bytes, family, bytesHash);
  const replacement = new Map([['COLR', co], ['CPAL', newCpal], ['name', newName]]);
  const tables = [...info.tables.values()].filter(t => t.tag !== 'DSIG').map(t => ({ tag: t.tag, bytes: replacement.get(t.tag) || t.bytes.slice() }));
  const head = tables.find(t => t.tag === 'head');
  if (!head || head.bytes.length < 12) fail('لا يوجد جدول head صالح لتحديث سلامة ملف الخط.');
  put32(head.bytes, 8, 0);
  const n = tables.length, power = 2 ** Math.floor(Math.log2(n)), total = 12 + n * 16;
  let cursor = align4(total);
  const positions = new Map();
  for (const t of tables) { positions.set(t.tag, cursor); cursor = align4(cursor + t.bytes.length); }
  const out = new Uint8Array(cursor); out.set(info.bytes.subarray(0, 12));
  put16(out, 4, n); put16(out, 6, power * 16); put16(out, 8, Math.log2(power)); put16(out, 10, n * 16 - power * 16);
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i], dir = 12 + i * 16, offset = positions.get(t.tag);
    writeTag(out, dir, t.tag); put32(out, dir + 4, checksum(t.bytes)); put32(out, dir + 8, offset); put32(out, dir + 12, t.bytes.length); out.set(t.bytes, offset);
  }
  const headOffset = positions.get('head');
  const adjustment = (0xb1b0afba - checksum(out)) >>> 0;
  put32(out, headOffset + 8, adjustment);
  return { bytes: out, filenameBase: family.replace(/[\\/:*?"<>|]/g, '').trim(), extension: info.extension, family, info };
}

export function validateColoredFont(input) {
  const info = inspectSfnt(input), { tables } = info;
  const cpal = tables.get('CPAL'), colr = tables.get('COLR'), name = tables.get('name'), head = tables.get('head');
  if (!cpal || !colr || !name || !head) fail('الملف الناتج ينقصه جدول أساسي.');
  if (u16(colr.bytes, 0) !== 0 || u16(cpal.bytes, 0) !== 0) fail('إصدار جداول الألوان غير متوقع.');
  const palette = parseCpal(cpal.bytes), numLayers = u16(colr.bytes, 12), layerOffset = u32(colr.bytes, 8);
  for (let i = 0; i < numLayers; i++) {
    const p = layerOffset + i * 4, colorID = u16(colr.bytes, p + 2);
    if (colorID !== FOREGROUND && colorID >= palette.entries) fail('طبقة تشير إلى لون خارج لوحة CPAL.');
  }
  const n = u16(info.bytes, 4);
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16, offset = u32(info.bytes, p + 8), len = u32(info.bytes, p + 12), tag = readTag(info.bytes, p);
    const tableBytes = info.bytes.subarray(offset, offset + len);
    if (tag !== 'head' && checksum(tableBytes) !== u32(info.bytes, p + 4)) fail(`فشل فحص checksum لجدول ${tag}.`);
  }
  const whole = checksum(info.bytes);
  if (whole !== 0xb1b0afba) fail('فشل فحص checksum العام لملف الخط.');
  const names = parseNames(name.bytes);
  if (!names.family.includes('Raqeem') && !names.family.includes('رقيم')) fail('لم يتم العثور على اسم مميز في ملف الخط الناتج.');
  return { ...info, ...names, checksumOk: true, family: names.family };
}

export { MAX_FONT_BYTES };

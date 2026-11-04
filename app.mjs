import { inspectFont, colorizeFont, validateColoredFont, MAX_FONT_BYTES } from './font-core.mjs';

const $ = (id) => document.getElementById(id);
const state = { file: null, bytes: null, analysis: null, output: null, objectUrl: null, debounce: 0, requestId: 0 };
const fileInput = $('font-file'), dropzone = $('dropzone'), statusBox = $('status'), statusText = $('status-text');
const editorControls = $('editor-controls'), downloadButton = $('download'), preview = $('preview-text');

function setStatus(type, text) {
  statusBox.className = `status-box status-${type}`;
  statusBox.querySelector('.status-icon').innerHTML = type === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : type === 'error'
      ? '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="m9 9 6 6m0-6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5m0-8h.01" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  statusText.textContent = text;
}
function bytesLabel(n) { return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} كيلوبايت` : `${(n / 1024 / 1024).toFixed(2)} ميغابايت`; }
function setReady(ready) {
  editorControls.classList.toggle('is-enabled', ready);
  editorControls.setAttribute('aria-disabled', String(!ready));
  $('main-color').disabled = !ready; $('main-hex').disabled = !ready;
  $('mark-color').disabled = !ready; $('mark-hex').disabled = !ready;
  $('font-name').disabled = !ready; downloadButton.disabled = !ready;
}
function updateColorsAndPreview() {
  if (!state.analysis) return;
  try {
    const familyName = $('font-name').value.trim() || `${state.analysis.family} - Raqeem`;
    const transformed = colorizeFont(state.bytes, { mainColor: $('main-color').value, markColor: $('mark-color').value, familyName });
    state.output = transformed;
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(new Blob([transformed.bytes], { type: 'font/ttf' }));
    let style = document.getElementById('uploaded-font-face');
    if (!style) { style = document.createElement('style'); style.id = 'uploaded-font-face'; document.head.append(style); }
    const face = `@font-face{font-family:'RaqeemUploaded';src:url('${state.objectUrl}') format('${transformed.extension === 'otf' ? 'opentype' : 'truetype'}');font-display:swap}`;
    style.textContent = face;
    preview.style.fontFamily = "'RaqeemUploaded','Noto Naskh Arabic',serif";
    preview.style.color = $('main-color').value;
    $('preview-font-label').textContent = transformed.family;
    document.documentElement.style.setProperty('--mark-preview-color', $('mark-color').value);
    document.querySelector('.main-swatch').style.backgroundColor = $('main-color').value;
    document.querySelector('.mark-swatch').style.backgroundColor = $('mark-color').value;
    $('export-status').textContent = 'المعاينة جاهزة — تغييرات الألوان محفوظة في الملف عند التنزيل.';
    downloadButton.disabled = false;
  } catch (error) {
    state.output = null; downloadButton.disabled = true;
    $('export-status').textContent = error.message || 'تعذّر إعداد الملف.';
  }
}
function updatePreviewText() { preview.innerText = $('sample-text').value || 'اكتب نصًا لمعاينته'; }
function resetFile() {
  state.requestId += 1;
  clearTimeout(state.debounce);
  state.file = null; state.bytes = null; state.analysis = null; state.output = null;
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  $('file-summary').hidden = true; $('file-name').textContent = '—'; $('file-detail').textContent = '—';
  $('upload-title').textContent = 'اسحب ملف الخط إلى هنا'; $('upload-subtitle').textContent = 'أو اختره من جهازك — TTF أو OTF، حتى 32 ميغابايت';
  $('format-tag').textContent = 'TTF / OTF'; $('preview-status').classList.remove('is-ready'); $('preview-status').innerHTML = '<span class="status-dot"></span> بانتظار ملف';
  $('preview-font-label').textContent = 'معاينة حية'; preview.style.fontFamily = "'Noto Naskh Arabic',serif"; preview.style.color = 'var(--ink)';
  $('font-name').value = ''; $('export-status').textContent = ''; $('uploaded-font-face')?.remove();
  setReady(false); fileInput.value = '';
  setStatus('neutral', 'ارفع ملفًا لنفحص جداول الألوان والفصل بين جسم الحرف والعلامات.');
}
async function handleFile(file) {
  resetFile();
  const requestId = state.requestId;
  if (!file) return;
  state.file = file;
  $('file-name').textContent = file.name;
  $('file-detail').textContent = bytesLabel(file.size);
  $('file-summary').hidden = false;
  if (!/\.(ttf|otf)$/i.test(file.name)) { setStatus('error', 'اختر ملفًا امتداده TTF أو OTF.'); return; }
  if (file.size > MAX_FONT_BYTES) { setStatus('error', 'الحد الأقصى لحجم الملف 32 ميغابايت.'); return; }
  if (file.size < 64) { setStatus('error', 'الملف أصغر من أن يكون خطًا صالحًا.'); return; }
  setStatus('neutral', 'نفحص الجداول والأسماء في متصفحك…');
  await new Promise(resolve => setTimeout(resolve, 30));
  if (requestId !== state.requestId) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (requestId !== state.requestId) return;
    state.bytes = bytes;
    state.analysis = inspectFont(state.bytes);
    const suggested = `${state.analysis.family} - Raqeem`;
    $('font-name').value = suggested.slice(0, 80);
    $('format-tag').textContent = state.analysis.extension.toUpperCase();
    $('preview-status').classList.add('is-ready'); $('preview-status').innerHTML = '<span class="status-dot"></span> فصل واضح';
    $('preview-font-label').textContent = state.analysis.family;
    setReady(true);
    setStatus('success', `وجدنا طبقات منفصلة: ${state.analysis.foregroundLayers} طبقة لجسم الحروف، و${state.analysis.markLayers} طبقة للنقط/التشكيل والعلامات. يدعم الخط التلوين والتصدير.`);
    updateColorsAndPreview();
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.analysis = null; state.bytes = null; setReady(false);
    $('preview-status').classList.remove('is-ready'); $('preview-status').innerHTML = '<span class="status-dot"></span> غير مدعوم';
    setStatus('error', error.message || 'هذا الخط لا يدعم الفصل الآمن بين الحروف والعلامات.');
    $('export-status').textContent = '';
  }
}
function clickDownload() {
  if (!state.output) return;
  try {
    const result = colorizeFont(state.bytes, { mainColor: $('main-color').value, markColor: $('mark-color').value, familyName: $('font-name').value.trim() });
    validateColoredFont(result.bytes);
    const blob = new Blob([result.bytes], { type: result.extension === 'otf' ? 'font/otf' : 'font/ttf' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${result.filenameBase || 'Raqeem-Font'}-colored.${result.extension}`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    $('export-status').textContent = 'تم التحقق من جداول الخط وبدأ التنزيل.';
  } catch (error) { $('export-status').textContent = error.message || 'فشل التحقق من ملف التصدير.'; }
}

$('choose-file').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropzone.addEventListener('click', (e) => { if (e.target.closest('button')) return; fileInput.click(); });
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => handleFile(fileInput.files?.[0]));
$('remove-file').addEventListener('click', resetFile);
for (const [colorId, hexId] of [['main-color','main-hex'], ['mark-color','mark-hex']]) {
  $(colorId).addEventListener('input', () => { $(hexId).value = $(colorId).value.toUpperCase(); clearTimeout(state.debounce); state.debounce = setTimeout(updateColorsAndPreview, 80); });
  $(hexId).addEventListener('input', () => { const v = $(hexId).value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) { $(colorId).value = v; clearTimeout(state.debounce); state.debounce = setTimeout(updateColorsAndPreview, 80); } });
  $(hexId).addEventListener('blur', () => { if (!/^#[0-9a-f]{6}$/i.test($(hexId).value.trim())) $(hexId).value = $(colorId).value.toUpperCase(); });
}
$('font-name').addEventListener('input', () => { clearTimeout(state.debounce); state.debounce = setTimeout(updateColorsAndPreview, 120); });
$('sample-text').addEventListener('input', updatePreviewText);
downloadButton.addEventListener('click', clickDownload);
for (const event of ['dragenter','dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.add('is-over'); });
for (const event of ['dragleave','drop']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.remove('is-over'); });
dropzone.addEventListener('drop', e => { const file = e.dataTransfer?.files?.[0]; if (file) handleFile(file); });
window.addEventListener('beforeunload', () => { if (state.objectUrl) URL.revokeObjectURL(state.objectUrl); });
updatePreviewText();
setReady(false);

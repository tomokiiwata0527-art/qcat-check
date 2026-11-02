import { analyze, overlay, judge } from './analysis.js';
import { createStore } from './store.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存不可でも動作継続 */ } },
};
const RES = { pass: '合格', caution: '要確認', fail: '不合格' };
const SESS = { AM: '午前', PM: '午後' };
const pad = n => String(n).padStart(2, '0');
const today = () => new Date().toLocaleDateString('sv-SE');
const hhmm = iso => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dateJp = ymd => { const d = new Date(ymd + 'T00:00:00'); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`; };
const toBlob = (cv, type, q) => new Promise(r => cv.toBlob(r, type, q));

const APP_VERSION = '0.2.2';
const DEFAULT_PRESETS = ['二丁掛,60,227', '小口平,60,108', 'ボーダータイル(30),30,227', 'ボーダータイル(40),40,227', '45二丁,45,95', '50角,45,45'].join('\n');
const settings = { company: '', site: '', logo: '', footNote: '', tileW: 100, tileH: 260, pass: 60, caution: 65, margin: 7, ...LS.get('qcat.settings', {}) };
const store = createStore();
const S = { img: null, photo: null, photoBlob: null, pts: [], res: null, final: null, saving: false };

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// 画面内のコメント入力（ブラウザ標準のprompt()は使えない環境があるため）
function askComment(title, required) {
  return new Promise(resolve => {
    $('dlgTitle').textContent = title; $('dlgText').value = ''; $('dlgErr').textContent = '';
    $('dlg').hidden = false; $('dlgText').focus();
    const done = v => { $('dlg').hidden = true; $('dlgOk').onclick = $('dlgCancel').onclick = null; resolve(v); };
    $('dlgCancel').onclick = () => done(null);
    $('dlgOk').onclick = () => {
      const v = $('dlgText').value.trim();
      if (required && !v) { $('dlgErr').textContent = '入力してください'; return; }
      done(v);
    };
  });
}

// ================= 起動 =================
async function boot() {
  try { await store.init(); }
  catch (e) { $('banner').hidden = false; $('banner').textContent = '保存先の初期化に失敗しました：' + e.message; return; }
  if (store.mode === 'firebase' && !store.user) { $('login').hidden = false; return; }
  enter();
}
function enter() {
  $('login').hidden = true; $('app').hidden = false; $('tabs').hidden = false;
  const u = store.user;
  $('who').textContent = store.mode === 'firebase' ? `${u.email}${u.isAdmin ? '（管理者）' : ''}` : '端末内保存';
  if (store.mode === 'local') {
    $('banner').hidden = false;
    $('banner').textContent = '端末内保存モードです。データはこの端末のブラウザ内にだけ保存され、他の人とは共有されません（共有するにはFirebase設定が必要です）。';
  }
  $('logoutBtn').hidden = store.mode !== 'firebase';
  if (window.QCAT_TRIAL) {   // 公開試用版：印刷・ファイル保存が使えない環境のため非表示
    $('rPrint').hidden = true; document.querySelector('#tab-report details').hidden = true;
    $('banner').hidden = false; $('banner').textContent += '　【試用版】印刷/PDFとExcel出力は配布版で使えます。';
  }
  $('modeInfo').textContent = store.mode === 'firebase'
    ? `保存先：Firebase（共有）／ログイン中：${u.email}／権限：${u.isAdmin ? '管理者（無効化可）' : '一般（検査・閲覧）'}／版 ${APP_VERSION}`
    : '保存先：この端末のブラウザ内（共有なし）。ブラウザのデータを消去すると記録も失われます。';
  initForm();
}
$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  try { await store.signIn($('loginEmail').value.trim(), $('loginPw').value); enter(); }
  catch (e) { $('loginErr').textContent = 'ログインできません（' + (e.code || e.message) + '）'; }
};
$('logoutBtn').onclick = async () => { await store.signOut(); location.reload(); };

// ================= タブ =================
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
  if (b.dataset.tab === 'report') loadReport();
  window.scrollTo(0, 0);
});

// ================= 測定 =================
const FIELDS = ['fCrew', 'fLocation', 'fTile', 'fLot', 'fMeasurer', 'fTileW', 'fTileH'];
function parsePresets(txt) {
  return (txt || '').split('\n').map(l => l.split(/[,、，\t]/).map(s => s.trim())).filter(a => a.length >= 3 && +a[1] > 0 && +a[2] > 0)
    .map(a => ({ name: a[0], w: +a[1], h: +a[2] }));
}
function fillPresets() {
  const list = [{ name: `かまぼこ（${settings.tileW}×${settings.tileH}mm）`, w: settings.tileW, h: settings.tileH }, ...parsePresets(settings.presets ?? DEFAULT_PRESETS)];
  $('fPreset').innerHTML = list.map((p, i) => `<option value="${i}">${esc(p.name)}${i ? `（${p.w}×${p.h}mm）` : ''}</option>`).join('') + '<option value="x">その他（直接入力）</option>';
  $('fPreset')._list = list;
  syncPreset();
}
function syncPreset() {
  const w = +$('fTileW').value, h = +$('fTileH').value, l = $('fPreset')._list || [];
  const i = l.findIndex(p => p.w === w && p.h === h);
  $('fPreset').value = i >= 0 ? String(i) : 'x';
}
$('fPreset').onchange = () => {
  const p = ($('fPreset')._list || [])[+$('fPreset').value];
  if (p) { $('fTileW').value = p.w; $('fTileH').value = p.h; $('fTileW').dispatchEvent(new Event('change')); }
};
['fTileW', 'fTileH'].forEach(id => $(id).addEventListener('change', () => {
  syncPreset(); updatePickUI();
  if (S.img && S.pts.length === 4 && !$('resultPanel').hidden) runAnalysis();
}));
function initForm() {
  $('fDate').value = today();
  $('fSession').value = new Date().getHours() < 12 ? 'AM' : 'PM';
  const saved = LS.get('qcat.form', {});
  FIELDS.forEach(f => { $(f).value = saved[f] || ''; });
  if (!(+$('fTileW').value > 0 && +$('fTileH').value > 0)) { $('fTileW').value = settings.tileW; $('fTileH').value = settings.tileH; }
  $('rDate').value = today();
  $('xTo').value = today(); $('xFrom').value = today().slice(0, 8) + '01';
  fillSettings(); fillPresets();
}
const rememberForm = () => LS.set('qcat.form', Object.fromEntries(FIELDS.map(f => [f, $(f).value])));
FIELDS.forEach(f => $(f).addEventListener('change', rememberForm));

const optsNow = () => ({
  tileW: +$('fTileW').value || settings.tileW, tileH: +$('fTileH').value || settings.tileH, marginPct: settings.margin,
  thresholdPass: settings.pass, thresholdCaution: settings.caution, sensitivity: +$('sens').value,
});

async function loadFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const im = new Image(); im.src = url;
  try { await im.decode(); } catch { toast('画像を読み込めませんでした'); return; }
  let w = im.naturalWidth, h = im.naturalHeight;
  const k = Math.min(1, 2000 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(im, 0, 0, w, h);
  URL.revokeObjectURL(url);
  S.photo = c; S.img = c.getContext('2d').getImageData(0, 0, w, h);
  S.photoBlob = await toBlob(c, 'image/jpeg', 0.88);
  S.pts = []; S.res = null; S.final = null;
  $('resultPanel').hidden = true; $('sens').value = 0; $('sensVal').textContent = '0';
  $('pickerWrap').hidden = false;
  setupPicker(); drawPicker(); updatePickUI();
}
$('fFile').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };
$('fFile2').onchange = e => { loadFile(e.target.files[0]); e.target.value = ''; };

// ---- 四隅ピッカー ----
const cv = $('picker'), lp = $('loupe');
let scale = 1, drag = -1;
const NAMES = ['① 左上', '② 右上', '③ 右下', '④ 左下'];
function setupPicker() {
  cv.width = Math.min(S.img.width, 1000);
  cv.height = Math.round(S.img.height * cv.width / S.img.width);
  scale = cv.width / S.img.width;
  cv.style.maxWidth = '520px'; cv.style.margin = '0 auto';
}
function drawPicker() {
  const ctx = cv.getContext('2d');
  ctx.drawImage(S.photo, 0, 0, cv.width, cv.height);
  const rect = cv.getBoundingClientRect();
  const u = rect.width ? cv.width / rect.width : 1;   // CSS 1px あたりのキャンバスpx
  const P = S.pts.map(p => [p.x * scale, p.y * scale]);
  ctx.lineWidth = 2 * u; ctx.strokeStyle = '#ffe600';
  if (P.length > 1) {
    ctx.beginPath(); P.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    if (P.length === 4) ctx.closePath(); ctx.stroke();
  }
  P.forEach(([x, y], i) => {
    ctx.beginPath(); ctx.arc(x, y, 9 * u, 0, 7); ctx.fillStyle = 'rgba(255,60,60,.35)'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * u; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${15 * u}px sans-serif`; ctx.fillText(String(i + 1), x + 12 * u, y - 12 * u);
  });
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function geometryWarning() {
  if (S.pts.length < 4) return '';
  const [a, b, c, d] = S.pts;
  const cross = (p, q, r) => (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
  const cs = [cross(a, b, c), cross(b, c, d), cross(c, d, a), cross(d, a, b)];
  if (!(cs.every(v => v > 0) || cs.every(v => v < 0))) return '四隅の順番が違うか、交差しています。①左上→②右上→③右下→④左下の順に指定し直してください。';
  const ratio = ((dist(a, b) + dist(d, c)) / 2) / ((dist(a, d) + dist(b, c)) / 2);
  const tw = +$('fTileW').value || settings.tileW, th = +$('fTileH').value || settings.tileH;
  const exp = tw / th;
  if (ratio > exp * 1.35 || ratio < exp * 0.7) return `指定範囲の縦横比が規格(${tw}×${th}mm)と大きく異なります。短辺側から指定しているか、斜めから撮影していないか、タイルが欠けていないかを確認してください（このまま算定も可能ですが精度は落ちます）。`;
  return '';
}
function updatePickUI() {
  const n = S.pts.length;
  $('runBtn').disabled = n < 4;
  const w = geometryWarning();
  $('pickMsg').textContent = n < 4 ? `次にタップ：${NAMES[n]}（短辺側から時計回り）` : (w || '四隅OK。必要ならドラッグで微調整して「算定する」を押してください。');
  $('pickMsg').style.color = w ? '#b26a00' : '';
}
function posOf(e) {
  const r = cv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * cv.width / r.width) / scale, y: ((e.clientY - r.top) * cv.height / r.height) / scale };
}
function nearest(p) {
  const r = cv.getBoundingClientRect(), k = (cv.width / r.width) / scale; // CSS px → 画像px
  let best = -1, bd = 32 * k;
  S.pts.forEach((q, i) => { const d = dist(p, q); if (d < bd) { bd = d; best = i; } });
  return best;
}
function showLoupe(p) {
  lp.hidden = false;
  const ctx = lp.getContext('2d'), R = 24;       // 画像px で ±24 を 120px に拡大
  ctx.clearRect(0, 0, 120, 120);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(S.photo, p.x - R, p.y - R, R * 2, R * 2, 0, 0, 120, 120);
  ctx.strokeStyle = '#ff2d2d'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(60, 48); ctx.lineTo(60, 72); ctx.moveTo(48, 60); ctx.lineTo(72, 60); ctx.stroke();
  const left = p.x * scale < cv.width / 2;        // 指と重ならない側へ
  lp.style.left = left ? 'auto' : '8px'; lp.style.right = left ? '8px' : 'auto';
}
cv.addEventListener('pointerdown', e => {
  if (!S.img) return;
  e.preventDefault(); cv.setPointerCapture(e.pointerId);
  const p = posOf(e), n = nearest(p);
  if (n >= 0) drag = n;
  else if (S.pts.length < 4) { S.pts.push(p); drag = S.pts.length - 1; }
  else return;
  S.pts[drag] = p; drawPicker(); showLoupe(p);
});
cv.addEventListener('pointermove', e => {
  if (drag < 0) return;
  e.preventDefault(); const p = posOf(e); S.pts[drag] = p; drawPicker(); showLoupe(p);
});
const endDrag = () => { if (drag < 0) return; drag = -1; lp.hidden = true; drawPicker(); updatePickUI(); };
cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
$('resetPts').onclick = () => { S.pts = []; S.res = null; $('resultPanel').hidden = true; drawPicker(); updatePickUI(); };
window.addEventListener('resize', () => { if (S.img) drawPicker(); fitPaper(); });

// ---- 算定 ----
function setFinal(v) {
  S.final = v;
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setFinal(b.dataset.v));

function runAnalysis() {
  const o = optsNow();
  const res = analyze(S.img, S.pts.map(p => [p.x, p.y]), o);
  res.fillRounded = Math.floor(res.fillPct * 10) / 10;       // 安全側（切り捨て）で表示・判定
  res.result = judge(res.fillRounded, res.opts);
  S.res = res;
  const W = res.width, H = res.height;
  $('cvWarp').width = W; $('cvWarp').height = H;
  $('cvWarp').getContext('2d').putImageData(new ImageData(res.warped.data, W, H), 0, 0);
  const ov = overlay(res);
  $('cvOv').width = W; $('cvOv').height = H;
  $('cvOv').getContext('2d').putImageData(new ImageData(ov.data, W, H), 0, 0);
  $('tileSz').textContent = `${o.tileW}×${o.tileH}mm`;
  $('resBadge').innerHTML = `<span class="pct">${res.fillRounded.toFixed(1)}%</span><span class="badge ${res.result}">自動判定：${RES[res.result]}</span><span class="hint">接着率（基準 ${res.opts.thresholdPass}%以上）</span>`;
  const msgs = {
    caution: `基準は満たしていますが余裕が小さい範囲（${res.opts.thresholdPass}〜${res.opts.thresholdCaution}%）です。写真を確認して最終判定を選び、理由を備考に記入してください。`,
    fail: '基準未満です。写真を確認し、再測定するか最終判定を確定してください。',
    pass: '',
  };
  $('resNote').hidden = !msgs[res.result]; $('resNote').textContent = msgs[res.result];
  setFinal(res.result === 'caution' ? null : res.result);   // 要確認は検査者が選ぶ
  $('resultPanel').hidden = false;
}
function runWithSpinner() {
  $('runBtn').disabled = true; $('runBtn').textContent = '算定中…';
  setTimeout(() => {
    try { runAnalysis(); $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (e) { toast('算定に失敗しました：' + e.message); }
    $('runBtn').textContent = '算定する'; $('runBtn').disabled = S.pts.length < 4;
  }, 40);
}
$('runBtn').onclick = runWithSpinner;
let sensT;
$('sens').oninput = () => {
  $('sensVal').textContent = $('sens').value;
  clearTimeout(sensT); sensT = setTimeout(() => { if (S.img && S.pts.length === 4) runAnalysis(); }, 300);
};

// 検査写真：撮影画像のタイル周辺を切り出し、指定した四隅を黄色枠で示す
async function makeShot() {
  const xs = S.pts.map(p => p.x), ys = S.pts.map(p => p.y);
  const pad = 0.04 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x0 = Math.max(0, Math.min(...xs) - pad), y0 = Math.max(0, Math.min(...ys) - pad);
  const x1 = Math.min(S.img.width, Math.max(...xs) + pad), y1 = Math.min(S.img.height, Math.max(...ys) + pad);
  const k = Math.min(1, 640 / (y1 - y0));
  const c = document.createElement('canvas'); c.width = Math.round((x1 - x0) * k); c.height = Math.round((y1 - y0) * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(S.photo, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
  ctx.strokeStyle = '#ffe600'; ctx.lineWidth = 3;
  ctx.beginPath(); S.pts.forEach((p, i) => { const x = (p.x - x0) * k, y = (p.y - y0) * k; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke();
  return toBlob(c, 'image/jpeg', 0.88);
}

// ---- 保存 ----
$('saveBtn').onclick = async () => {
  if (!S.res || S.saving) return;
  const date = $('fDate').value;
  if (!date) { toast('施工日を入力してください'); return; }
  if (!$('fMeasurer').value.trim()) { toast('検査者を入力してください'); return; }
  if (!S.final) { toast('最終判定（合格／不合格）を選んでください'); return; }
  const r = S.res, remarks = $('fRemarks').value.trim();
  const autoFinal = r.result === 'caution' ? null : r.result;
  if (S.final !== autoFinal && !remarks) { toast('自動判定と異なる／要確認の場合は、備考に理由を記入してください', 4000); $('fRemarks').focus(); return; }
  S.saving = true; $('saveBtn').disabled = true; $('saveBtn').textContent = '保存中…';
  try {
    const o = r.opts;
    const rec = {
      id: crypto.randomUUID(), date, session: $('fSession').value,
      company: settings.company, site: settings.site, crew: $('fCrew').value.trim(),
      location: $('fLocation').value.trim(), tileModel: $('fTile').value.trim(),
      adhesiveLot: $('fLot').value.trim(), measurer: $('fMeasurer').value.trim(),
      fillPct: r.fillRounded, barePct: Math.round((100 - r.fillRounded) * 10) / 10,
      result: r.result, finalResult: S.final, remarks,
      corners: S.pts.map(p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),  // Firestoreは配列の入れ子不可のため {x,y}
      imageSize: [S.img.width, S.img.height],
      tileW: o.tileW, tileH: o.tileH, marginPct: o.marginPct, sensitivity: o.sensitivity,
      autoThreshold: r.autoThreshold, thresholdPass: o.thresholdPass, thresholdCaution: o.thresholdCaution,
      status: 'pending', createdAt: new Date().toISOString(), appVersion: APP_VERSION,
    };
    const imgs = { photo: S.photoBlob, shot: await makeShot(), overlay: await toBlob($('cvOv'), 'image/jpeg', 0.88) };
    await Promise.race([store.save(rec, imgs), new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), 60000))]);
    rememberForm();
    toast('保存しました（日報タブで確認できます）');
    S.img = null; S.photo = null; S.pts = []; S.res = null; S.final = null;
    $('fRemarks').value = '';
    $('pickerWrap').hidden = true; $('resultPanel').hidden = true;
    $('rDate').value = date; calMarks.clear();
    window.scrollTo(0, 0);
  } catch (e) {
    const c = e.code || e.message || '';
    const hint = /storage\/(unauthorized|retry-limit|unknown|bucket)|timeout/.test(c) ? '（写真の送信に失敗。Storageの設定・ルールを確認してください）' : /permission-denied/.test(c) ? '（Firestoreのルール未公開の可能性）' : '';
    toast('保存に失敗しました：' + c + hint + `（v${APP_VERSION}）`, 10000);
  } finally {
    S.saving = false; $('saveBtn').disabled = false; $('saveBtn').textContent = 'この結果を保存';
  }
};

// ================= 日報（A4横の検査記録） =================
function fitPaper() {
  const wrap = $('paperWrap'), paper = $('paper');
  if (!wrap || !paper || wrap.offsetParent === null) return;
  paper.style.transform = 'none'; wrap.style.height = 'auto';
  const k = Math.min(1, wrap.clientWidth / paper.offsetWidth);
  paper.style.transform = `scale(${k})`;
  wrap.style.height = Math.ceil(paper.offsetHeight * k) + 'px';
}
const finalCls = f => f === 'pass' ? 'ok' : f === 'fail' ? 'ng' : 'wn';
const finalTxt = f => f ? RES[f] : '未確定';
let currentRecs = [];

// ---- 記録の有無が分かるカレンダー（記録のある日は日付の下に丸印、選択日は●白抜き文字） ----
const calMarks = new Map();           // 'YYYY-MM' -> Map(date -> {n, fail})
let calYM = null;                     // 表示中の月 {y, m}
const p2 = n => String(n).padStart(2, '0');
async function drawCal(force) {
  const box = $('cal'); if (!box) return;
  if (!calYM) { const [y, m] = ($('rDate').value || today()).split('-').map(Number); calYM = { y, m }; }
  const { y, m } = calYM, key = `${y}-${p2(m)}`;
  const paint = () => {
    const marks = calMarks.get(key) || new Map(), sel = $('rDate').value, td = today();
    const first = new Date(y, m - 1, 1).getDay(), days = new Date(y, m, 0).getDate();
    let h = `<div class="calHead"><button type="button" id="calPrev" aria-label="前の月">‹</button><b>${y}年${m}月</b><button type="button" id="calNext" aria-label="次の月">›</button></div><div class="calGrid">`;
    '日月火水木金土'.split('').forEach((w, i) => { h += `<div class="calW${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${w}</div>`; });
    for (let i = 0; i < first; i++) h += '<div></div>';
    for (let d = 1; d <= days; d++) {
      const ds = `${key}-${p2(d)}`, mk = marks.get(ds), dow = (first + d - 1) % 7;
      h += `<button type="button" class="calD${ds === sel ? ' sel' : ''}${ds === td ? ' today' : ''}${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}" data-d="${ds}"><span class="n">${d}</span><span class="dot${mk ? (mk.fail ? ' ng' : ' on') : ''}"></span></button>`;
    }
    box.innerHTML = h + '</div>';
    $('calPrev').onclick = () => { calYM = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; drawCal(); };
    $('calNext').onclick = () => { calYM = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; drawCal(); };
    box.querySelectorAll('.calD').forEach(b => b.onclick = () => { $('rDate').value = b.dataset.d; loadReport(); });
  };
  paint();
  if (force || !calMarks.has(key)) {
    try {
      const recs = await store.list(`${key}-01`, `${key}-31`), mp = new Map();
      recs.filter(r => r.status !== 'retake').forEach(r => {
        const o = mp.get(r.date) || { n: 0, fail: false }; o.n++; if (r.finalResult === 'fail') o.fail = true; mp.set(r.date, o);
      });
      calMarks.set(key, mp); paint();
    } catch { /* 読み込み失敗は日報側のメッセージに任せる */ }
  }
}

async function loadReport() {
  const d = $('rDate').value || today();
  { const [y, m] = d.split('-').map(Number); calYM = { y, m }; drawCal(); }
  try { currentRecs = await store.list(d, d); }
  catch (e) { $('paper').innerHTML = `<div class="emptyRow">読み込みに失敗しました：${esc(e.code || e.message)}</div>`; fitPaper(); return; }
  const valid = currentRecs.filter(r => r.status !== 'retake');
  const invalid = currentRecs.filter(r => r.status === 'retake');
  const n = s => valid.filter(r => r.session === s).length;
  const fails = valid.filter(r => r.finalResult === 'fail').length;
  const undecided = valid.filter(r => !r.finalResult).length;
  let overall;
  if (!valid.length) overall = '<span class="gr">検査なし</span>';
  else if (undecided) overall = `<span class="wn">未確定あり（${undecided}件）</span>`;
  else if (fails) overall = `<span class="ng">不合格あり（${fails}件）</span>`;
  else overall = '<span class="ok">全件合格</span>';

  const logo = settings.logo ? `<img src="${esc(settings.logo)}" alt="">` : 'ロゴ';
  const rows = valid.map((r, i) => `<tr data-id="${esc(r.id)}">
      <td>${i + 1}</td><td>${SESS[r.session]}</td><td>${esc(hhmm(r.createdAt))}</td><td>${esc(r.crew)}</td><td>${esc(r.location)}</td><td>${esc(r.tileModel)}</td>
      <td class="pct">${Number(r.fillPct).toFixed(1)}%</td>
      <td class="${r.result === 'pass' ? 'ok' : r.result === 'fail' ? 'ng' : 'wn'}">${RES[r.result]}</td>
      <td class="${finalCls(r.finalResult)}">${finalTxt(r.finalResult)}</td>
      <td>${esc(r.measurer)}</td>
      <td><img data-k="shot" alt="検査写真"></td><td><img data-k="overlay" alt="解析結果"></td>
      <td class="rm">${esc(r.remarks)}</td></tr>`).join('');
  const base = '※接着率は、タイル裏面の撮影画像から接着剤が付着している面積の割合を画像解析で算出した値です。最終判定は検査者が写真で確認のうえ確定しています。';
  const first = valid[0] || {};
  $('paper').innerHTML = `
    <div class="ph">
      <div class="phl"><div class="logo">${logo}</div>
        <div class="phi">
          <div class="ttl">外装タイル 有機系接着剤 充填率検査記録（Q-CAT）</div>
          <div>${esc(settings.company || '（会社名・工事所名）')}</div>
          <div>工事名：${esc(settings.site)}</div>
          <div>施工日：${esc(dateJp(d))}　合格基準：接着率 ${first.thresholdPass ?? settings.pass}% 以上</div>
          <div>検査件数：午前 ${n('AM')}件 / 午後 ${n('PM')}件　総合：${overall}</div>
        </div></div>
      <table class="sign"><tr><th>検査者</th><th>確認者</th><th>主任者</th></tr><tr><td></td><td></td><td></td></tr></table>
    </div>
    <table class="sheet">
      <colgroup><col style="width:4%"><col style="width:5%"><col style="width:6.5%"><col style="width:5%"><col style="width:11%"><col style="width:5.5%"><col style="width:7%"><col style="width:6.5%"><col style="width:6.5%"><col style="width:5.5%"><col style="width:13%"><col style="width:13%"><col style="width:11.5%"></colgroup>
      <thead><tr><th>No.</th><th>時間帯</th><th>検査時刻</th><th>張り手</th><th>施工箇所</th><th>タイル</th><th>接着率</th><th>自動判定</th><th>最終判定</th><th>検査者</th><th>検査写真</th><th>解析結果</th><th>備考</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${valid.length ? '' : '<div class="emptyRow">この日の検査記録はありません</div>'}
    <div class="foot">${esc(base)}${invalid.length ? `無効（再測定）${invalid.length}件は集計から除外しています。` : ''}${esc(settings.footNote)}</div>`;
  $('paper').querySelectorAll('tr[data-id]').forEach(tr => {
    const rec = valid.find(x => x.id === tr.dataset.id);
    tr.querySelectorAll('img[data-k]').forEach(img => {
      img.onload = fitPaper;
      store.imageUrl(rec, img.dataset.k).then(u => { img.src = u; }).catch(() => { img.alt = '取得不可'; });
    });
  });
  fitPaper();
  renderRowActions(valid, invalid);
}

function renderRowActions(valid, invalid) {
  const box = $('rowActions');
  const admin = store.user && store.user.isAdmin;
  box.hidden = !(admin && (valid.length || invalid.length));
  if (box.hidden) return;
  box.innerHTML = `<h3>記録の無効化（管理者）</h3><div class="hint">誤撮影や再測定の場合に無効にします。記録は削除されず、帳票の集計から除外されます。</div>
    ${valid.map((r, i) => `<div class="ra"><span>No.${i + 1}　${SESS[r.session]} ${esc(hhmm(r.createdAt))}　${esc(r.location) || '－'}　${Number(r.fillPct).toFixed(1)}%</span><button data-id="${esc(r.id)}">無効にする</button></div>`).join('')}
    ${invalid.map(r => `<div class="ra"><small>無効：${SESS[r.session]} ${esc(hhmm(r.createdAt))}　${Number(r.fillPct).toFixed(1)}%　理由：${esc(r.reviewComment || '')}</small></div>`).join('')}`;
  box.querySelectorAll('button[data-id]').forEach(b => b.onclick = () => invalidate(valid.find(x => x.id === b.dataset.id)));
}
async function invalidate(rec) {
  const comment = await askComment('無効にする理由（必須）', true);
  if (comment === null) return;
  try {
    await store.review(rec.id, { status: 'retake', reviewComment: comment, reviewedBy: store.mode === 'local' ? 'この端末' : store.user.email, reviewedAt: new Date().toISOString() });
    toast('無効にしました'); calMarks.clear(); loadReport();
  } catch (e) { toast('更新に失敗しました：' + (e.code || e.message), 5000); }
}
$('rReload').onclick = () => { calMarks.clear(); loadReport(); };
$('rDate').onchange = loadReport;
$('rPrint').onclick = async () => {
  await loadReport();
  const imgs = [...document.querySelectorAll('#paper img')];
  await Promise.all(imgs.map(i => i.complete && i.src ? 1 : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  window.print();
};

// ---- Excel出力 ----
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
$('xBtn').onclick = async () => {
  const from = $('xFrom').value, to = $('xTo').value;
  if (!from || !to || from > to) { toast('期間を正しく指定してください'); return; }
  let recs;
  try { recs = await store.list(from, to); } catch (e) { toast('取得に失敗しました：' + (e.code || e.message)); return; }
  if (!recs.length) { toast('この期間の記録がありません'); return; }
  const head = ['施工日', 'No.', '時間帯', '検査時刻', '張り手', '施工箇所', 'タイル', '接着率(%)', '自動判定', '最終判定', '検査者', '備考',
    '工事名', '接着剤ロット', '合格基準(%)', '要確認上限(%)', '外周除外(%)', '感度', '自動閾値', '四隅座標(px)', '画像サイズ(px)', '記録状態', '無効の理由'];
  const perDay = {};
  const rows = recs.map(r => {
    const valid = r.status !== 'retake';
    const no = valid ? (perDay[r.date] = (perDay[r.date] || 0) + 1) : '';
    return [r.date, no, SESS[r.session], hhmm(r.createdAt), r.crew || '', r.location, r.tileModel, r.fillPct, RES[r.result], r.finalResult ? RES[r.finalResult] : '未確定', r.measurer, r.remarks || '',
      r.site || '', r.adhesiveLot, r.thresholdPass, r.thresholdCaution, r.marginPct, r.sensitivity, r.autoThreshold, JSON.stringify(r.corners), (r.imageSize || []).join('×'),
      valid ? '有効' : '無効（再測定）', r.reviewComment || ''];
  });
  const name = `充填率検査記録_${from}_${to}`;
  try {
    await loadScript('vendor/xlsx.full.min.js');
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    ws['!cols'] = head.map((h, i) => ({ wch: i === 19 ? 40 : i === 5 || i === 11 ? 22 : Math.max(8, h.length * 2) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '検査記録');
    XLSX.writeFile(wb, name + '.xlsx');
  } catch {
    const csv = '﻿' + [head, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = name + '.csv'; a.click();
    toast('Excelライブラリを読み込めなかったためCSVで出力しました');
  }
};

// ================= 設定 =================
function showLogo() {
  $('logoPrev').hidden = !settings.logo; $('logoClear').hidden = !settings.logo;
  if (settings.logo) $('logoPrev').src = settings.logo;
}
function fillSettings() {
  $('sCompany').value = settings.company; $('sSite').value = settings.site; $('sFootNote').value = settings.footNote;
  $('sTileW').value = settings.tileW; $('sTileH').value = settings.tileH; $('sPresets').value = settings.presets ?? DEFAULT_PRESETS;
  $('sPass').value = settings.pass; $('sCaution').value = settings.caution; $('sMargin').value = settings.margin;
  showLogo();
}
$('sLogo').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const url = URL.createObjectURL(f), im = new Image(); im.src = url;
  try { await im.decode(); } catch { toast('画像を読み込めませんでした'); return; }
  const k = Math.min(1, 320 / im.naturalWidth, 160 / im.naturalHeight);
  const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
  settings.logo = c.toDataURL('image/png'); LS.set('qcat.settings', settings); showLogo(); toast('ロゴを設定しました');
};
$('logoClear').onclick = () => { settings.logo = ''; LS.set('qcat.settings', settings); $('sLogo').value = ''; showLogo(); };
$('sSave').onclick = () => {
  const v = {
    company: $('sCompany').value.trim(), site: $('sSite').value.trim(), footNote: $('sFootNote').value.trim(),
    tileW: +$('sTileW').value, tileH: +$('sTileH').value, presets: $('sPresets').value.trim(),
    pass: +$('sPass').value, caution: +$('sCaution').value, margin: +$('sMargin').value,
  };
  if (!(v.tileW > 0 && v.tileH > 0) || v.pass < 0 || v.caution < v.pass || v.margin < 0 || v.margin > 20) { toast('設定値を確認してください'); return; }
  Object.assign(settings, v); LS.set('qcat.settings', settings); fillPresets(); toast('設定を保存しました');
};

boot();

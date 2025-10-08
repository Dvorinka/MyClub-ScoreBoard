let state = {};

// Derive 3-letter uppercase abbreviation similar to backend makeShort()
function deriveShort(name) {
  if (!name) return '---';
  let s = ('' + name).trim().toUpperCase();
  if (!s) return '---';
  const map = new Map([
    ['Á','A'],['Ä','A'],['Å','A'],['Â','A'],['À','A'],
    ['Č','C'],['Ć','C'],['Ç','C'],
    ['Ď','D'],
    ['É','E'],['Ě','E'],['È','E'],['Ë','E'],['Ê','E'],
    ['Í','I'],['Ì','I'],['Ï','I'],['Î','I'],
    ['Ň','N'],['Ń','N'],
    ['Ó','O'],['Ö','O'],['Ô','O'],['Ò','O'],
    ['Ř','R'],
    ['Š','S'],['Ś','S'],
    ['Ť','T'],
    ['Ú','U'],['Ů','U'],['Ù','U'],['Ü','U'],['Û','U'],
    ['Ý','Y'],
    ['Ž','Z'],
  ]);
  let out = '';
  for (const ch of s) {
    let c = ch;
    if (map.has(ch)) c = map.get(ch);
    if (c >= 'A' && c <= 'Z') {
      out += c;
      if (out.length === 3) break;
    }
  }
  while (out.length < 3) out += '-';
  return out;
}

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  // Ensure fouls present
  if (typeof state.homeFouls !== 'number' || isNaN(state.homeFouls)) state.homeFouls = 0;
  if (typeof state.awayFouls !== 'number' || isNaN(state.awayFouls)) state.awayFouls = 0;
  state.homeFouls = Math.max(0, Math.min(5, state.homeFouls));
  state.awayFouls = Math.max(0, Math.min(5, state.awayFouls));
  // Derive short codes if missing on load
  let changed = false;
  if (!state.homeShort || !state.homeShort.trim()) {
    state.homeShort = deriveShort(state.homeName || '');
    changed = true;
  }
  if (!state.awayShort || !state.awayShort.trim()) {
    state.awayShort = deriveShort(state.awayName || '');
    changed = true;
  }
  updateInputs();
  if (changed) {
    saveState();
  }
  // If logos exist but colors are missing, try to derive
  tryAutoColorsFromLogos();
}

function updateInputs() {
  const hn = document.getElementById("homeName");
  const an = document.getElementById("awayName");
  const hl = document.getElementById("homeLogo");
  const al = document.getElementById("awayLogo");
  const half = document.getElementById("halfLength");
  if (hn) hn.value = state.homeName;
  if (an) an.value = state.awayName;
  if (hl) hl.value = state.homeLogo;
  if (al) al.value = state.awayLogo;
  if (half) half.value = state.halfLength;
  const themeEl = document.getElementById("theme");
  if (themeEl) themeEl.value = state.theme || "classic";
  const hs = document.getElementById("homeShort");
  const as = document.getElementById("awayShort");
  if (hs) {
    hs.value = state.homeShort || "";
    // if empty, mark auto mode so name changes will populate it
    hs.dataset.auto = hs.value ? 'false' : 'true';
  }
  if (as) {
    as.value = state.awayShort || "";
    as.dataset.auto = as.value ? 'false' : 'true';
  }
  const pc = document.getElementById("primaryColor");
  const sc = document.getElementById("secondaryColor");
  if (pc && state.primaryColor) pc.value = toColorInput(state.primaryColor);
  if (sc && state.secondaryColor) sc.value = toColorInput(state.secondaryColor);

  // QR schedule inputs
  const qe = document.getElementById('qrEvery');
  const qd = document.getElementById('qrDuration');
  if (qe) qe.value = (state.qrEvery && state.qrEvery > 0) ? state.qrEvery : (state.QRShowEveryMinutes || 5);
  if (qd) qd.value = (state.qrDuration && state.qrDuration > 0) ? state.qrDuration : (state.QRShowDurationSeconds || 60);
}

// Attempt to auto-derive colors from logos if present
async function tryAutoColorsFromLogos() {
  const needHome = !state.primaryColor && state.homeLogo;
  const needAway = !state.secondaryColor && state.awayLogo;
  if (!needHome && !needAway) return;
  if (needHome) {
    const col = await dominantColorFromImage(state.homeLogo).catch(() => null);
    if (col) {
      state.primaryColor = col;
      const pc = document.getElementById('primaryColor');
      if (pc) pc.value = toColorInput(col);
    }
  }
  if (needAway) {
    const col = await dominantColorFromImage(state.awayLogo).catch(() => null);
    if (col) {
      state.secondaryColor = col;
      const sc = document.getElementById('secondaryColor');
      if (sc) sc.value = toColorInput(col);
    }
  }
  if (needHome || needAway) saveState();
}

// Compute a simple dominant color (average over downscaled pixels). Returns hex string like #RRGGBB
function dominantColorFromImage(url) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    const img = new Image();
    // Try to request CORS-enabled; if the server allows it, canvas won't be tainted
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const maxDim = 64; // downscale for speed
        const ratio = Math.max(img.width, img.height) / maxDim || 1;
        const w = Math.max(1, Math.round(img.width / ratio));
        const h = Math.max(1, Math.round(img.height / ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i+3];
          if (alpha < 32) continue; // skip near-transparent
          r += data[i];
          g += data[i+1];
          b += data[i+2];
          count++;
        }
        if (!count) return resolve(null);
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
        const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
        resolve(hex);
      } catch (e) {
        // Likely a CORS-tainted canvas
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function saveState() {
  fetch("/api/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
}

// Export current state to JSON file
async function exportToFile() {
  try {
    const res = await fetch('/api/export');
    if (!res.ok) throw new Error('Request failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `scoreboard-state-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export se nezdařil');
  }
}

function addGoal(team) {
  if (team === "home") state.homeScore++;
  if (team === "away") state.awayScore++;
  saveState();
}

function resetScores() {
  state.homeScore = 0;
  state.awayScore = 0;
  saveState();
}

function removeGoal(team) {
  if (team === "home") state.homeScore = Math.max(0, (state.homeScore || 0) - 1);
  if (team === "away") state.awayScore = Math.max(0, (state.awayScore || 0) - 1);
  saveState();
}

// --- Fouls helpers ---
function addFoul(team) {
  if (team === 'home') state.homeFouls = Math.min(5, (state.homeFouls || 0) + 1);
  if (team === 'away') state.awayFouls = Math.min(5, (state.awayFouls || 0) + 1);
  saveState();
}
function removeFoul(team) {
  if (team === 'home') state.homeFouls = Math.max(0, (state.homeFouls || 0) - 1);
  if (team === 'away') state.awayFouls = Math.max(0, (state.awayFouls || 0) - 1);
  saveState();
}
function setFouls(team, count) {
  const v = Math.max(0, Math.min(5, Number(count||0)));
  if (team === 'home') state.homeFouls = v;
  if (team === 'away') state.awayFouls = v;
  saveState();
}

async function startTimer() {
  await fetch('/api/timer/start', { method: 'POST' });
}

async function pauseTimer() {
  await fetch('/api/timer/pause', { method: 'POST' });
}

async function resetTimer() {
  await fetch('/api/timer/reset', { method: 'POST' });
}

// Swap teams and scores (also names, logos, shorts, colors)
async function swapSides() {
  try {
    const res = await fetch('/api/swapSides', { method: 'POST' });
    if (!res.ok) throw new Error('swap failed');
    await loadState();
  } catch (e) {
    alert('Prohození stran se nezdařilo');
  }
}

// Start second half: swaps sides, resets timer to 00:00 and starts running
async function startSecondHalf() {
  try {
    const res = await fetch('/api/timer/secondHalf', { method: 'POST' });
    if (!res.ok) throw new Error('second half failed');
    await loadState();
  } catch (e) {
    alert('Start 2. poločasu se nezdařil');
  }
}

// při změně inputů rovnou aktualizujeme stav
document.querySelectorAll("input").forEach(inp => {
  inp.addEventListener("input", (e) => {
    const id = e.target.id;
    if (id === "homeName" || id === "awayName" || id === "homeLogo" || id === "awayLogo") {
      state[id] = e.target.value;
      // If logo changed, try deriving colors for that side
      if (id === 'homeLogo' && state.homeLogo) {
        dominantColorFromImage(state.homeLogo).then(col => {
          if (!col) return;
          state.primaryColor = col;
          const pc = document.getElementById('primaryColor');
          if (pc) pc.value = toColorInput(col);
          saveState();
        });
      }
      if (id === 'awayLogo' && state.awayLogo) {
        dominantColorFromImage(state.awayLogo).then(col => {
          if (!col) return;
          state.secondaryColor = col;
          const sc = document.getElementById('secondaryColor');
          if (sc) sc.value = toColorInput(col);
          saveState();
        });
      }
      // when team name changes and short code field is empty or in auto mode, auto-fill locally
      if (id === "homeName") {
        const hs = document.getElementById('homeShort');
        if (hs && (hs.dataset.auto === 'true' || !hs.value)) {
          const val = deriveShort(e.target.value);
          hs.value = val;
          hs.dataset.auto = 'true';
          state.homeShort = val;
        }
      }
      if (id === "awayName") {
        const as = document.getElementById('awayShort');
        if (as && (as.dataset.auto === 'true' || !as.value)) {
          const val = deriveShort(e.target.value);
          as.value = val;
          as.dataset.auto = 'true';
          state.awayShort = val;
        }
      }
    }
    if (id === "halfLength") state.halfLength = parseInt(e.target.value);
    if (id === "homeShort") {
      const raw = (e.target.value || "").toUpperCase().slice(0,3);
      if (raw.trim() === "") {
        // switch back to auto mode and derive from current name
        e.target.dataset.auto = 'true';
        const val = deriveShort(state.homeName || '');
        e.target.value = val;
        state.homeShort = val;
      } else {
        e.target.dataset.auto = 'false';
        state.homeShort = raw;
      }
    }
    if (id === "awayShort") {
      const raw = (e.target.value || "").toUpperCase().slice(0,3);
      if (raw.trim() === "") {
        e.target.dataset.auto = 'true';
        const val = deriveShort(state.awayName || '');
        e.target.value = val;
        state.awayShort = val;
      } else {
        e.target.dataset.auto = 'false';
        state.awayShort = raw;
      }
    }
    if (id === "primaryColor") state.primaryColor = e.target.value;
    if (id === "secondaryColor") state.secondaryColor = e.target.value;
    if (id === 'qrEvery') {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v) && v > 0) state.qrEvery = v;
    }
    if (id === 'qrDuration') {
      const v = parseInt(e.target.value, 10);
      if (!isNaN(v) && v > 0) state.qrDuration = v;
    }
    saveState();
  });
});

// also listen to theme <select>
const themeSelect = document.getElementById('theme');
if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    state.theme = e.target.value;
    saveState();
  });
}

loadState();

// Import dat z JSON souboru
async function importFromFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/import', {
    method: 'POST',
    body: form
  });
  if (!res.ok) {
    alert('Import se nezdařil');
    return;
  }
  await loadState();
}

function toColorInput(val){
  // ensure hex format for <input type="color">
  if (!val) return '#000000';
  if (val.startsWith('#') && (val.length === 7 || val.length === 4)) return val;
  // simple named colors or rgb() not supported by color input; fallback
  return '#000000';
}

// --- Server persistence helpers (Admin only) ---
async function refreshSavesList() {
  const sel = document.getElementById('savesList');
  if (!sel) return; // not on admin page
  sel.innerHTML = '';
  try {
    const res = await fetch('/api/saves');
    if (!res.ok) throw new Error('bad');
    const arr = await res.json();
    for (const name of arr) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch (e) {
    // ignore
  }
}

async function saveToServer() {
  const inp = document.getElementById('saveFilename');
  const filename = inp ? (inp.value || '').trim() : '';
  await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  });
  refreshSavesList();
}

async function loadFromServer() {
  const sel = document.getElementById('savesList');
  if (!sel || !sel.value) { alert('Vyberte soubor'); return; }
  const name = sel.value;
  const res = await fetch('/api/load?filename=' + encodeURIComponent(name), { method: 'POST' });
  if (!res.ok) { alert('Načtení se nepodařilo'); return; }
  await loadState();
}

// Populate saves list if present
refreshSavesList();

// Ensure functions are available globally for inline onclick handlers
// This helps in environments where script execution order or scoping is altered (e.g., Cloudflare optimizations)
window.addGoal = addGoal;
window.removeGoal = removeGoal;
window.resetScores = resetScores;
window.startTimer = startTimer;
window.pauseTimer = pauseTimer;
window.resetTimer = resetTimer;
window.swapSides = swapSides;
window.startSecondHalf = startSecondHalf;
window.importFromFile = importFromFile;
window.exportToFile = exportToFile;
window.saveToServer = saveToServer;
window.loadFromServer = loadFromServer;
window.addFoul = addFoul;
window.removeFoul = removeFoul;
window.setFouls = setFouls;

// Fallback bindings: if inline handlers are stripped or blocked, bind events via JS
// We skip elements that still have an inline onclick to avoid double actions
document.addEventListener('DOMContentLoaded', () => {
  const bindIfNoInline = (selector, handler) => {
    document.querySelectorAll(selector).forEach(el => {
      if (el.hasAttribute('onclick')) return; // inline present; let it handle
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { handler(e); } catch {}
      });
    });
  };

  bindIfNoInline("button[onclick*=\"addGoal('home')\"]", () => addGoal('home'));
  bindIfNoInline("button[onclick*=\"addGoal('away')\"]", () => addGoal('away'));
  bindIfNoInline("button[onclick*=\"removeGoal('home')\"]", () => removeGoal('home'));
  bindIfNoInline("button[onclick*=\"removeGoal('away')\"]", () => removeGoal('away'));
  bindIfNoInline("button[onclick*=\"resetScores()\"]", () => resetScores());

  bindIfNoInline("button[onclick*=\"addFoul('home')\"]", () => addFoul('home'));
  bindIfNoInline("button[onclick*=\"addFoul('away')\"]", () => addFoul('away'));
  bindIfNoInline("button[onclick*=\"removeFoul('home')\"]", () => removeFoul('home'));
  bindIfNoInline("button[onclick*=\"removeFoul('away')\"]", () => removeFoul('away'));
  // Tap dots fallback
  document.querySelectorAll('[onclick^="setFouls("]').forEach(el => {
    if (el.hasAttribute('onclick')) return;
    // not expected, but keep for completeness
  });

  bindIfNoInline("button[onclick*=\"startTimer()\"]", () => startTimer());
  bindIfNoInline("button[onclick*=\"pauseTimer()\"]", () => pauseTimer());
  bindIfNoInline("button[onclick*=\"resetTimer()\"]", () => resetTimer());

  bindIfNoInline("button[onclick*=\"swapSides()\"]", () => swapSides());
  bindIfNoInline("button[onclick*=\"startSecondHalf()\"]", () => startSecondHalf());

  // Initialize sponsors admin section if present
  try { refreshSponsorsAdmin(); } catch {}
  try { refreshQRPreview(); } catch {}
});

// --- Sponsors & QR admin helpers ---
async function refreshSponsorsAdmin() {
  const container = document.getElementById('sponsorsList');
  if (!container) return; // not on admin page
  container.innerHTML = '';
  try {
    const res = await fetch('/api/sponsors');
    if (!res.ok) throw new Error('bad');
    const list = await res.json();
    if (!Array.isArray(list)) return;
    for (const url of list) {
      const name = (url.split('/').pop() || '').trim();
      const card = document.createElement('div');
      card.className = 'sponsor-item';
      const img = document.createElement('img');
      img.src = url; img.alt = name;
      const btn = document.createElement('button');
      btn.textContent = 'Smazat';
      btn.addEventListener('click', async () => {
        try {
          await fetch('/api/sponsors/delete?name=' + encodeURIComponent(name), { method: 'POST' });
          refreshSponsorsAdmin();
        } catch {}
      });
      card.appendChild(img);
      card.appendChild(btn);
      container.appendChild(card);
    }
  } catch {}
}

async function uploadSponsorsFromInput() {
  const inp = document.getElementById('sponsorFiles');
  if (!inp || !inp.files || inp.files.length === 0) return;
  const fd = new FormData();
  Array.from(inp.files).forEach(f => fd.append('files', f));
  await fetch('/api/sponsors/upload', { method: 'POST', body: fd });
  inp.value = '';
  refreshSponsorsAdmin();
}

async function refreshQRPreview() {
  const img = document.getElementById('qrPreview');
  if (!img) return;
  try {
    const res = await fetch('/api/qr');
    if (!res.ok) throw new Error('bad');
    const j = await res.json();
    img.src = j && j.qr ? j.qr : '';
  } catch {
    img.removeAttribute('src');
  }
}

async function uploadQRFromInput() {
  const inp = document.getElementById('qrFile');
  if (!inp || !inp.files || !inp.files[0]) return;
  const fd = new FormData();
  fd.append('file', inp.files[0]);
  await fetch('/api/qr/upload', { method: 'POST', body: fd });
  inp.value = '';
  refreshQRPreview();
}

// expose for inline handlers
window.uploadSponsorsFromInput = uploadSponsorsFromInput;
window.uploadQRFromInput = uploadQRFromInput;

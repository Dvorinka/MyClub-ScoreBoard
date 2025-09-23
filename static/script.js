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

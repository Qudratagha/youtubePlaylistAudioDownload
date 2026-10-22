// Playlist Saver front end. Plain ES module, no build step; talks to app.py.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  },
};

const RUNNING = new Set(['running', 'cancelling']);
const TABS = { all: 'All', active: 'In progress', done: 'Done', failed: 'Failed' };
const CHIPS = {
  running: ['Downloading', 'run'],
  cancelling: ['Stopping', ''],
  done: ['Complete', 'ok'],
  partial: ['Partly done', 'warn'],
  failed: ['Failed', 'bad'],
  cancelled: ['Stopped', ''],
};

const state = {
  status: null,
  preview: null,
  pad: 2,
  selected: new Set(),
  lastClicked: null,
  options: { format: 'mp3', quality: 192, videoQuality: 720, embed: true, ...store.get('options', {}) },
  jobs: new Map(),
  expanded: new Set(),
  trackTab: new Map(),
};

const el = {
  form: $('#fetch-form'),
  url: $('#url'),
  fetchBtn: $('#fetch-btn'),
  paste: $('#paste-btn'),
  fetchError: $('#fetch-error'),
  preview: $('#preview'),
  jobs: $('#jobs'),
  jobsEmpty: $('#jobs-empty'),
  jobsCount: $('#jobs-count'),
  ffmpeg: $('#ffmpeg-warning'),
  restart: $('#restart-warning'),
  dir: $('#download-dir'),
  engine: $('#engine'),
  conn: $('#conn'),
  theme: $('#theme-toggle'),
  toasts: $('#toasts'),
  dialog: $('#remove-dialog'),
  rmName: $('#rm-name'),
  rmFiles: $('#rm-files'),
  rmConfirm: $('#rm-confirm'),
  player: $('#player'),
  plCover: $('#pl-cover'),
  plTitle: $('#pl-title'),
  plSub: $('#pl-sub'),
  plPrev: $('#pl-prev'),
  plPlay: $('#pl-play'),
  plNext: $('#pl-next'),
  plClose: $('#pl-close'),
  plCur: $('#pl-cur'),
  plDur: $('#pl-dur'),
  plSeek: $('#pl-seek'),
  plVideo: $('#pl-video'),
  plFull: $('#pl-full'),
  settingsBtn: $('#settings-btn'),
  settings: $('#settings-dialog'),
  setSource: $('#set-source'),
  setHint: $('#set-hint'),
  setUpload: $('#set-upload'),
  setChoose: $('#set-choose'),
  setFile: $('#set-file'),
  setFileStatus: $('#set-file-status'),
  setRemove: $('#set-remove'),
  setTest: $('#set-test'),
  setResult: $('#set-result'),
  setSave: $('#set-save'),
};

const isBotCheck = (msg) => /not a bot/i.test(msg || '');

// ================================
// HELPERS
// ================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const itemWord = (format) => (format === 'mp4' ? 'video' : 'track');
const VIDEO_KBPS = { 360: 700, 480: 1200, 720: 2500, 1080: 4500 };  // rough YouTube H.264 bitrates
const padNum = (n, width) => String(n).padStart(width, '0');
const padWidth = (total) => Math.max(2, String(total).length);

function fmtClock(sec) {
  if (sec == null || !Number.isFinite(sec)) return '0:00';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${padNum(m, 2)}:${padNum(s, 2)}` : `${m}:${padNum(s, 2)}`;
}

function fmtLong(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : `${Math.round(sec)} s`;
}

function fmtBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function timeAgo(epochSeconds) {
  const mins = Math.round((Date.now() / 1000 - epochSeconds) / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Mirrors downloader.safe_name so the "saved to" hint matches the real folder.
function safeName(text, fallback = 'Downloads') {
  let t = String(text || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/^[ .]+|[ .]+$/g, '').slice(0, 150).replace(/[ .]+$/, '');
  if (!t) return fallback;
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(t) ? `_${t}` : t;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 405) {  // the page is newer than the running server
      el.restart.hidden = false;
      throw new Error('The app needs a restart: press Ctrl+C in its terminal, run python app.py, then reload.');
    }
    let msg = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === 'string') msg = data.detail;
      else if (Array.isArray(data.detail)) msg = data.detail.map((d) => d.msg).join('; ');
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

function setBusy(btn, busy, label = '') {
  if (busy) {
    btn.dataset.html ??= btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span>${esc(label)}`;
    btn.disabled = true;
  } else if (btn.dataset.html !== undefined) {
    btn.innerHTML = btn.dataset.html;
    delete btn.dataset.html;
    btn.disabled = false;
  }
}

function toast(message, kind = 'info') {
  const icons = { success: 'check', error: 'alert', warn: 'alert', info: 'music' };
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `${icon(icons[kind])}<span>${esc(message)}</span>`;
  el.toasts.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 6500 : 4200);
}

// ================================
// THEME
// ================================
function currentTheme() {
  return document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

el.theme.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
});

// ================================
// FETCH A LINK
// ================================
let fetchToken = 0;

async function fetchPreview() {
  const url = el.url.value.trim();
  if (!url) { el.url.focus(); return; }
  const token = ++fetchToken;
  setBusy(el.fetchBtn, true, 'Fetching…');
  el.fetchError.hidden = true;
  showSkeleton();
  try {
    const preview = await api('/api/inspect', { method: 'POST', body: { url } });
    if (token === fetchToken) openPreview(preview);
  } catch (err) {
    if (token !== fetchToken) return;
    el.preview.hidden = true;
    el.fetchError.innerHTML = `${icon('alert')}<span>${esc(err.message)}</span>`
      + (isBotCheck(err.message) ? '<button class="btn btn-sm" type="button" data-action="settings">Open settings</button>' : '');
    el.fetchError.hidden = false;
  } finally {
    if (token === fetchToken) setBusy(el.fetchBtn, false);
  }
}

function showSkeleton() {
  el.preview.hidden = false;
  el.preview.innerHTML = `
    <div class="pv-head">
      <div class="pv-cover skel"></div>
      <div class="pv-meta">
        <div class="skel skel-line" style="width: 22%"></div>
        <div class="skel skel-line" style="width: 78%; height: 20px"></div>
        <div class="skel skel-line" style="width: 46%"></div>
      </div>
    </div>
    <div class="skel-list">${'<div class="skel skel-row"></div>'.repeat(4)}</div>`;
}

el.form.addEventListener('submit', (ev) => { ev.preventDefault(); fetchPreview(); });

el.url.addEventListener('paste', () => {
  setTimeout(() => { if (/^https?:\/\/\S+$/.test(el.url.value.trim())) fetchPreview(); }, 0);
});

el.url.addEventListener('input', syncPasteButton);

function syncPasteButton() {
  el.paste.hidden = !navigator.clipboard?.readText || el.url.value.trim() !== '';
}

el.paste.addEventListener('click', async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) { toast('Your clipboard is empty.', 'warn'); return; }
    el.url.value = text;
    syncPasteButton();
    fetchPreview();
  } catch {
    toast('The browser blocked clipboard access. Paste with Ctrl+V instead.', 'warn');
    el.url.focus();
  }
});

// ================================
// PREVIEW: PICK TRACKS & OPTIONS
// ================================
function openPreview(preview) {
  state.preview = preview;
  state.selected = new Set(preview.entries.flatMap((e, i) => (e.available ? [i] : [])));
  state.lastClicked = null;
  state.pad = padWidth(Math.max(...preview.entries.map((e) => e.index)));
  renderPreview();
  el.preview.hidden = false;
  el.preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closePreview() {
  fetchToken++;
  state.preview = null;
  el.preview.hidden = true;
  el.preview.innerHTML = '';
  setBusy(el.fetchBtn, false);
}

function renderPreview() {
  const p = state.preview;
  const count = p.entries.length;
  const totalDuration = p.entries.reduce((sum, e) => sum + (e.duration || 0), 0);
  const unavailable = p.entries.filter((e) => !e.available).length;
  const album = p.kind === 'playlist' ? p.title : 'Singles';

  el.preview.innerHTML = `
    <div class="pv-head">
      <div class="pv-cover">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" referrerpolicy="no-referrer">` : icon('music')}</div>
      <div class="pv-meta">
        <div class="eyebrow">${p.kind === 'playlist' ? 'Playlist' : 'Single video'}</div>
        <h2 class="pv-title" dir="auto">${esc(p.title)}</h2>
        <div class="pv-facts">
          ${p.uploader ? `<span dir="auto">${esc(p.uploader)}</span>` : ''}
          ${p.kind === 'playlist' ? `<span>${plural(count, 'track')}</span>` : ''}
          ${totalDuration ? `<span>${fmtLong(totalDuration)}</span>` : ''}
          ${unavailable ? `<span class="warn-text">${unavailable} unavailable</span>` : ''}
        </div>
        ${p.playlist_url ? `<button class="btn btn-sm pv-playlist" type="button" data-action="load-playlist">
          ${icon('music')}This video is in a playlist. Get the whole playlist</button>` : ''}
      </div>
      <button class="icon-btn pv-close" type="button" data-action="close-preview" aria-label="Close">${icon('x')}</button>
    </div>

    <div class="pv-options">
      <label class="field field-wide">
        <span class="label">Save as (album &amp; folder name)</span>
        <input class="input" id="album" value="${esc(album)}" maxlength="150" dir="auto" spellcheck="false">
        <span class="hint" id="album-path"></span>
      </label>
      <div class="field">
        <span class="label">Format</span>
        <div class="seg" data-name="format" role="group" aria-label="Format">
          <button type="button" data-value="mp3">MP3</button>
          <button type="button" data-value="m4a">M4A</button>
          <button type="button" data-value="mp4">MP4 video</button>
        </div>
      </div>
      <div class="field">
        <span class="label" id="quality-label">Quality</span>
        <div class="seg" id="quality-seg" role="group" aria-labelledby="quality-label"></div>
      </div>
      <div class="field">
        <span class="label">Extras</span>
        <button type="button" class="switch" id="embed" role="switch" aria-checked="true">
          <span class="switch-track"><span class="switch-thumb"></span></span>Tags &amp; cover art
        </button>
      </div>
      <p class="hint field-wide" id="format-hint"></p>
    </div>

    <div class="pv-toolbar"${count === 1 ? ' hidden' : ''}>
      <button type="button" class="check" id="select-all" role="checkbox" aria-checked="true" aria-label="Select all">
        <span class="box"></span>
      </button>
      <span class="sel-count" id="sel-count"></span>
      <label class="search">
        ${icon('search')}
        <input id="pv-search" type="search" placeholder="Filter tracks" autocomplete="off" aria-label="Filter tracks">
      </label>
    </div>

    <ol class="pv-list" id="pv-list">
      ${p.entries.map((e, i) => `
        <li class="pv-row" data-i="${i}" role="checkbox" tabindex="0" aria-checked="false"${e.available ? '' : ' aria-disabled="true"'} title="${esc(e.title)}">
          <span class="box"></span>
          <span class="num">${p.kind === 'playlist' ? padNum(e.index, state.pad) : ''}</span>
          ${e.thumbnail ? `<img class="thumb" src="${esc(e.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb"></span>'}
          <span class="title" dir="auto">${esc(e.title)}</span>
          ${e.available ? `<span class="dur">${e.duration ? fmtClock(e.duration) : ''}</span>` : '<span class="chip chip-sm">Unavailable</span>'}
        </li>`).join('')}
    </ol>

    <div class="pv-foot">
      <div class="pv-summary" id="pv-summary"></div>
      <button class="btn btn-primary btn-lg" id="start-btn" type="button"></button>
    </div>`;

  syncOptions();
  syncSelection();
  syncAlbumPath();
}

function visibleRows() {
  return $$('.pv-row', el.preview).filter((row) => !row.hidden && row.getAttribute('aria-disabled') !== 'true');
}

function toggleRow(i, shift) {
  const turnOn = !state.selected.has(i);
  let targets = [i];
  if (shift && state.lastClicked !== null) {
    const lo = Math.min(i, state.lastClicked), hi = Math.max(i, state.lastClicked);
    targets = visibleRows().map((r) => Number(r.dataset.i)).filter((n) => n >= lo && n <= hi);
  }
  for (const t of targets) turnOn ? state.selected.add(t) : state.selected.delete(t);
  state.lastClicked = i;
  syncSelection();
}

function syncSelection() {
  const p = state.preview;
  for (const row of $$('.pv-row', el.preview)) {
    row.setAttribute('aria-checked', String(state.selected.has(Number(row.dataset.i))));
  }

  const visible = visibleRows().map((r) => Number(r.dataset.i));
  const picked = visible.filter((i) => state.selected.has(i)).length;
  $('#select-all').setAttribute('aria-checked', !picked ? 'false' : picked === visible.length ? 'true' : 'mixed');

  const n = state.selected.size;
  const available = p.entries.filter((e) => e.available).length;
  $('#sel-count').innerHTML = `<strong>${n}</strong> of ${available} selected`;

  const seconds = [...state.selected].reduce((sum, i) => sum + (p.entries[i].duration || 0), 0);
  const o = state.options;
  const kbps = o.format === 'mp3' ? o.quality : o.format === 'm4a' ? 130 : VIDEO_KBPS[o.videoQuality] + 130;
  const bytes = (seconds * kbps * 1000) / 8;
  const word = itemWord(o.format);
  $('#pv-summary').innerHTML = n
    ? `<strong>${plural(n, word)}</strong>${seconds ? ` · ${fmtLong(seconds)} · about ${fmtBytes(bytes)}` : ''}`
    : `Pick at least one ${word}`;

  const start = $('#start-btn');
  start.innerHTML = `${icon('download')}<span>Download ${n ? plural(n, word) : ''}</span>`;
  start.disabled = !n || state.status?.ffmpeg === false;
}

const FORMAT_HINTS = {
  mp3: {
    128: 'MP3 plays everywhere. 128 kbps is fine for speech and keeps files small.',
    192: 'MP3 plays everywhere. 192 kbps is a good balance of size and quality.',
    320: 'MP3 plays everywhere. 320 kbps is the highest quality, with the biggest files.',
  },
  m4a: 'M4A is audio only and keeps YouTube’s original sound, usually without re-encoding. Plays on phones, iTunes and most car stereos.',
  mp4: {
    360: 'MP4 video with sound. 360p is fine on a phone and keeps files small.',
    480: 'MP4 video with sound. 480p looks good on phones and tablets.',
    720: 'MP4 video with sound. 720p HD is a good balance for laptops and TVs.',
    1080: 'MP4 video with sound. 1080p Full HD is the sharpest, with files about twice the size of 720p.',
  },
};

function syncOptions() {
  const o = state.options;
  const video = o.format === 'mp4';
  // The quality control switches between audio bitrates and video resolutions.
  const qualitySeg = $('#quality-seg');
  const key = video ? 'videoQuality' : 'quality';
  const values = video ? [360, 480, 720, 1080] : [128, 192, 320];
  if (qualitySeg.dataset.name !== key) {
    qualitySeg.dataset.name = key;
    qualitySeg.innerHTML = values.map((v) => `<button type="button" data-value="${v}">${video ? `${v}p` : v}</button>`).join('');
  }
  $('#quality-label').textContent = video ? 'Max resolution' : 'Quality (kbps)';
  qualitySeg.classList.toggle('is-disabled', o.format === 'm4a');

  for (const seg of $$('.seg', el.preview)) {
    for (const btn of $$('button', seg)) {
      btn.setAttribute('aria-pressed', String(btn.dataset.value === String(o[seg.dataset.name])));
    }
  }
  $('#embed').setAttribute('aria-checked', String(o.embed));
  const hint = FORMAT_HINTS[o.format];
  $('#format-hint').textContent = typeof hint === 'string' ? hint : hint[video ? o.videoQuality : o.quality];
  store.set('options', o);
}

function syncAlbumPath() {
  const input = $('#album');
  const dir = state.status?.download_dir;
  const sep = dir?.includes('\\') ? '\\' : '/';
  $('#album-path').textContent = dir ? `Saved to ${dir}${sep}${safeName(input.value)}` : '';
}

el.preview.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('[data-action="close-preview"]')) { closePreview(); return; }
  if (t.closest('[data-action="load-playlist"]')) {
    el.url.value = state.preview.playlist_url;
    fetchPreview();
    return;
  }

  const row = t.closest('.pv-row');
  if (row) {
    if (row.getAttribute('aria-disabled') !== 'true') toggleRow(Number(row.dataset.i), ev.shiftKey);
    return;
  }

  const segBtn = t.closest('.seg button');
  if (segBtn) {
    const name = segBtn.closest('.seg').dataset.name;
    state.options[name] = name === 'format' ? segBtn.dataset.value : Number(segBtn.dataset.value);
    syncOptions();
    syncSelection();
    return;
  }

  if (t.closest('#embed')) {
    state.options.embed = !state.options.embed;
    syncOptions();
    return;
  }

  if (t.closest('#select-all')) {
    const visible = visibleRows().map((r) => Number(r.dataset.i));
    const allOn = visible.every((i) => state.selected.has(i));
    for (const i of visible) allOn ? state.selected.delete(i) : state.selected.add(i);
    syncSelection();
    return;
  }

  if (t.closest('#start-btn')) startDownload();
});

el.preview.addEventListener('keydown', (ev) => {
  const row = ev.target.closest?.('.pv-row');
  if (!row) return;
  if (ev.key === ' ' || ev.key === 'Enter') {
    ev.preventDefault();
    if (row.getAttribute('aria-disabled') !== 'true') toggleRow(Number(row.dataset.i), ev.shiftKey);
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const rows = $$('.pv-row', el.preview).filter((r) => !r.hidden);
    rows[rows.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
  }
});

el.preview.addEventListener('input', (ev) => {
  if (ev.target.id === 'album') syncAlbumPath();
  if (ev.target.id === 'pv-search') {
    const q = ev.target.value.trim().toLowerCase();
    for (const row of $$('.pv-row', el.preview)) {
      const e = state.preview.entries[Number(row.dataset.i)];
      row.hidden = q !== '' && !e.title.toLowerCase().includes(q) && String(e.index) !== q;
    }
    syncSelection();
  }
});

async function startDownload() {
  const p = state.preview;
  const o = state.options;
  const picks = [...state.selected].sort((a, b) => a - b).map((i) => p.entries[i]);
  if (!picks.length) return;
  const title = $('#album').value.trim() || p.title;
  const btn = $('#start-btn');
  setBusy(btn, true, 'Starting…');
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: {
        title,
        source: p.url,
        format: o.format,
        quality: o.format === 'mp4' ? o.videoQuality : o.quality,
        embed_meta: o.embed,
        total: Math.max(...p.entries.map((e) => e.index)),
        numbered: p.kind === 'playlist',
        tracks: picks.map(({ id, index, title: t, url, duration, thumbnail }) => ({ id, index, title: t, url, duration, thumbnail })),
      },
    });
    state.expanded.add(job.id);
    upsertJob(job);
    closePreview();
    el.url.value = '';
    syncPasteButton();
    toast(`Started ${plural(picks.length, itemWord(job.format))} → ${job.title}`, 'success');
    $(`.job[data-id="${job.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    setBusy(btn, false);
    toast(err.message, 'error');
  }
}

// ================================
// DOWNLOAD JOBS
// ================================
function upsertJob(job) {
  const prev = state.jobs.get(job.id);
  state.jobs.set(job.id, job);

  let card = el.jobs.querySelector(`.job[data-id="${job.id}"]`);
  if (!card) {
    card = createJobCard(job);
    const after = $$('.job', el.jobs).find((c) => (state.jobs.get(c.dataset.id)?.created ?? 0) < job.created);
    el.jobs.insertBefore(card, after ?? null);
  }
  patchJobCard(card, job);
  if (player.queue[player.pos]?.jobId === job.id) syncNav();

  if (prev && RUNNING.has(prev.status) && !RUNNING.has(job.status)) {
    const c = job.counts;
    if (job.status === 'done') toast(`“${job.title}” is ready: ${plural(c.done, itemWord(job.format))}`, 'success');
    else if (c.error) toast(`“${job.title}” finished, but ${c.error} failed. Use Retry to try again.`, 'warn');
  }
  syncJobsEmpty();
}

function removeJob(id) {
  state.jobs.delete(id);
  el.jobs.querySelector(`.job[data-id="${id}"]`)?.remove();
  if (player.queue[player.pos]?.jobId === id) closePlayer();
  syncJobsEmpty();
}

function syncJobs(jobs) {
  const ids = new Set(jobs.map((j) => j.id));
  for (const id of [...state.jobs.keys()]) if (!ids.has(id)) removeJob(id);
  for (const job of jobs) upsertJob(job);
  syncJobsEmpty();
}

function syncJobsEmpty() {
  const n = state.jobs.size;
  el.jobsEmpty.hidden = n > 0;
  el.jobsCount.textContent = n ? String(n) : '';
}

function createJobCard(job) {
  const card = document.createElement('article');
  card.className = 'card job';
  card.dataset.id = job.id;
  card.innerHTML = `
    <div class="job-head">
      <div class="job-cover">${icon('music')}</div>
      <div class="job-main">
        <div class="job-top">
          <h3 class="job-title" dir="auto"></h3>
          <span class="chip"></span>
        </div>
        <p class="job-meta"></p>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Progress"><span class="bar-fill"></span></div>
        <div class="job-stats"><span class="job-progress"></span><span class="job-speed"></span></div>
      </div>
    </div>
    <div class="job-hint" hidden>
      ${icon('alert')}
      <span>YouTube wants to confirm you're not a bot. Turn on browser cookies in Settings, then press Retry.</span>
      <button class="btn btn-sm" type="button" data-action="settings">Open settings</button>
    </div>
    <div class="job-actions">
      <button class="btn btn-sm btn-primary" type="button" data-action="play">${icon('play')}Play</button>
      <button class="btn btn-sm" type="button" data-action="open">${icon('folder')}Open folder</button>
      <a class="btn btn-sm" data-action="zip" href="/api/jobs/${job.id}/zip" download>${icon('archive')}ZIP</a>
      <button class="btn btn-sm" type="button" data-action="retry">${icon('refresh')}<span></span></button>
      <button class="btn btn-sm" type="button" data-action="cancel">${icon('stop')}Stop</button>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" type="button" data-action="toggle" aria-expanded="false">Tracks ${icon('chevron', 'chev')}</button>
      <button class="icon-btn" type="button" data-action="remove" aria-label="Remove">${icon('trash')}</button>
    </div>
    <div class="job-tracks" hidden>
      <div class="tabs" role="tablist">
        ${Object.entries(TABS).map(([key, label]) => `<button class="tab" type="button" role="tab" data-tab="${key}">${label} <span class="tab-n"></span></button>`).join('')}
      </div>
      <ol class="tracks"></ol>
    </div>`;
  return card;
}

function patchJobCard(card, job) {
  const c = job.counts;
  const total = job.tracks.length;
  const failed = c.error + c.cancelled;
  const running = RUNNING.has(job.status);
  const expanded = state.expanded.has(job.id);

  card.dataset.status = job.status;
  $('.job-title', card).textContent = job.title;
  $('.job-title', card).title = job.title;
  const [chipText, tone] = CHIPS[job.status] ?? [job.status, ''];
  const chip = $('.chip', card);
  chip.textContent = chipText;
  chip.dataset.tone = tone;

  $('.job-meta', card).textContent = jobMeta(job);
  $('.job-meta', card).title = `Saved to ${job.folder}`;

  const pct = Math.round(job.progress * 100);
  $('.bar-fill', card).style.width = `${job.status === 'done' ? 100 : pct}%`;
  $('.bar', card).setAttribute('aria-valuenow', String(pct));

  let text;
  if (job.status === 'cancelling') text = 'Stopping…';
  else if (job.status === 'done') text = total === 1 ? 'Done' : `All ${total} ${itemWord(job.format)}s done`;
  else if (job.status === 'cancelled' && !c.done) text = 'Stopped';
  else if (job.status === 'failed' && c.error === total) text = total === 1 ? 'Download failed' : `All ${itemWord(job.format)}s failed`;
  else {
    text = `${c.done} of ${total} done`;
    if (c.error) text += ` · ${c.error} failed`;
    if (c.cancelled) text += ` · ${c.cancelled} stopped`;
  }
  $('.job-progress', card).textContent = text;
  $('.job-speed', card).textContent = running && job.speed ? `${fmtBytes(job.speed)}/s` : running ? `${pct}%` : '';

  if (!card.dataset.cover) {
    const thumb = job.tracks.find((t) => t.thumbnail)?.thumbnail;
    if (thumb) {
      $('.job-cover', card).innerHTML = `<img src="${esc(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
      card.dataset.cover = '1';
    }
  }

  const action = (name) => $(`[data-action="${name}"]`, card);
  action('play').hidden = !c.done;
  action('zip').hidden = !c.done;
  action('cancel').hidden = job.status !== 'running';
  action('retry').hidden = !failed || job.status === 'cancelling';  // also while others still download
  $('span', action('retry')).textContent = `Retry ${failed}`;
  action('toggle').setAttribute('aria-expanded', String(expanded));
  $('.job-tracks', card).hidden = !expanded;
  $('.job-hint', card).hidden = running || !job.tracks.some((t) => t.status === 'error' && isBotCheck(t.error));

  if (expanded) renderTracks(card, job);
}

function jobMeta(job) {
  const quality = { mp3: ` · ${job.quality} kbps`, mp4: ` · ${job.quality}p` }[job.format] ?? '';
  return `${job.format.toUpperCase()}${quality} · ${plural(job.tracks.length, itemWord(job.format))} · ${timeAgo(job.created)}`;
}

// Keep "5 min ago" fresh on jobs that are no longer changing.
setInterval(() => {
  for (const card of $$('.job', el.jobs)) {
    const job = state.jobs.get(card.dataset.id);
    if (job) $('.job-meta', card).textContent = jobMeta(job);
  }
}, 60_000);

function inTab(track, tab) {
  if (tab === 'active') return ['queued', 'downloading', 'processing'].includes(track.status);
  if (tab === 'done') return track.status === 'done';
  if (tab === 'failed') return track.status === 'error' || track.status === 'cancelled';
  return true;
}

function renderTracks(card, job) {
  const c = job.counts;
  const counts = {
    all: job.tracks.length,
    active: c.queued + c.downloading + c.processing,
    done: c.done,
    failed: c.error + c.cancelled,
  };
  let tab = state.trackTab.get(job.id) || 'all';
  if (tab !== 'all' && !counts[tab]) tab = 'all';

  for (const btn of $$('.tab', card)) {
    const key = btn.dataset.tab;
    btn.setAttribute('aria-selected', String(key === tab));
    btn.hidden = key !== 'all' && !counts[key];
    $('.tab-n', btn).textContent = counts[key];
  }

  const list = $('.tracks', card);
  job.tracks.forEach((track, n) => {
    let row = list.children[n];
    if (!row) {
      row = createTrackRow(job, track, n);
      list.append(row);
    }
    patchTrackRow(row, track);
    row.hidden = !inTab(track, tab);
  });
  markPlaying();
}

function createTrackRow(job, track, n) {
  const li = document.createElement('li');
  li.className = 'trk';
  li.dataset.n = String(n);
  li.innerHTML = `
    <button class="trk-num" type="button" aria-label="Play">
      <span class="n">${padNum(track.index, job.pad)}</span>${icon('play', 'pi')}
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <div class="trk-body">
      <div class="trk-title" dir="auto" title="${esc(track.title)}">${esc(track.title)}</div>
      <div class="trk-sub"></div>
      <div class="trk-bar"><span></span></div>
    </div>
    <div class="trk-end">
      <button class="icon-btn trk-reveal" type="button" data-action="reveal-track" aria-label="Show in folder" title="Show in folder">${icon('folder-open')}</button>
      <a class="icon-btn trk-dl" href="/api/jobs/${job.id}/tracks/${n}/file?download=true" download aria-label="Save to this device" title="Save to this device">${icon('download')}</a>
      <button class="icon-btn trk-retry" type="button" data-action="retry-track" aria-label="Try again" title="Try again">${icon('refresh')}</button>
    </div>`;
  return li;
}

function trackStatus(t) {
  switch (t.status) {
    case 'queued': return 'Waiting for a free slot';
    case 'downloading': {
      if (t.note) return t.note;  // e.g. retrying after a connection problem
      const parts = [`${Math.floor(t.progress * 100)}%`];
      if (t.speed) parts.push(`${fmtBytes(t.speed)}/s`);
      if (t.eta != null) parts.push(`${fmtClock(t.eta)} left`);
      return parts.join(' · ');
    }
    case 'processing': return 'Converting & tagging…';
    case 'done': return [t.note, fmtBytes(t.size), t.duration ? fmtClock(t.duration) : ''].filter(Boolean).join(' · ');
    case 'error': return t.error || 'Failed';
    case 'cancelled': return t.note || 'Stopped';
    default: return t.status;
  }
}

function patchTrackRow(row, t) {
  const sig = [t.status, t.progress, t.speed, t.eta, t.error, t.note, t.size].join('|');
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  row.dataset.status = t.status;
  const sub = $('.trk-sub', row);
  sub.textContent = trackStatus(t);
  sub.title = t.status === 'error' ? t.error || '' : '';
  $('.trk-bar span', row).style.width = `${Math.round(t.progress * 100)}%`;
  $('.trk-num', row).disabled = t.status !== 'done';
}

el.jobs.addEventListener('click', async (ev) => {
  const target = ev.target.closest('[data-action], .tab, .trk-num');
  if (!target) return;
  const card = target.closest('.job');
  const id = card.dataset.id;
  const job = state.jobs.get(id);

  if (target.classList.contains('tab')) {
    state.trackTab.set(id, target.dataset.tab);
    renderTracks(card, job);
    return;
  }
  if (target.classList.contains('trk-num')) {
    playTrack(id, Number(target.closest('.trk').dataset.n));
    return;
  }

  try {
    switch (target.dataset.action) {
      case 'play': playTrack(id); break;
      case 'open': await api(`/api/jobs/${id}/open`, { method: 'POST' }); break;
      case 'retry': upsertJob(await api(`/api/jobs/${id}/retry`, { method: 'POST' })); break;
      case 'reveal-track':
        await api(`/api/jobs/${id}/tracks/${target.closest('.trk').dataset.n}/reveal`, { method: 'POST' });
        break;
      case 'retry-track': {
        const n = target.closest('.trk').dataset.n;
        upsertJob(await api(`/api/jobs/${id}/tracks/${n}/retry`, { method: 'POST' }));
        break;
      }
      case 'cancel': upsertJob(await api(`/api/jobs/${id}/cancel`, { method: 'POST' })); break;
      case 'toggle':
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        patchJobCard(card, job);
        break;
      case 'remove': openRemoveDialog(job); break;
      case 'settings': openSettings(); break;
      default: break; // ZIP is a plain link
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ================================
// REMOVE DIALOG
// ================================
let removing = null;

function openRemoveDialog(job) {
  removing = job.id;
  el.rmName.textContent = job.title;
  el.rmFiles.checked = false;
  syncRemoveLabel();
  el.dialog.returnValue = '';
  el.dialog.showModal();
}

function syncRemoveLabel() {
  el.rmConfirm.textContent = el.rmFiles.checked ? 'Remove & delete files' : 'Remove';
}

el.rmFiles.addEventListener('change', syncRemoveLabel);

el.dialog.addEventListener('close', async () => {
  const id = removing;
  removing = null;
  if (el.dialog.returnValue !== 'confirm' || !id) return;
  const deleteFiles = el.rmFiles.checked;
  try {
    await api(`/api/jobs/${id}?delete_files=${deleteFiles}`, { method: 'DELETE' });
    removeJob(id);
    toast(deleteFiles ? 'Removed and deleted its files.' : 'Removed from the list. Files were kept.', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ================================
// SETTINGS DIALOG
// ================================
const SOURCES = {
  off: ['Off', 'YouTube is used without signing in.'],
  firefox: ['Firefox', 'Sign in on youtube.com in Firefox first. Firefox can stay open while you download.'],
  file: ['cookies.txt file (works with Chrome)', ''],
  chrome: ['Chrome', 'On Windows this usually fails: Chrome locks its cookies while open and encrypts them. Use a cookies.txt file instead.'],
  edge: ['Edge', 'Close Edge completely first, including from the system tray. If it still fails, use a cookies.txt file.'],
  brave: ['Brave', 'Close Brave completely first. If it still fails, use a cookies.txt file.'],
  opera: ['Opera', 'Close Opera completely first. If it still fails, use a cookies.txt file.'],
  vivaldi: ['Vivaldi', 'Close Vivaldi completely first. If it still fails, use a cookies.txt file.'],
  chromium: ['Chromium', 'Close Chromium completely first. If it still fails, use a cookies.txt file.'],
  safari: ['Safari (Mac only)', 'Only works on a Mac.'],
};

function showSetResult(ok, text) {
  el.setResult.className = `set-result ${ok ? 'ok' : 'bad'}`;
  el.setResult.innerHTML = `${icon(ok ? 'check' : 'alert')}<span>${esc(text)}</span>`;
}

function clearSetResult() {
  el.setResult.textContent = '';
  el.setResult.className = 'set-result';
}

function syncSource() {
  const source = el.setSource.value;
  el.setHint.textContent = SOURCES[source]?.[1] ?? '';
  el.setHint.hidden = !el.setHint.textContent;
  el.setUpload.hidden = source !== 'file';
}

function showFileStatus(info) {
  el.setRemove.hidden = !info;
  el.setChoose.textContent = info ? 'Replace file…' : 'Upload cookies.txt…';
  if (!info) {
    el.setFileStatus.className = 'set-file-status';
    el.setFileStatus.textContent = 'No file uploaded yet';
    return;
  }
  const when = timeAgo(info.uploaded);
  el.setFileStatus.className = `set-file-status ${info.signed_in ? 'ok' : 'warn'}`;
  el.setFileStatus.innerHTML = info.signed_in
    ? `${icon('check')}<span>Signed-in YouTube cookies, uploaded ${esc(when)}</span>`
    : `${icon('alert')}<span>No YouTube login in this file. Export it again while signed in.</span>`;
}

async function openSettings() {
  clearSetResult();
  try {
    const s = await api('/api/settings');
    const order = ['off', 'firefox', 'file', ...s.browsers.filter((b) => b !== 'firefox')];
    el.setSource.innerHTML = order.map((key) => `<option value="${key}">${esc(SOURCES[key]?.[0] ?? key)}</option>`).join('');
    el.setSource.value = s.cookies;
    showFileStatus(s.cookies_file);
    syncSource();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  el.settings.showModal();
}

const saveSettings = () => api('/api/settings', { method: 'PUT', body: { cookies: el.setSource.value } });

el.settingsBtn.addEventListener('click', openSettings);
for (const btn of $$('[data-close]', el.settings)) btn.addEventListener('click', () => el.settings.close());
el.fetchError.addEventListener('click', (ev) => { if (ev.target.closest('[data-action="settings"]')) openSettings(); });
el.setSource.addEventListener('change', () => { clearSetResult(); syncSource(); });
el.setChoose.addEventListener('click', () => el.setFile.click());

el.setFile.addEventListener('change', async () => {
  const file = el.setFile.files[0];
  el.setFile.value = '';
  if (!file) return;
  clearSetResult();
  setBusy(el.setChoose, true, 'Uploading…');
  try {
    showFileStatus(await api('/api/settings/cookies-file', { method: 'PUT', body: { content: await file.text() } }));
  } catch (err) {
    showSetResult(false, err.message);
  } finally {
    setBusy(el.setChoose, false);
    el.setChoose.textContent = el.setRemove.hidden ? 'Upload cookies.txt…' : 'Replace file…';
  }
});

el.setRemove.addEventListener('click', async () => {
  try {
    await api('/api/settings/cookies-file', { method: 'DELETE' });
    showFileStatus(null);
    clearSetResult();
  } catch (err) {
    showSetResult(false, err.message);
  }
});

el.setTest.addEventListener('click', async () => {
  setBusy(el.setTest, true, 'Testing…');
  clearSetResult();
  try {
    await saveSettings();
    const result = await api('/api/settings/test', { method: 'POST' });
    showSetResult(result.ok, result.ok ? 'Works! YouTube is letting downloads through.' : result.error);
  } catch (err) {
    showSetResult(false, err.message);
  } finally {
    setBusy(el.setTest, false);
  }
});

el.setSave.addEventListener('click', async (ev) => {
  ev.preventDefault();
  try {
    await saveSettings();
    el.settings.close();
    toast('Settings saved. Press Retry on any failed downloads.', 'success');
  } catch (err) {
    showSetResult(false, err.message);
  }
});

// ================================
// LIVE UPDATES (server-sent events)
// ================================
function connect() {
  const events = new EventSource('/api/events');
  events.onopen = () => { el.conn.hidden = true; };
  events.onerror = () => { el.conn.hidden = false; };
  events.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'sync') syncJobs(msg.jobs);
    else if (msg.type === 'job') upsertJob(msg.job);
    else if (msg.type === 'removed') removeJob(msg.id);
  };
}

// ================================
// PLAYER
// ================================
const media = $('#pl-media');  // a <video> element plays audio files too
const player = { queue: [], pos: -1, seeking: false };

function buildQueue(jobId) {
  const job = state.jobs.get(jobId);
  if (!job) return [];
  return job.tracks.flatMap((t, n) => (t.status === 'done'
    ? [{ jobId, n, title: t.title, album: job.title, thumb: t.thumbnail, video: job.format === 'mp4', src: `/api/jobs/${jobId}/tracks/${n}/file` }]
    : []));
}

function playTrack(jobId, n) {
  const current = player.queue[player.pos];
  if (current && current.jobId === jobId && (n === undefined || current.n === n)) {
    media.paused ? media.play() : media.pause();
    return;
  }
  const queue = buildQueue(jobId);
  if (!queue.length) return;
  player.queue = queue;
  player.pos = n === undefined ? 0 : Math.max(0, queue.findIndex((q) => q.n === n));
  loadCurrent();
}

function loadCurrent() {
  const q = player.queue[player.pos];
  media.src = q.src;
  media.play().catch((err) => { if (err.name !== 'AbortError') toast(`Couldn't play “${q.title}”.`, 'error'); });

  el.player.hidden = false;
  el.player.classList.toggle('is-video', q.video);
  el.plVideo.hidden = !q.video;
  el.plFull.hidden = !q.video;
  document.body.classList.add('has-player');
  document.body.classList.toggle('has-video', q.video);
  el.plTitle.textContent = q.title;
  el.plTitle.title = q.title;
  el.plSub.textContent = q.album;
  el.plCover.innerHTML = q.thumb ? `<img src="${esc(q.thumb)}" alt="" referrerpolicy="no-referrer">` : icon('music');
  syncNav();
  updateSeek();

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: q.title,
      album: q.album,
      artwork: q.thumb ? [{ src: q.thumb, sizes: '320x180' }] : [],
    });
  }
  markPlaying();
}

// Re-reads the job so tracks that finished after playback started are included.
function step(delta) {
  const current = player.queue[player.pos];
  if (!current) return false;
  const queue = state.jobs.has(current.jobId) ? buildQueue(current.jobId) : player.queue;
  const pos = queue.findIndex((q) => q.n === current.n);
  const next = (pos < 0 ? player.pos : pos) + delta;
  if (next < 0 || next >= queue.length) return false;
  player.queue = queue;
  player.pos = next;
  loadCurrent();
  return true;
}

function previous() {
  if (media.currentTime > 3 || !step(-1)) media.currentTime = 0;
}

function syncNav() {
  const current = player.queue[player.pos];
  const queue = current ? buildQueue(current.jobId) : [];
  const pos = queue.findIndex((q) => q.n === current?.n);
  el.plNext.disabled = pos < 0 || pos >= queue.length - 1;
}

function closePlayer() {
  media.pause();
  media.removeAttribute('src');
  media.load();
  player.queue = [];
  player.pos = -1;
  el.player.hidden = true;
  el.plVideo.hidden = true;
  document.body.classList.remove('has-player', 'has-video');
  markPlaying();
}

function markPlaying() {
  for (const row of $$('.trk.is-playing')) row.classList.remove('is-playing', 'is-paused');
  const current = player.queue[player.pos];
  if (!current) return;
  const row = $(`.job[data-id="${current.jobId}"] .trk[data-n="${current.n}"]`);
  row?.classList.add('is-playing');
  row?.classList.toggle('is-paused', media.paused);
}

function updateSeek() {
  const d = media.duration;
  const p = Number.isFinite(d) && d > 0 ? media.currentTime / d : 0;
  if (!player.seeking) el.plSeek.value = String(Math.round(p * 1000));
  el.plSeek.style.setProperty('--p', `${(Number(el.plSeek.value) / 10).toFixed(2)}%`);
  el.plCur.textContent = fmtClock(media.currentTime);
  el.plDur.textContent = Number.isFinite(d) ? fmtClock(d) : '0:00';
}

function syncPlayState() {
  el.player.classList.toggle('is-playing', !media.paused);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = media.paused ? 'paused' : 'playing';
  markPlaying();
}

media.addEventListener('play', syncPlayState);
media.addEventListener('pause', syncPlayState);
media.addEventListener('timeupdate', updateSeek);
media.addEventListener('loadedmetadata', updateSeek);
media.addEventListener('ended', () => { if (!step(1)) syncPlayState(); });

el.plPlay.addEventListener('click', () => (media.paused ? media.play() : media.pause()));
el.plPrev.addEventListener('click', previous);
el.plNext.addEventListener('click', () => step(1));
el.plClose.addEventListener('click', closePlayer);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (media.requestFullscreen) media.requestFullscreen().catch(() => {});
  else media.webkitEnterFullscreen?.();  // iPhone
}

el.plFull.addEventListener('click', toggleFullscreen);
media.addEventListener('click', () => (media.paused ? media.play() : media.pause()));
media.addEventListener('dblclick', toggleFullscreen);
// Show the browser's own controls only while full screen, where our player bar isn't visible.
document.addEventListener('fullscreenchange', () => { media.controls = document.fullscreenElement === media; });
el.plSeek.addEventListener('input', () => {
  player.seeking = true;
  el.plSeek.style.setProperty('--p', `${Number(el.plSeek.value) / 10}%`);
  if (Number.isFinite(media.duration)) el.plCur.textContent = fmtClock((el.plSeek.value / 1000) * media.duration);
});
el.plSeek.addEventListener('change', () => {
  if (Number.isFinite(media.duration)) media.currentTime = (el.plSeek.value / 1000) * media.duration;
  player.seeking = false;
});

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => media.play(),
    pause: () => media.pause(),
    previoustrack: previous,
    nexttrack: () => step(1),
    seekto: (d) => { media.currentTime = d.seekTime; },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
  }
}

document.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Space' || el.player.hidden || ev.target.closest('input, textarea, button, a, [role="checkbox"], dialog')) return;
  ev.preventDefault();
  media.paused ? media.play() : media.pause();
});

// ================================
// START
// ================================
async function init() {
  syncPasteButton();
  connect();
  try {
    state.status = await api('/api/status');
    el.ffmpeg.hidden = state.status.ffmpeg;
    document.body.classList.toggle('is-local', state.status.local);
    // Older servers don't report this at all, which also means they need a restart.
    el.restart.hidden = state.status.restart_needed === false;
    el.dir.textContent = state.status.download_dir;
    el.engine.textContent = `yt-dlp ${state.status.yt_dlp}`;
    if (state.preview) { syncAlbumPath(); syncSelection(); }
  } catch {
    el.dir.textContent = 'unknown (server not reachable)';
  }

  const shared = new URLSearchParams(location.search).get('url');
  if (shared) {
    el.url.value = shared;
    syncPasteButton();
    fetchPreview();
  }
}

init();

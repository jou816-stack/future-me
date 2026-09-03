'use strict';
/* global api */

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const ROUTE = { view: params.get('view') || 'main', id: params.get('id') };
const isDeliveryWindow = ROUTE.view === 'open';

let state = null;
let currentView = null;
let composeDirty = false;

// ---------- 小工具 ----------
const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${fmtDate(iso)}（${WEEK[d.getDay()]}）${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtRelative(iso) {
  const ms = new Date(iso) - Date.now();
  const days = Math.round(ms / 86400000);
  if (days > 365) return `還有約 ${(days / 365).toFixed(1)} 年`;
  if (days > 30) return `還有約 ${Math.round(days / 30)} 個月`;
  if (days >= 1) return `還有 ${days} 天`;
  if (ms > 0) return `今天`;
  return '';
}
function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
let toastTimer = null;
function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
function showError(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function call(fn) {
  const res = await fn();
  if (!res.ok) {
    const err = new Error(res.message);
    err.code = res.code;
    throw err;
  }
  return res.data;
}

async function refreshState() {
  state = await call(() => api.getState());
  $('#lock-state').textContent = state.unlocked ? '🔓 已解鎖' : '🔒 已上鎖';
  return state;
}

// ---------- 密碼對話框 ----------
function askPassphrase(title = '輸入主密碼') {
  return new Promise((resolve) => {
    const modal = $('#pw-modal');
    const input = $('#pw-modal-input');
    const errEl = $('#pw-modal-error');
    $('#pw-modal-title').textContent = title;
    $('#pw-modal-hint').textContent = state.hint || '（沒有提示）';
    showError(errEl, '');
    input.value = '';
    modal.hidden = false;
    setTimeout(() => input.focus(), 30);

    const cleanup = () => {
      modal.hidden = true;
      $('#pw-modal-form').onsubmit = null;
      $('#pw-modal-cancel').onclick = null;
      input.value = '';
    };
    $('#pw-modal-cancel').onclick = () => {
      cleanup();
      resolve(false);
    };
    $('#pw-modal-form').onsubmit = async (e) => {
      e.preventDefault();
      const pass = input.value;
      if (!pass) return;
      try {
        await call(() => api.unlock(pass));
        cleanup();
        await refreshState();
        resolve(true);
      } catch (err) {
        showError(errEl, err.code === 'WRONG_PASSPHRASE' ? '密碼不對，再試一次。' : err.message);
        input.select();
      }
    };
  });
}

// 需要金鑰的操作：先確定已解鎖，鎖住就跳密碼框
async function withUnlock(fn) {
  await refreshState();
  if (!state.unlocked) {
    const ok = await askPassphrase();
    if (!ok) return null;
  }
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'LOCKED') {
      const ok = await askPassphrase();
      if (!ok) return null;
      return await fn();
    }
    throw err;
  }
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    modal.hidden = false;
    const done = (v) => {
      modal.hidden = true;
      $('#confirm-ok').onclick = null;
      $('#confirm-cancel').onclick = null;
      resolve(v);
    };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
  });
}

// ---------- 信紙風格 ----------
const PAPERS = [
  { id: 'lined', name: '橫線信紙' },
  { id: 'night', name: '夜空' },
  { id: 'sakura', name: '櫻花' },
  { id: 'vintage', name: '舊信箋' },
];
let currentPaper = 'plain';
function applySheet(el, id) {
  for (const p of PAPERS) el.classList.remove(`sheet-${p.id}`);
  el.classList.remove('sheet-plain');
  el.classList.add(`sheet-${PAPERS.some((p) => p.id === id) ? id : 'plain'}`);
}
function paperName(id) {
  const p = PAPERS.find((x) => x.id === id);
  return p ? p.name : '素面';
}
function pickPaper(exclude) {
  const pool = PAPERS.filter((p) => p.id !== exclude);
  return pool[Math.floor(Math.random() * pool.length)].id;
}
function setComposePaper(id) {
  currentPaper = id;
  applySheet($('#c-body'), id);
  $('#c-paper-name').textContent = `信紙：${paperName(id)}`;
}

// ---------- 畫面切換 ----------
function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = true;
  $(`#view-${name}`).hidden = false;
  document.body.classList.toggle('bg-inbox', name === 'inbox');
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.toggle('active', b.dataset.nav === name);
  currentView = name;
  if (name === 'inbox') renderInbox();
  if (name === 'settings') renderSettings();
  if (name === 'compose') initCompose();
}

// ---------- 首次設定 ----------
$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#setup-error');
  const p1 = $('#setup-pass').value;
  const p2 = $('#setup-pass2').value;
  if (p1 !== p2) return showError(errEl, '兩次輸入的密碼不一樣。');
  try {
    await call(() => api.setupVault({ passphrase: p1, hint: $('#setup-hint').value, openAtLogin: $('#setup-login').checked }));
    $('#setup-pass').value = $('#setup-pass2').value = '';
    await refreshState();
    $('#nav').hidden = false;
    toast('主密碼設好了。記得你的提示。');
    showView('compose');
  } catch (err) {
    showError(errEl, err.message);
  }
});

// ---------- 信箱 ----------
async function renderInbox() {
  const list = await call(() => api.listLetters());
  const pending = list.filter((l) => l.status === 'delivered').sort((a, b) => a.deliver_at.localeCompare(b.deliver_at));
  const sealed = list.filter((l) => l.status === 'sealed').sort((a, b) => a.deliver_at.localeCompare(b.deliver_at));
  const opened = list.filter((l) => l.status === 'opened').sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  $('#inbox-empty').hidden = list.length > 0;
  const root = $('#inbox-sections');
  root.innerHTML = '';

  const section = (title, items, render) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'section-title';
    h.textContent = title;
    root.appendChild(h);
    for (const l of items) root.appendChild(render(l));
  };

  const card = (l, cls, actions) => {
    const el = document.createElement('div');
    el.className = `letter-card ${cls}`;
    el.innerHTML = `
      <span class="seal"></span>
      <div class="info">
        <div class="title">${escapeHtml(l.title || '（未命名）')}</div>
        ${l.epigraph ? `<div class="epi">${escapeHtml(l.epigraph)}</div>` : ''}
        <div class="meta"></div>
      </div>
      <div class="actions"></div>`;
    return { el, meta: el.querySelector('.meta'), actions: el.querySelector('.actions') };
  };

  section(`待拆封 · ${pending.length}`, pending, (l) => {
    const c = card(l, 'pending');
    c.meta.textContent = `寫於 ${fmtDate(l.created_at)} · 已於 ${fmtDateTime(l.delivered_at)} 送達`;
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = '拆開';
    b.onclick = () => openLetterView(l.id);
    c.actions.appendChild(b);
    return c.el;
  });

  section(`在途 · ${sealed.length}`, sealed, (l) => {
    const c = card(l, 'sealed');
    c.meta.textContent = `寫於 ${fmtDate(l.created_at)} · 將於 ${fmtDateTime(l.deliver_at)} 送達 · ${fmtRelative(l.deliver_at)}`;
    const b = document.createElement('button');
    b.className = 'link';
    b.textContent = '撤回';
    b.onclick = async () => {
      const yes = await confirmDialog('撤回這封信？', '信會被永久刪除，沒辦法再讀到。');
      if (!yes) return;
      const r = await withUnlock(() => call(() => api.cancelLetter(l.id)));
      if (r) {
        toast('已撤回。');
        renderInbox();
      }
    };
    c.actions.appendChild(b);
    return c.el;
  });

  section(`已拆封 · ${opened.length}`, opened, (l) => {
    const c = card(l, 'opened');
    c.meta.textContent = `寫於 ${fmtDate(l.created_at)} · 拆封於 ${fmtDateTime(l.opened_at)}${l.reflected_at ? ' · 已寫反思' : ''}`;
    const b = document.createElement('button');
    b.className = 'secondary';
    b.textContent = '再讀一次';
    b.onclick = () => openLetterView(l.id);
    c.actions.appendChild(b);
    return c.el;
  });
}
$('#inbox-compose').addEventListener('click', () => showView('compose'));

// ---------- 寫信 ----------
let composeInited = false;
function defaultTimeParts() {
  const [h, m] = String(state.config.deliver_default_time || '09:00').split(':').map(Number);
  return [h, m];
}
function setPreset(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  const [h, m] = defaultTimeParts();
  d.setHours(h, m, 0, 0);
  $('#c-when').value = toLocalInput(d);
  updateWhenHint();
}
function updateWhenHint() {
  const v = $('#c-when').value;
  const el = $('#c-when-hint');
  if (!v) return (el.textContent = '');
  const d = new Date(v);
  el.textContent = Number.isNaN(d.getTime()) ? '' : `${fmtDateTime(d.toISOString())} · ${fmtRelative(d.toISOString()) || '這個時間已經過了'}`;
}
function setDirty(v) {
  composeDirty = v;
  api.setDirty(v);
}
function initCompose() {
  const min = new Date();
  min.setMinutes(min.getMinutes() + 1);
  $('#c-when').min = toLocalInput(min);
  if (!$('#c-body').value.trim()) setComposePaper(pickPaper());
  if (!composeInited) {
    composeInited = true;
    setPreset(12);
    $('#c-paper-shuffle').addEventListener('click', () => setComposePaper(pickPaper(currentPaper)));
    for (const b of document.querySelectorAll('.presets button')) b.addEventListener('click', () => setPreset(Number(b.dataset.months)));
    $('#c-when').addEventListener('input', updateWhenHint);
    const body = $('#c-body');
    const count = () => ($('#c-count').textContent = body.value.length ? `${body.value.length} 字` : '');
    for (const id of ['#c-body', '#c-title', '#c-epigraph']) {
      $(id).addEventListener('input', () => {
        setDirty(!!(body.value.trim() || $('#c-title').value || $('#c-epigraph').value));
        count();
      });
    }
    body.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') $('#compose-form').requestSubmit();
    });
  }
  setTimeout(() => $('#c-body').focus(), 50);
}
$('#compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const when = new Date($('#c-when').value);
  if (Number.isNaN(when.getTime())) return toast('請選一個送達時間。');
  if (when <= new Date()) return toast('送達時間要在未來。');
  const body = $('#c-body').value;
  if (!body.trim()) return toast('信還是空的。');
  const payload = { title: $('#c-title').value.trim(), epigraph: $('#c-epigraph').value.trim(), deliver_at: when.toISOString(), body, paper: currentPaper };
  try {
    const entry = await withUnlock(() => call(() => api.sealLetter(payload)));
    if (!entry) return;
    $('#c-body').value = '';
    $('#c-title').value = '';
    $('#c-epigraph').value = '';
    $('#c-count').textContent = '';
    setDirty(false);
    setPreset(12);
    setComposePaper(pickPaper(currentPaper));
    toast(`已封存，將於 ${fmtDateTime(entry.deliver_at)} 送達。`, 4000);
    showView('inbox');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 拆信 ----------
let openId = null;
async function openLetterView(id) {
  openId = id;
  const list = await call(() => api.listLetters());
  const l = list.find((x) => x.id === id);
  if (!l) return toast('找不到這封信。');
  $('#o-created').textContent = fmtDate(l.created_at);
  $('#o-title').textContent = l.title || '（未命名）';
  $('#o-epigraph').textContent = l.epigraph || '';
  $('#o-epigraph').hidden = !l.epigraph;
  $('#o-deliver').textContent = fmtDateTime(l.deliver_at);
  $('#o-unseal').textContent = l.status === 'opened' ? '再讀一次' : '拆開信紙';
  showError($('#o-error'), '');
  $('#envelope').hidden = false;
  $('#paper').hidden = true;
  $('#p-body').textContent = '';
  showView('open');
}
$('#o-unseal').addEventListener('click', async () => {
  try {
    const r = await withUnlock(() => call(() => api.openLetter(openId)));
    if (!r) return;
    $('#p-created').textContent = fmtDate(r.letter.created_at);
    $('#p-created-full').textContent = fmtDateTime(r.letter.created_at);
    $('#p-opened').textContent = fmtDateTime(r.letter.opened_at);
    $('#p-title').textContent = r.letter.title || '';
    $('#p-title').hidden = !r.letter.title;
    $('#p-body').textContent = r.body;
    applySheet($('#paper'), r.letter.paper || 'plain');
    renderReflection(r.letter, r.reflection);
    $('#envelope').hidden = true;
    $('#paper').hidden = false;
    window.scrollTo(0, 0);
  } catch (err) {
    showError($('#o-error'), err.message);
  }
});
function leaveLetter() {
  $('#p-body').textContent = ''; // 讀完就從畫面清掉
  $('#r-text').textContent = '';
  $('#r-input').value = '';
  if (isDeliveryWindow) api.closeWindow();
  else showView('inbox');
}
function renderReflection(letter, text) {
  const has = !!(text && text.trim());
  $('#reflection').hidden = !has;
  $('#reflection-edit').hidden = true;
  $('#o-actions').hidden = false;
  if (has) {
    $('#r-text').textContent = text;
    $('#r-date').textContent = letter.reflected_at ? fmtDate(letter.reflected_at) : '';
  }
  $('#o-reflect').textContent = has ? '再寫一點' : '寫下反思';
}
$('#o-done').addEventListener('click', leaveLetter);

// 寫下反思：加密存在信的旁邊
$('#o-reflect').addEventListener('click', () => {
  $('#r-input').value = $('#reflection').hidden ? '' : $('#r-text').textContent;
  $('#reflection-edit').hidden = false;
  $('#o-actions').hidden = true;
  setTimeout(() => $('#r-input').focus(), 30);
});
$('#r-cancel').addEventListener('click', () => {
  $('#reflection-edit').hidden = true;
  $('#o-actions').hidden = false;
  $('#r-input').value = '';
});
$('#r-save').addEventListener('click', async () => {
  const text = $('#r-input').value;
  if (!text.trim()) return toast('還沒寫東西。');
  try {
    const letter = await withUnlock(() => call(() => api.reflectLetter(openId, text)));
    if (!letter) return;
    renderReflection(letter, text);
    $('#r-input').value = '';
    toast('反思已存下，跟信放在一起。');
  } catch (err) {
    toast(err.message);
  }
});

// 刪除：信與反思一起永久刪除
$('#o-delete').addEventListener('click', async () => {
  const yes = await confirmDialog('刪除這封信？', '信和寫下的反思會一起永久刪除，沒辦法再讀到。');
  if (!yes) return;
  try {
    const r = await withUnlock(() => call(() => api.cancelLetter(openId)));
    if (!r) return;
    toast('已刪除。');
    leaveLetter();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 設定 ----------
function renderSettings() {
  const c = state.config;
  $('#cfg-default-time').value = c.deliver_default_time;
  $('#cfg-nag-time').value = c.nag_time;
  $('#cfg-autolock').value = c.autolock_minutes;
  $('#cfg-login').checked = !!c.open_at_login;
  $('#cfg-login-note').hidden = state.isPackaged;
  $('#cfg-hint').textContent = state.hint;
  $('#cfg-dir').textContent = state.dataDir;
}
$('#cfg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await call(() =>
    api.setConfig({
      deliver_default_time: $('#cfg-default-time').value || '09:00',
      nag_time: $('#cfg-nag-time').value || '09:00',
      autolock_minutes: Number($('#cfg-autolock').value) || 15,
      open_at_login: $('#cfg-login').checked,
    })
  );
  await refreshState();
  toast('已儲存。');
});
$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#pw-error');
  const n1 = $('#pw-new').value;
  const n2 = $('#pw-new2').value;
  if (n1 !== n2) return showError(errEl, '兩次輸入的新密碼不一樣。');
  try {
    await call(() => api.changePassphrase({ oldPassphrase: $('#pw-old').value, newPassphrase: n1, hint: $('#pw-hint').value }));
    for (const id of ['#pw-old', '#pw-new', '#pw-new2', '#pw-hint']) $(id).value = '';
    showError(errEl, '');
    await refreshState();
    renderSettings();
    toast('主密碼已更換，所有信件已重新加密。', 4000);
  } catch (err) {
    showError(errEl, err.code === 'WRONG_PASSPHRASE' ? '舊密碼不對。' : err.message);
  }
});
$('#cfg-open-folder').addEventListener('click', () => api.openDataFolder());
$('#cfg-backup').addEventListener('click', async () => {
  try {
    const file = await call(() => api.backup());
    if (file) toast(`已備份到 ${file}`, 5000);
  } catch (err) {
    toast(err.message, 5000);
  }
});
$('#cfg-lock').addEventListener('click', async () => {
  await call(() => api.lock());
  await refreshState();
  toast('已上鎖。');
});
$('#cfg-check').addEventListener('click', async () => {
  await call(() => api.checkNow());
  toast('檢查完成。');
  if (currentView === 'inbox') renderInbox();
});

// ---------- 導覽與推播 ----------
for (const b of document.querySelectorAll('.nav-btn')) b.addEventListener('click', () => showView(b.dataset.nav));
api.onNavigate((view) => {
  if (!state || !state.hasVault) return;
  showView(view);
});
api.onLettersChanged(() => {
  if (currentView === 'inbox') renderInbox();
});
api.onLocked(() => refreshState());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#pw-modal').hidden) $('#pw-modal-cancel').click();
    if (!$('#confirm-modal').hidden) $('#confirm-cancel').click();
  }
});

// ---------- 啟動 ----------
(async () => {
  await refreshState();
  if (isDeliveryWindow) {
    $('#nav').hidden = true;
    await openLetterView(ROUTE.id);
    return;
  }
  if (!state.hasVault) {
    $('#nav').hidden = true;
    showView('setup');
    setTimeout(() => $('#setup-pass').focus(), 50);
    return;
  }
  $('#nav').hidden = false;
  showView('inbox');
})();

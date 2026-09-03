'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, powerMonitor, dialog } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { Session } = require('./session');
const { Scheduler } = require('./scheduler');
const ipc = require('./ipc');
const logger = require('./log');
const watchdog = require('./watchdog');
const { log } = logger;

app.setName('Future Me');
logger.init(app.getPath('logs'));
process.on('uncaughtException', (err) => log('uncaughtException', String(err && err.stack ? err.stack : err)));
process.on('unhandledRejection', (err) => log('unhandledRejection', String(err && err.stack ? err.stack : err)));

const USE_WATCHDOG = app.isPackaged && !process.env.FUTURE_LETTER_DATA_DIR;

const store = new Store();
const session = new Session(store);
let mainWindow = null;
let tray = null;
const deliveryWindows = new Map(); // id -> BrowserWindow
let quitting = false;

const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const ASSETS = path.join(__dirname, '..', '..', 'assets');

function baseWindowOptions(extra) {
  return {
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f1e7',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
    ...extra,
  };
}

function confirmDiscard(win) {
  const r = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['留下來繼續寫', '放棄這封信'],
    defaultId: 0,
    cancelId: 0,
    message: '這封信還沒封存',
    detail: '草稿只存在記憶體裡，關掉視窗就會消失。',
  });
  return r === 1;
}

function createMainWindow() {
  if (mainWindow) return mainWindow;
  mainWindow = new BrowserWindow(baseWindowOptions({ width: 980, height: 720, minWidth: 720, minHeight: 520 }));
  mainWindow.loadFile(RENDERER, { query: { view: 'main' } });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    if (mainWindow.isDirty && !confirmDiscard(mainWindow)) {
      e.preventDefault();
      return;
    }
    mainWindow.isDirty = false;
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function showMain(view) {
  const win = createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) {
    const send = () => win.webContents.send('nav', view);
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
    else send();
  }
}

function showDelivery(letter) {
  let win = deliveryWindows.get(letter.id);
  if (win) {
    win.show();
    win.focus();
    app.focus({ steal: true });
    return;
  }
  win = new BrowserWindow(
    baseWindowOptions({ width: 640, height: 780, minWidth: 480, minHeight: 480, alwaysOnTop: true })
  );
  deliveryWindows.set(letter.id, win);
  // 釘在所有視窗最上層、跟著你到每一個桌面，直到你按「拆開信紙」為止
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(RENDERER, { query: { view: 'open', id: letter.id } });
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    app.focus({ steal: true });
  });
  win.on('closed', () => deliveryWindows.delete(letter.id));
}

function notify(title, body, letter) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (letter) showDelivery(letter);
    else showMain();
  });
  n.show();
}

function formatWhen(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

const windows = {
  unpin(id) {
    const win = deliveryWindows.get(id);
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.setVisibleOnAllWorkspaces(false);
    }
  },
  broadcast(channel) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel);
  },
  refreshBadge() {
    const pending = store.getIndex().filter((l) => l.status === 'delivered').length;
    if (app.dock) app.dock.setBadge(pending ? String(pending) : '');
    if (tray) tray.setTitle(pending ? ` ${pending}` : '');
  },
};

const scheduler = new Scheduler(store, {
  onDeliver(letter) {
    log('deliver', letter.id);
    const title = letter.title ? `「${letter.title}」` : '一封信';
    notify(`${formatWhen(letter.created_at)}的你寄來了${title}`, letter.epigraph || '點一下拆開信封', letter);
    showDelivery(letter);
    windows.refreshBadge();
  },
  onNag(letter) {
    const title = letter.title ? `「${letter.title}」` : '一封信';
    notify(`還有${title}沒拆開`, `${formatWhen(letter.created_at)}的你寫的。點一下來讀。`, letter);
    windows.refreshBadge();
  },
  onChange() {
    windows.broadcast('letters:changed');
    windows.refreshBadge();
  },
});

function confirmQuit() {
  const r = dialog.showMessageBoxSync({
    type: 'warning',
    buttons: ['取消', '結束'],
    defaultId: 0,
    cancelId: 0,
    message: '確定要結束 Future Me？',
    detail: '結束後，到期的信不會準時彈出，要等下次登入或重新打開 App 才會補送。\n平常關掉視窗就好，App 會留在選單列繼續等信。',
  });
  if (r !== 1) return;
  quitting = true;
  log('quit: user confirmed');
  if (USE_WATCHDOG && watchdog.isUnderLaunchd()) watchdog.stop(); // 會結束自己
  app.quit();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Future Me');
  const menu = Menu.buildFromTemplate([
    { label: '打開信箱', click: () => showMain('inbox') },
    { label: '寫一封新的信', click: () => showMain('compose') },
    { type: 'separator' },
    { label: '現在檢查有沒有到期的信', click: () => scheduler.check() },
    { label: '上鎖（清除記憶中的金鑰）', click: () => session.lock() },
    { type: 'separator' },
    { label: '結束（結束後信件不會準時彈出）', click: () => confirmQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMain());
}

function buildAppMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '關於 Future Me' },
        { type: 'separator' },
        { label: '上鎖', accelerator: 'Cmd+L', click: () => session.lock() },
        { type: 'separator' },
        { role: 'hide', label: '隱藏' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: '結束 Future Me', accelerator: 'Cmd+Q', click: () => confirmQuit() },
      ],
    },
    {
      label: '信件',
      submenu: [
        { label: '寫一封新的信', accelerator: 'Cmd+N', click: () => showMain('compose') },
        { label: '信箱', accelerator: 'Cmd+1', click: () => showMain('inbox') },
        { label: '設定', accelerator: 'Cmd+,', click: () => showMain('settings') },
        { type: 'separator' },
        { label: '現在檢查到期的信', click: () => scheduler.check() },
      ],
    },
    { role: 'editMenu', label: '編輯' },
    { role: 'windowMenu', label: '視窗' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

session.onLock = () => windows.broadcast('session:locked');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(() => {
    log('ready', { version: app.getVersion(), packaged: app.isPackaged, launchd: watchdog.isUnderLaunchd(), exe: process.execPath });
    if (USE_WATCHDOG) {
      const handedOff = watchdog.ensure({
        runAtLoad: store.getConfig().open_at_login !== false,
        releaseLock: () => app.releaseSingleInstanceLock(),
      });
      if (handedOff) {
        app.exit(0);
        return;
      }
    }
    store.ensureDirs();
    buildAppMenu();
    createTray();
    ipc.register({ store, session, scheduler, windows });
    createMainWindow();
    scheduler.start(); // 啟動時立刻檢查一次 → 關機期間錯過的信會補送
    // 已送達但還沒拆的信（例如 App 重啟前彈出過、還沒讀）→ 重新彈出來
    for (const l of store.getIndex()) if (l.status === 'delivered') showDelivery(l);
    windows.refreshBadge();
    powerMonitor.on('resume', () => scheduler.check());
    powerMonitor.on('unlock-screen', () => scheduler.check());
  });

  app.on('activate', () => showMain());

  // macOS：關掉所有視窗不結束，繼續在背景等信到期
  app.on('window-all-closed', () => {});

  // 登出、關機、重新開機：系統會先發這個通知，這時放行、不跳確認
  app.whenReady().then(() => {
    powerMonitor.on('shutdown', () => {
      log('quit: system shutdown/logout');
      quitting = true;
    });
  });

  app.on('before-quit', (e) => {
    if (!quitting) {
      // 從 Dock「結束」或其他途徑來的退出要求 → 先問
      e.preventDefault();
      log('quit: intercepted, asking user');
      confirmQuit();
      return;
    }
    session.lock();
  });
}

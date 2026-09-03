'use strict';
// 到期檢查：每 30 秒掃一次 index.json。
//  - sealed 且 deliver_at <= now  → 標記 delivered，觸發 onDeliver（彈出信封 + 通知）
//  - delivered 但未拆封            → 每天 nag_time 之後提醒一次（last_nagged 記當天）
// 條件用 <= 而不是 ==，所以關機／睡眠期間錯過的信，下次檢查會一次補送。

const INTERVAL_MS = 30 * 1000;

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pastTimeOfDay(now, hhmm) {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  const t = new Date(now);
  t.setHours(h, m, 0, 0);
  return now >= t;
}

class Scheduler {
  constructor(store, { onDeliver, onNag, onChange }) {
    this.store = store;
    this.onDeliver = onDeliver;
    this.onNag = onNag;
    this.onChange = onChange;
    this.timer = null;
  }

  start() {
    this.stop();
    this.check();
    this.timer = setInterval(() => this.check(), INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  check() {
    let list;
    try {
      list = this.store.getIndex();
    } catch (err) {
      console.error('讀取 index.json 失敗', err);
      return;
    }
    const now = new Date();
    const today = localDateKey(now);
    const config = this.store.getConfig();
    let changed = false;
    const delivered = [];
    const nagged = [];

    for (const letter of list) {
      if (letter.status === 'sealed' && new Date(letter.deliver_at) <= now) {
        letter.status = 'delivered';
        letter.delivered_at = now.toISOString();
        letter.last_nagged = today;
        delivered.push(letter);
        changed = true;
      } else if (letter.status === 'delivered' && letter.last_nagged !== today && pastTimeOfDay(now, config.nag_time)) {
        letter.last_nagged = today;
        nagged.push(letter);
        changed = true;
      }
    }

    if (changed) {
      this.store.setIndex(list);
      if (this.onChange) this.onChange();
    }
    for (const l of delivered) this.onDeliver(l);
    for (const l of nagged) this.onNag(l);
  }
}

module.exports = { Scheduler };

'use strict';
const assert = require('assert');
const { Scheduler } = require('../src/main/scheduler');

// 假的 store：只放在記憶體
function fakeStore(letters, config = {}) {
  let list = JSON.parse(JSON.stringify(letters));
  return {
    getIndex: () => JSON.parse(JSON.stringify(list)),
    setIndex: (l) => (list = JSON.parse(JSON.stringify(l))),
    getConfig: () => ({ nag_time: '09:00', ...config }),
  };
}
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

// 1. 到期的信 → delivered；未到期的不動
{
  const store = fakeStore([
    { id: 'a', status: 'sealed', deliver_at: iso(-60_000) },
    { id: 'b', status: 'sealed', deliver_at: iso(+60_000) },
    { id: 'c', status: 'sealed', deliver_at: iso(-7 * 86400_000) }, // 一週前（模擬關機錯過）
  ]);
  const delivered = [];
  const s = new Scheduler(store, { onDeliver: (l) => delivered.push(l.id), onNag: () => assert.fail('不該提醒'), onChange: () => {} });
  s.check();
  assert.deepStrictEqual(delivered.sort(), ['a', 'c']);
  const idx = store.getIndex();
  assert.strictEqual(idx.find((l) => l.id === 'a').status, 'delivered');
  assert.strictEqual(idx.find((l) => l.id === 'c').status, 'delivered');
  assert.strictEqual(idx.find((l) => l.id === 'b').status, 'sealed');
  assert.ok(idx.find((l) => l.id === 'a').delivered_at);
  // 再 check 一次：同一天不應該再提醒（last_nagged 已是今天）
  s.check();
  assert.deepStrictEqual(delivered.sort(), ['a', 'c']);
}

// 2. 昨天送達但沒拆 → 今天 nag_time 之後提醒一次，只提醒一次
{
  const store = fakeStore([{ id: 'x', status: 'delivered', deliver_at: iso(-86400_000), last_nagged: '2000-01-01' }], { nag_time: '00:00' });
  const nagged = [];
  const s = new Scheduler(store, { onDeliver: () => assert.fail(), onNag: (l) => nagged.push(l.id), onChange: () => {} });
  s.check();
  s.check();
  assert.deepStrictEqual(nagged, ['x']);
}

// 3. nag_time 還沒到 → 不提醒
{
  const store = fakeStore([{ id: 'y', status: 'delivered', deliver_at: iso(-86400_000), last_nagged: '2000-01-01' }], { nag_time: '23:59' });
  const nagged = [];
  const s = new Scheduler(store, { onDeliver: () => {}, onNag: (l) => nagged.push(l.id), onChange: () => {} });
  s.check();
  assert.deepStrictEqual(nagged, []);
}

// 4. 已拆封的信永遠不再打擾
{
  const store = fakeStore([{ id: 'z', status: 'opened', deliver_at: iso(-86400_000), last_nagged: '2000-01-01' }], { nag_time: '00:00' });
  const s = new Scheduler(store, { onDeliver: () => assert.fail(), onNag: () => assert.fail(), onChange: () => {} });
  s.check();
}

console.log('scheduler: all tests passed');

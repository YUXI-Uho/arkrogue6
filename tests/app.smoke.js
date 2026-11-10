/* 极简 DOM 桩，用于在没有浏览器的环境下跑通 app.js 的渲染逻辑
 * 用法：node tests/app.smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');

function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = [];
  this.dataset = {};
  this.style = {};
  this._class = '';
  this.value = '';
  this.checked = false;
  this.disabled = false;
  this.textContent = '';
  this._html = '';
  this.handlers = {};
  const self = this;
  this.classList = {
    add(c) { const s = new Set(self._class.split(' ').filter(Boolean)); s.add(c); self._class = [...s].join(' '); },
    remove(c) { self._class = self._class.split(' ').filter(x => x && x !== c).join(' '); },
    contains(c) { return self._class.split(' ').indexOf(c) >= 0; },
    toggle(c) { this.contains(c) ? this.remove(c) : this.add(c); }
  };
}
Object.defineProperty(El.prototype, 'className', {
  get() { return this._class; },
  set(v) { this._class = v || ''; }
});
Object.defineProperty(El.prototype, 'innerHTML', {
  // 真实浏览器里清空子节点会把滚动位置归零，桩里也照做，否则「保留滚动」测不出来
  get() { return this._html; },
  set(v) { this._html = v; this.children = []; this.scrollTop = 0; }
});
El.prototype.appendChild = function (c) {
  if (c && c.__fragment) { c.children.forEach(x => this.children.push(x)); return c; }
  this.children.push(c);
  return c;
};
El.prototype.addEventListener = function (ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); };
// aria-* 之类的属性：桩里存下来即可，测试直接读 attrs 断言
El.prototype.setAttribute = function (k, v) { (this.attrs = this.attrs || {})[k] = String(v); };
El.prototype.getAttribute = function (k) { return this.attrs && this.attrs[k] != null ? this.attrs[k] : null; };
El.prototype.focus = function () { doc.activeElement = this; };
El.prototype.select = function () {};
El.prototype.querySelector = function (sel) {
  const m = /\[data-role="(.+?)"\]/.exec(sel);
  const walk = node => {
    for (const c of node.children || []) {
      if (m && c.dataset && c.dataset.role === m[1]) return c;
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  return walk(this);
};
El.prototype.click = function () {
  if (this.onclick) this.onclick();
  (this.handlers.click || []).forEach(fn => fn.call(this));
};
El.prototype.change = function () {
  if (this.onchange) this.onchange();
  (this.handlers.change || []).forEach(fn => fn.call(this));
};
El.prototype.input = function () {
  if (this.oninput) this.oninput();
  (this.handlers.input || []).forEach(fn => fn.call(this));
};
// 键盘事件：只带 key 与 preventDefault，够 app.js 的键盘流用
El.prototype.keydown = function (key) {
  const ev = { key, preventDefault() {}, stopPropagation() {} };
  (this.handlers.keydown || []).forEach(fn => fn.call(this, ev));
};

const ids = {};
const doc = {
  _ready: [],
  createElement: t => new El(t),
  createTextNode: t => ({ textContent: String(t), nodeType: 3 }),
  createDocumentFragment: () => { const f = new El('#fragment'); f.__fragment = true; return f; },
  getElementById: id => {
    if (!ids[id]) { ids[id] = new El('div'); ids[id].id = id; }
    return ids[id];
  },
  addEventListener: (ev, fn) => {
    if (ev === 'DOMContentLoaded') doc._ready.push(fn);
    else (doc._on = doc._on || {}), (doc._on[ev] = doc._on[ev] || []).push(fn);
  },
  querySelector: () => null
};

global.window = global;
global.document = doc;
// 浏览器全局：app.js 会读 location / history（分享链接）与 navigator（离线缓存、剪贴板）
global.location = {
  href: 'http://localhost:8000/index.html', hash: '', protocol: 'http:',
  pathname: '/index.html', search: ''
};
global.history = {
  replaceState(a, b, url) {
    global.location.href = 'http://localhost:8000' + url;
    global.location.hash = '';
  }
};
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] || null; },
  setItem(k, v) { this._d[k] = v; },
  removeItem(k) { delete this._d[k]; }
};
global.alert = m => { throw new Error('alert: ' + m); };
global.confirm = () => true;
global.DOMException = Error;

// 预置一份「带坏数据」的本地存档：缺 panel 的干员、未知藏品 id、坏预设
global.localStorage._d['is6calc.v1'] = JSON.stringify({
  schemaVersion: 2,
  relics: { '001': { stage: 0, stack: 0 }, 'no-such-relic': { stage: 0, stack: 0 } },
  squad: [
    { name: '坏干员' },                                        // 缺 panel → 丢弃
    { name: '好干员', panel: { hp: 100, atk: 10, def: 5 } }     // 有效
  ],
  ctx: { time: 30 },
  presets: [
    { name: '坏预设', ops: [{ name: '也没有面板' }] },
    { name: '好预设', ops: [{ name: '好干员', panel: { hp: 1, atk: 1, def: 1 } }] }
  ]
});

function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel });
}

// 顺序与 index.html 完全一致：注册表 → 表结构 → 数据产物 → 查询引擎 → 解析/引擎 → 仓储 → 界面
const FILES = [
  'core/schema.js',
  'core/enums.js',
  'core/db/schema.js',
  'data/is6db.js',
  'core/db/db.js',
  'core/db/migrate.js',
  'js/effects.js',
  'js/engine.js',
  'core/repos/operators.repo.js',
  'core/repos/relics.repo.js',
  'core/repos/squads.repo.js',
  'js/app.js'
];
const missing = FILES.filter(f => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.log('缺少文件：' + missing.join(', '));
  process.exit(1);
}
FILES.forEach(load);

let fail = 0;
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { fail++; console.log('  ✗ ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => doc.getElementById(id);
// 编队卡（排除「还没有干员」的空状态提示）
const cards = () => $('squadList').children.filter(c => String(c.className).indexOf('op-card') >= 0);
const tiles = () => $('opGrid').children.filter(c => c.dataset && c.dataset.name);
const cardOf = id => $('relicList').children.filter(c => c.dataset && c.dataset.id === id)[0];
// 落盘的是 v3 表结构，测试统一走这三个取值器，不在断言里手拆 tables
const savedArchive = () => JSON.parse(global.localStorage.getItem('is6calc.v1'));
const savedSquads = () => { const a = savedArchive(); return (a.tables && a.tables.squads) || []; };
const savedState = () => window.DBMigrate.normalize(savedArchive());

async function main() {
  console.log('=== 启动（带坏存档） ===');
  doc._ready.forEach(fn => fn());
  const allRelicCount = window.RelicRepo.all().length;
  ok($('relicList').children.filter(c => c.dataset && c.dataset.id).length === allRelicCount,
     'DOMContentLoaded 后渲染出全部 ' + allRelicCount + ' 张藏品卡');
  ok(!!window.ArkSchema && !!window.ArkEnums, 'core/schema.js 与 core/enums.js 已加载');
  ok(!!window.OperatorRepo && !!window.RelicRepo && !!window.SquadRepo, '三个仓储模块已挂到全局');
  ok(window.SquadRepo.MAX === 12, '编队上限 = 12');
  ok(cards().length === 1, '坏存档里缺 panel 的干员被丢弃，只留下 1 个有效干员');
  ok(String($('relicCount').textContent) === '1', '未知藏品 id 被丢弃');
  ok($('ctxTime').value === 30 || String($('ctxTime').value) === '30', '战斗状态从存档恢复');
  ok(/已忽略 1 条/.test($('toast').textContent), '启动时提示忽略数量：' + $('toast').textContent);
  ok(/升级为表结构 v3/.test($('toast').textContent), 'v2 旧存档被就地升级并提示：' + $('toast').textContent);
  ok($('presetList').children.filter(c => c.className === 'preset').length === 1, '坏预设被丢弃');

  // 回到干净状态再测交互
  $('btnReset').click();
  ok(cards().length === 0 && String($('relicCount').textContent) === '0', '「清空」清掉编队与藏品');

  console.log('=== 基础渲染 ===');
  ok($('catFilter').children.length === 9, '分类筛选渲染 9 个 chip');
  ok($('relicList').children.length > 200, '藏品列表渲染 ' + $('relicList').children.length + ' 项');
  ok($('profCounts').children.length === 8, '职业人数输入 8 个');
  ok($('squadProgress').textContent === '已选 0/12', '编队进度初始为「已选 0/12」');

  console.log('=== 分页 ===');
  ok($('paneSquad').classList.contains('on') && !$('paneSummary').classList.contains('on'),
     '默认只显示「编队」页，汇总与战斗状态页不占位');
  ok($('tabSquad').classList.contains('on'), '「编队」页签高亮');
  $('tabSummary').click();
  ok($('paneSummary').classList.contains('on') && !$('paneSquad').classList.contains('on'),
     '点「汇总」页签 → 只显示汇总页');
  ok(!$('tabSquad').classList.contains('on'), '离开的页签取消高亮');
  ok(global.localStorage.getItem('is6calc.tab') === 'summary', '当前页写入 localStorage，刷新后能回到原页');
  $('tabCtx').click();
  ok($('paneCtx').classList.contains('on') && !$('paneSummary').classList.contains('on'),
     '点「战斗状态」页签 → 只显示条件页');
  ok(/默认/.test($('tabCtxBadge').textContent), '战斗状态角标初始为「默认」：' + $('tabCtxBadge').textContent);
  const tInp = $('ctxTime');
  tInp.value = '45';
  (tInp.handlers.input || []).forEach(fn => fn.call(tInp));
  ok(/1 项自定义/.test($('tabCtxBadge').textContent),
     '改战斗时间后角标变为「1 项自定义」：' + $('tabCtxBadge').textContent);
  tInp.value = '0';
  (tInp.handlers.input || []).forEach(fn => fn.call(tInp));
  ok(/默认/.test($('tabCtxBadge').textContent), '改回默认值后角标复位');
  $('tabSquad').click();
  ok($('paneSquad').classList.contains('on'), '切回「编队」页');

  console.log('=== 左栏折叠 ===');
  $('btnFoldRelics').click();
  ok($('layout').classList.contains('folded'), '点 « 收起藏品库');
  ok(global.localStorage.getItem('is6calc.relicFold') === '1', '折叠状态写入 localStorage');
  $('btnUnfoldRelics').click();
  ok(!$('layout').classList.contains('folded'), '点窄带展开藏品库');

  // ② 未选中任何藏品时不该有控制条（否则 13 件四段式藏品各多出一段空白）
  const emptyCtrl = $('relicList').children.filter(c =>
    c.dataset && c.dataset.id &&
    c.children.some(k => String(k.className).indexOf('relic-controls') >= 0 && k.children.length === 0));
  const anyCtrl = $('relicList').children.filter(c =>
    c.dataset && c.dataset.id && c.children.some(k => String(k.className).indexOf('relic-controls') >= 0));
  ok(emptyCtrl.length === 0 && anyCtrl.length === 0,
     '未选中藏品时子节点为空的控制条 ' + emptyCtrl.length + ' 个、控制条总数 ' + anyCtrl.length + ' 个');

  console.log('=== 全干员网格 ===');
  $('btnTogglePicker').click();
  ok(!$('opPicker').classList.contains('hidden'), '点「添加干员」展开网格面板');
  const total = window.OperatorRepo.all().length;
  ok(tiles().length === total, '网格平铺全部 ' + tiles().length + ' 名干员');
  ok($('profFilter').children.length === 9, '职业筛选 8 个 + 全部');
  ok($('starFilter').children.length === 4, '星级筛选 4 个');
  ok(/已选 0\/12/.test($('pickerCount').textContent), '网格顶部显示已选人数');

  console.log('=== 点击选中 / 再次点击取消 ===');
  const first = tiles()[0];
  const firstName = first.dataset.name;
  const storedBefore = savedSquads().length;
  first.click();
  ok(cards().length === 1, '点卡片加入编队（' + firstName + '）');
  ok($('squadProgress').textContent === '已选 1/12', '进度更新为 已选 1/12');
  ok(savedSquads().length === storedBefore,
     '存档走 200ms 防抖：点击瞬间还没落盘');
  await sleep(260);
  ok(savedSquads().length === 1, '防抖结束后写入 localStorage');
  ok(window.DB.table('squads').count() === 1, '运行时 DB 的 squads 表与存档同步（' +
     window.DB.table('squads').count() + ' 行）');
  ok(window.DB.table('squads').all()[0].name === firstName, 'DB 里存的是刚才点的干员');
  ok(window.DBMigrate.snapshot().tables.squads.length === 1, 'snapshot 从 DB 读回同一份');

  const again = tiles().filter(t => t.dataset.name === firstName)[0];
  ok(again.classList.contains('on'), '已入队卡片高亮');
  ok(again.children.some(c => String(c.className).indexOf('tile-check') >= 0), '已入队卡片有打勾角标');
  again.click();
  ok(cards().length === 0, '再次点击同一张卡片 = 取消移出编队');

  console.log('=== 空白干员 ===');
  $('btnAddBlank').click();
  ok(cards().length === 1, '「空白干员」按钮仍可用');
  const delBtn = cards()[0].children[0].children.filter(c => String(c.className).indexOf('del') >= 0)[0];
  delBtn.click();
  ok(cards().length === 0, '删除按钮生效');

  console.log('=== 满员 / 判重 ===');
  const ops = window.OperatorRepo.all();
  for (let i = 0; i < 12; i++) {
    const t = tiles().filter(x => x.dataset.name === ops[i].name)[0];
    if (t) t.click();
  }
  ok(cards().length === 12, '加满 12 人');
  ok($('squadProgress').textContent === '已选 12/12', '进度显示 已选 12/12');

  const t13 = tiles().filter(x => x.dataset.name === ops[12].name)[0];
  ok(!!t13, '第 13 名干员仍在网格里');
  ok(t13.classList.contains('locked'), '满员后未选卡片置灰');
  t13.click();
  ok(cards().length === 12, '满 12 人后第 13 人被拒');
  ok(/已满/.test($('toast').textContent), '给出满员提示：' + $('toast').textContent);

  const dup = window.SquadRepo.canAdd([{ name: '玛恩纳' }], { name: '玛恩纳' });
  ok(dup.ok === false && /已经在编队/.test(dup.reason), '重复干员被拒：' + dup.reason);

  console.log('=== 网格筛选 ===');
  const guardChip = $('profFilter').children.filter(c => c.textContent === '近卫')[0];
  guardChip.click();
  const gTiles = tiles();
  ok(gTiles.length > 0 && gTiles.every(t => t.dataset.prof === '近卫'),
     '职业筛选只剩近卫（' + gTiles.length + ' 人）');
  $('profFilter').children[0].click();
  ok(tiles().length === total, '点「全部职业」恢复 ' + total + ' 人');

  const star4 = $('starFilter').children.filter(c => c.textContent === '4 星及以下')[0];
  star4.click();
  const expect4 = ops.filter(o => (o.rarity || 0) <= 4).length;
  ok(tiles().length === expect4, '「4 星及以下」筛出 ' + tiles().length + ' 人（预期 ' + expect4 + '）');
  $('starFilter').children[0].click();

  console.log('=== 藏品整卡切换 ===');
  function selectFirstRelic() {
    for (const card of $('relicList').children) {
      if (!card.dataset.id) continue;
      const cb = card.children[0].children[0];
      cb.checked = true;
      cb.onchange();
      return card.dataset.id;
    }
    return null;
  }
  const firstRelic = selectFirstRelic();
  ok(!!firstRelic, '勾选了一件藏品：' + firstRelic);
  ok(String($('relicCount').textContent) === '1', '已选数量更新为 1');

  const cBefore = Number($('relicCount').textContent);
  const free = $('relicList').children.filter(c => c.dataset.id && !c.children[0].children[0].checked)[0];
  const freeId = free.dataset.id;
  free.onclick({ target: { tagName: 'DIV', className: 'effect' } });
  ok(Number($('relicCount').textContent) === cBefore + 1, '点卡片空白处选中藏品');
  const nowSel = cardOf(freeId);
  ok(nowSel.classList.contains('selected'), '卡片进入选中态');
  nowSel.onclick({ target: { tagName: 'DIV', className: 'effect' } });
  ok(Number($('relicCount').textContent) === cBefore, '再点一次整卡 = 取消选中');

  const nameCard = cardOf(freeId);
  const nameSpan = nameCard.children[0].children[1].children[0].children[0];
  ok(String(nameSpan.className).indexOf('relic-name') >= 0, '名称链接可定位');
  nameSpan.onclick({ target: { tagName: 'SPAN', className: 'relic-name' } });
  ok(Number($('relicCount').textContent) === cBefore, '点名称链接只弹详情，不切换选中');
  ok($('modalBody').children.length > 0, '藏品详情弹窗有内容');

  // 批量勾选不崩
  let count = 0;
  for (const card of $('relicList').children) {
    if (!card.dataset.id) continue;
    const cb = card.children[0].children[0];
    if (!cb.checked) { cb.checked = true; cb.onchange(); count++; if (count > 30) break; }
  }
  ok(count > 0, '再勾选 ' + count + ' 件后依然正常');

  console.log('=== 汇总 ===');
  const sumCards = $('summaryBody').children;
  ok(sumCards.length >= 6, '汇总区渲染 ' + sumCards.length + ' 张卡片');
  const titles = sumCards.map(c => (c.children[0] || {}).textContent || '');
  ok(titles.some(t => /未计入面板/.test(t)), '汇总区有「未计入面板」卡片');
  ok(titles.some(t => /探索/.test(t)), '汇总区有「探索 / 运营」卡片');

  // ⑦ 「未计入面板」每条一个 <li>，原因作为嵌套的第二行
  const cb159 = cardOf('159').children[0].children[0];
  cb159.checked = true;
  cb159.onchange();
  const c5 = $('summaryBody').children.filter(c => /未计入面板/.test((c.children[0] || {}).textContent || ''))[0];
  const c5ul = c5.children.filter(x => x.tagName === 'UL')[0];
  const c5lis = c5ul ? c5ul.children : [];
  ok(c5lis.length > 0 && c5lis.every(li => String(li.className) === 'u-item'),
     '「未计入面板」一条一个 <li>（' + c5lis.length + ' 条）');
  ok(c5lis.every(li => li.children.some(x => String(x.className) === 'why')),
     '原因渲染为嵌套 .why，不再和条目平级');

  console.log('=== 导入坏数据 ===');
  ok(window.SquadRepo.deserialize('{不是 JSON').ok === false, '非法 JSON 返回 ok:false 而不是抛异常');
  ok(window.SquadRepo.deserialize({ squad: 'nope' }).ok === false, 'squad 不是数组时返回 ok:false');

  $('btnImport').click();
  const body = $('modalBody');
  const ta = body.children.filter(c => c.tagName === 'TEXTAREA')[0];
  const importBtn = body.children.filter(c => c.tagName === 'BUTTON')[0];
  ta.value = JSON.stringify({
    schemaVersion: 2,
    squad: [
      { name: '缺面板的干员' },                                   // 没有 panel → 丢弃
      { name: '面板缺字段', panel: { hp: 1 } },                    // 缺 atk/def → 丢弃
      { name: '好干员', panel: { hp: 100, atk: 10, def: 5 } }      // 有效
    ]
  });
  importBtn.click();
  ok(cards().length === 1, '坏条目被丢弃，只剩 1 个有效干员');
  ok(/已忽略 2 条/.test($('toast').textContent), '提示忽略数量：' + $('toast').textContent);

  console.log('=== 常用编队 ===');
  $('presetName').value = '测试队';
  $('btnSaveSquad').click();
  const chips = () => $('presetList').children.filter(c => c.className === 'preset');
  ok(chips().length === 1, '保存编队后出现 1 个预设');
  const chip = chips()[0];
  $('btnAddBlank').click();
  const before = cards().length;
  chip.children[2].onclick();   // 载入
  ok(cards().length === before - 1, '载入预设后队伍人数恢复为保存时的 ' + (before - 1));
  chip.children[4].onclick();   // 删
  ok(chips().length === 0, '删除预设生效');

  console.log('=== 清空 ===');
  $('btnReset').click();
  ok(cards().length === 0 && String($('relicCount').textContent) === '0', '「清空」清掉编队与藏品');
  ok(chips().length === 0, '「清空」也清掉常用编队');

  console.log('=== 空白干员可连续添加 ===');
  $('btnAddBlank').click();
  $('btnAddBlank').click();
  ok(cards().length === 2, '连点两次「空白干员」→ ' + cards().length + ' 张卡');
  ok(cards()[1].children[0].children[0].value === '新干员 2',
     '第二张自动命名为「新干员 2」：' + cards()[1].children[0].children[0].value);
  const blankGrid = cards()[0].querySelector('[data-role="panel"]');
  ok(String(blankGrid.children[6].children[0].value) === '1',
     '空白干员阻挡数默认为 1（实际 ' + blankGrid.children[6].children[0].value + '）');
  ok(String(blankGrid.children[4].children[0].value) === '100', '空白干员攻速默认 100');
  ok(String(cards()[0].children[1].tagName).toLowerCase() === 'details' && cards()[0].children[1].open === true,
     '空白干员的面板编辑区默认展开（否则用户不知道该填哪里）');

  console.log('=== 同名干员按 id 判重 ===');
  $('btnReset').click();
  const opList = window.OperatorRepo.all();
  const pickOp = (i) => tiles().filter(x => x.dataset.name === opList[i].name)[0];
  pickOp(0).click();
  pickOp(1).click();
  ok(cards().length === 2, '加入 2 名干员');
  ok(cards()[0].children[1].open !== true, '内置干员的面板编辑区默认收起（卡片更矮，一屏能看多人）');
  $('btnToggleEdit').click();
  ok(cards()[0].children[1].open === true, '「展开面板」批量展开所有卡片');
  ok(/收起面板/.test($('btnToggleEdit').textContent), '按钮文案切换为「收起面板」');
  $('btnToggleEdit').click();
  ok(cards()[0].children[1].open !== true, '再点一次批量收起');
  const dupName = opList[1].name;
  const nameInput = cards()[0].children[0].children[0];
  nameInput.value = dupName;
  nameInput.oninput();
  ok(/同名/.test($('toast').textContent), '改名撞名给出轻提示：' + $('toast').textContent);
  ok(cards().length === 2, '同名不阻断输入，两人都在编队里');
  await sleep(260);
  const dupSaved = savedState();
  ok(dupSaved.squad.length === 2 && dupSaved.squad[0].name === dupName, '存档里两条同名记录都写进去了');
  const dupReread = window.SquadRepo.deserialize(dupSaved);
  ok(dupReread.ok && dupReread.squad.length === 2 && dupReread.dropped === 0,
     '重载后仍是 2 人（按 id 去重）：' + dupReread.squad.length + ' 人 / 丢弃 ' + dupReread.dropped);

  console.log('=== 清空名字不丢人 ===');
  const rEmpty = window.SquadRepo.deserialize({
    schemaVersion: 2, squad: [{ id: 'op_e1', name: '', panel: { hp: 1, atk: 1, def: 1 } }]
  });
  ok(rEmpty.ok && rEmpty.squad.length === 1 && rEmpty.dropped === 0,
     'name 为空串的存档读回 ' + rEmpty.squad.length + ' 人 / 丢弃 ' + rEmpty.dropped);
  ok(rEmpty.squad[0].name === '未命名干员', '空名兜底为「未命名干员」：' + rEmpty.squad[0].name);
  const rSpace = window.SquadRepo.deserialize({
    schemaVersion: 2, squad: [{ id: 'op_e2', name: '   ', panel: { hp: 1, atk: 1, def: 1 } }]
  });
  ok(rSpace.ok && rSpace.squad.length === 1 && rSpace.dropped === 0,
     'name 为纯空格的存档读回 ' + rSpace.squad.length + ' 人 / 丢弃 ' + rSpace.dropped);

  // 界面侧全链路：清空名字框 → 失焦兜底 → 落盘 → 重载仍是同一条干员
  $('btnReset').click();
  $('btnAddBlank').click();
  const nmIn = cards()[0].children[0].children[0];
  nmIn.value = '';
  nmIn.oninput();
  ok(cards().length === 1, '输入过程中允许名字临时为空，卡片不消失');
  nmIn.onblur();
  ok(nmIn.value === '未命名干员', '失焦后名字兜底为「未命名干员」：' + nmIn.value);
  await sleep(260);
  const rereadBlank = window.SquadRepo.deserialize(savedState());
  ok(rereadBlank.ok && rereadBlank.squad.length === 1 && rereadBlank.dropped === 0,
     '清空名字后重载仍是 ' + rereadBlank.squad.length + ' 人 / 丢弃 ' + rereadBlank.dropped);

  console.log('=== 网格保留滚动位置 ===');
  $('opGrid').scrollTop = 120;
  const unpicked = tiles().filter(x => !x.classList.contains('on'))[0];
  unpicked.click();
  ok($('opGrid').scrollTop === 120, '点选后网格滚动位置保留（' + $('opGrid').scrollTop + '）');

  console.log('=== 层数控件（196 / 108 / 152） ===');
  $('btnReset').click();
  tiles().filter(x => !x.classList.contains('on'))[0].click();
  const finalOf = (label) => {
    const res = cards()[0].querySelector('[data-role="result"]');
    const rows = res.children[0].children[1].children;
    const row = rows.filter(r => r.children[0].textContent === label)[0];
    return row ? Number(row.children[2].textContent) : NaN;
  };
  const controlsOf = (id) => {
    const card = cardOf(id);
    return card ? card.children.filter(c => String(c.className).indexOf('relic-controls') >= 0) : [];
  };
  const stackInputOf = (id) => {
    for (const ctrl of controlsOf(id)) {
      for (const kid of ctrl.children) {
        if (kid.tagName === 'INPUT' && String(kid.className).indexOf('stack') >= 0) return kid;
        for (const g of kid.children || []) {
          if (g.tagName === 'INPUT' && String(g.className).indexOf('stack') >= 0) return g;
        }
      }
    }
    return null;
  };
  const pickRelic = (id) => {
    const cb = cardOf(id).children[0].children[0];
    cb.checked = true;
    cb.onchange();
  };

  const atkBefore = finalOf('攻击力');
  pickRelic('196');
  ok(controlsOf('196').length === 1, '选中 196 后渲染出控制条');
  const stack196 = stackInputOf('196');
  ok(!!stack196, '196 有层数输入框');
  stack196.value = '10';
  stack196.oninput();
  const atkAfter = finalOf('攻击力');
  ok(atkAfter !== atkBefore, '196 设 10 层后攻击力变化：' + atkBefore + ' → ' + atkAfter);

  pickRelic('108');
  ok(!!stackInputOf('108'), '108 传芳雕版也能设层数');
  pickRelic('152');
  ok(!stackInputOf('152'), '152 断杖-波纹（perProfession，由场上术师人数驱动）没有层数输入框');
  ok(!!stackInputOf('196'), '196 的层数输入框不受影响');

  console.log('=== 条件类藏品（144 钝爪-百战：战斗开始 60 秒内） ===');
  $('btnReset').click();
  tiles().filter(x => x.dataset.prof === '先锋')[0].click();
  const baseAtkOf = () => {
    const rows = cards()[0].querySelector('[data-role="result"]').children[0].children[1].children;
    const row = rows.filter(r => r.children[0].textContent === '攻击力')[0];
    return Number(row.children[1].textContent);
  };
  const setTime = (v) => {
    const inp = $('ctxTime');
    inp.value = String(v);
    (inp.handlers.input || []).forEach(fn => fn.call(inp));
  };
  const baseAtk = baseAtkOf();
  pickRelic('144');
  setTime(30);
  ok(finalOf('攻击力') === Math.floor(baseAtk * 2),
     't=30（60 秒内）时 144 的 +100% 攻击生效：' + baseAtk + ' → ' + finalOf('攻击力'));
  setTime(90);
  ok(finalOf('攻击力') === baseAtk,
     't=90（超出 60 秒）后攻击力回到 ' + baseAtk + '（实际 ' + finalOf('攻击力') + '）');
  const previewDetail = $('workspacePreview').children.filter(c => c.className === 'preview-detail')[0];
  const previewUnmet = previewDetail && previewDetail.children.filter(c => c.className === 'preview-unmet')[0];
  ok(!!previewUnmet && previewUnmet.children.some(c => /钝爪/.test(c.textContent)),
     '主工作区直接列出未生效藏品及原因');

  // ④ 条件未满足的项不计入合计，但要在卡片底部留一行计数提示
  const panelCard = $('summaryBody').children
    .filter(c => /面板加成/.test((c.children[0] || {}).textContent || ''))[0];
  const unmetEl = panelCard.children.filter(c => String(c.className) === 'unmet')[0];
  const panelLis = panelCard.children.filter(c => c.tagName === 'UL')
    .reduce((acc, ul) => acc.concat(ul.children), []);
  ok(!!unmetEl && /另有 2 项条件未满足/.test(unmetEl.textContent),
     '汇总区提示未满足项：' + (unmetEl && unmetEl.textContent));
  ok(!panelLis.some(li => /攻击力/.test((li.children[0] || {}).textContent || '')),
     '未满足项没有混进数值合计');
  $('btnProfAuto').click();
  ok($('profCounts').children.length === 8, '按编队填充职业人数正常');

  console.log('=== 触发类效果开关（116） ===');
  $('btnReset').click();
  tiles().filter(x => !x.classList.contains('on'))[0].click();
  pickRelic('116');
  ok(!$('ctxProc').checked, '「触发类效果生效」默认不勾选');
  const aspdOff = finalOf('攻击速度');
  $('ctxProc').checked = true;
  $('ctxProc').change();
  const aspdOn = finalOf('攻击速度');
  ok(aspdOn === aspdOff + 100, '勾选后 116 的 +100 攻速生效：' + aspdOff + ' → ' + aspdOn);
  $('ctxProc').checked = false;
  $('ctxProc').change();
  ok(finalOf('攻击速度') === aspdOff, '取消勾选后回到未生效');

  console.log('=== 零件估值输入 ===');
const ctxValue = doc.getElementById('ctxValue');
ok(!!ctxValue, '战斗状态里有「零件估值」输入');
ctxValue.value = '20';
(ctxValue.handlers.input || []).forEach(fn => fn.call(ctxValue));
ok(true, '填零件估值不报错');

console.log('=== 伤害估算卡 ===');
const dmgOut = doc.getElementById('dmgOut');
ok(dmgOut.children.length >= 4, '伤害估算渲染了 3 个结果 + 1 行说明（' + dmgOut.children.length + '）');
const dmgAtk = doc.getElementById('dmgAtk');
dmgAtk.value = '2000';
(dmgAtk.handlers.input || []).forEach(fn => fn.call(dmgAtk));
ok(String(dmgOut.children[0].children[1].textContent) !== '0', '改攻击力后物理伤害随之变化');
const dmgDef = doc.getElementById('dmgDef');
dmgDef.value = '500';
(dmgDef.handlers.input || []).forEach(fn => fn.call(dmgDef));
ok(true, '改敌方防御不报错');

console.log('=== 编队槽位条 ===');
$('btnReset').click();
tiles()[0].click();
const strip = $('squadStrip');
ok(strip.children.length === 12, '槽位条固定 12 格（' + strip.children.length + '）');
ok(String(strip.children[0].className).indexOf('empty') < 0, '第 1 格是已占用槽位');
ok(String(strip.children[1].className).indexOf('empty') >= 0, '第 2 格是空槽位');
ok(/先锋|近卫|重装|狙击|术师|医疗|辅助|特种/.test(strip.children[0].dataset.prof || ''),
   '槽位带职业色标：' + strip.children[0].dataset.prof);
// 点空槽 = 打开选择器（不用先去点顶部按钮）
$('btnTogglePicker').click();
ok($('opPicker').classList.contains('hidden'), '先收起选择器');
strip.children[1].click();
ok(!$('opPicker').classList.contains('hidden'), '点空槽位直接打开选择器');
// 点满槽 = 定位到卡片，不抛异常
let slotErr = null;
try { strip.children[0].click(); } catch (e) { slotErr = e; }
ok(!slotErr, '点已占用槽位不报错');
// 槽位右上角的 × 直接移出
const slotX = strip.children[0].children.filter(x => String(x.className) === 'slot-x')[0];
ok(!!slotX, '槽位带移出按钮');
slotX.click();
ok(cards().length === 0, '从槽位移出后编队为空');
const undo = $('toast').children.filter(x => x.tagName === 'BUTTON' && x.textContent === '撤销')[0];
ok(!!undo, '移出干员后提供撤销入口');
if (undo) undo.click();
ok(cards().length === 1, '撤销后干员及面板恢复');
const deleteBtn = cards()[0].children[0].children.filter(x => String(x.className).indexOf('del') >= 0)[0];
if (deleteBtn) deleteBtn.click();
ok(cards().length === 0, '卡片删除仍可正常移出干员');

console.log('=== 汇总行展开来源 ===');
$('btnReset').click();
pickRelic('003');
// 面板 / 战斗 / 探索 三张卡里任取第一行带来源明细的
let gLine = null;
for (const c of $('summaryBody').children) {
  for (const ul of c.children.filter(x => x.tagName === 'UL')) {
    const hit = ul.children.filter(x => String(x.className).indexOf('g-line') >= 0)[0];
    if (hit) { gLine = hit; break; }
  }
  if (gLine) break;
}
ok(!!gLine, '汇总行是 .g-line');
const gDet = gLine.children.filter(x => x.tagName === 'UL')[0];
ok(!!gDet && gDet.children.length > 0, '每行内嵌来源明细（' + (gDet ? gDet.children.length : 0) + ' 条）');
ok(String(gLine.className).indexOf('open') < 0, '来源明细默认收起');
gLine.click();
ok(String(gLine.className).indexOf('open') >= 0, '点击展开来源');
gLine.click();
ok(String(gLine.className).indexOf('open') < 0, '再点收起');

console.log('=== 编队面板对照表 ===');
const tableOf = () => $('squadTableBox').children
  .filter(c => /编队面板对照/.test((c.children[0] || {}).textContent || ''))[0];
ok(!!tableOf(), '汇总页顶部有「编队面板对照」卡（不再埋在六张卡片后面）');
ok(tableOf().children.filter(x => String(x.className) === 'empty').length === 1,
   '编队为空时显示引导文案而不是空表');
tiles()[0].click();
const tbl = tableOf();
ok(tbl.children.filter(x => x.tagName === 'TABLE').length === 1, '对照表渲染成 table');
const tbody = tbl.children.filter(x => x.tagName === 'TABLE')[0].children.filter(x => x.tagName === 'TBODY')[0];
ok(tbody.children.length === 1, '表体 1 行对应 1 名干员');
// 行式化：每格是「最终值 + 变化量 + 涨幅%」，悬停给出「基础 → 最终」
const row0 = tbody.children[0];
const numCells = row0.children.filter(c => String(c.className) === 'num');
ok(numCells.length === 6, '每行 6 个数值格（生命/攻击/防御/法抗/攻速/费用）');
const atkCell = numCells[1];
const pctCell = atkCell.children.filter(c => /^pc/.test(String(c.className)))[0];
ok(atkCell.children.length >= 2, '攻击格显示最终值 + 变化量');
ok(!!pctCell && /^[+-]\d+(\.\d)?%$/.test(pctCell.textContent),
   '攻击格带涨幅百分比：' + (pctCell ? pctCell.textContent : '（缺）'));
ok(/→|无变化/.test(String(atkCell.title)), '悬停标题给出基础值对照：' + atkCell.title);

console.log('=== 职业人数步进器 ===');
$('btnReset').click();
const pc0 = $('profCounts').children[0];
ok(pc0.children.filter(x => String(x.className) === 'pc-name')[0].textContent.length > 1,
   '职业名不再压成单字：' + pc0.children.filter(x => String(x.className) === 'pc-name')[0].textContent);
pc0.children.filter(x => String(x.className) === 'pc-btn')[1].click();
const valOf = () => $('profCounts').children[0].children.filter(x => String(x.className) === 'pc-val')[0].textContent;
ok(valOf() === '1', '点「+」后职业人数为 1（实际 ' + valOf() + '）');
$('profCounts').children[0].children.filter(x => String(x.className) === 'pc-btn')[0].click();
ok(valOf() === '0', '点「−」回到 0');

console.log('=== 伤害估算：用编队干员面板 ===');
$('btnReset').click();
tiles()[0].click();
const dmgSel = $('dmgFromOp');
ok(dmgSel.children.length === 2, '下拉含 1 名干员 + 占位项');
dmgSel.value = '0';
(dmgSel.handlers.change || []).forEach(fn => fn.call(dmgSel));
ok(Number($('dmgAtk').value) > 0, '选干员后攻击力被填入：' + $('dmgAtk').value);

// 技能下拉：选完干员才能用，名字里直接标出能用的倍率
const skillSel = $('dmgFromSkill');
ok(!skillSel.disabled && skillSel.children.length > 1,
   '选干员后技能下拉可用（' + skillSel.children.length + ' 项）');
const withScale = skillSel.children.filter(c => c.value !== '' && /×/.test(c.textContent));
const noScale = skillSel.children.filter(c => c.value !== '' && !/×/.test(c.textContent));
ok(withScale.length > 0, '技能名里标出可用的倍率：' + (withScale[0] || {}).textContent);

skillSel.value = withScale[0].value;
(skillSel.handlers.change || []).forEach(fn => fn.call(skillSel));
ok(Number($('dmgScale').value) > 0 && Number($('dmgScale').value) !== 1,
   '倍率被填成 ' + $('dmgScale').value);
ok(/持续|SP/.test($('dmgSkillNote').textContent),
   '给出技能描述让人核对：' + $('dmgSkillNote').textContent);

if (noScale.length) {
  const before = Number($('dmgScale').value);
  skillSel.value = noScale[0].value;
  (skillSel.handlers.change || []).forEach(fn => fn.call(skillSel));
  ok(Number($('dmgScale').value) === before, '认不出倍率的技能不擅自改倍率');
  ok(/手填/.test($('toast').textContent), '并提示手填：' + $('toast').textContent);
}

  console.log('=== 弹窗 ===');
  $('btnHelp').click();
  ok($('modalBody').children.length > 0, '公式说明弹窗有内容');
  // 数据版本块：用户反馈数值问题时靠它确认双方看的是不是同一份数据
  const metaBox = $('modalBody').children.filter(c => String(c.className).indexOf('data-meta') >= 0)[0];
  ok(!!metaBox && metaBox.children.length >= 12, '公式说明里有数据版本块（' + (metaBox ? metaBox.children.length : 0) + ' 格）');
  // 构建时间在数据里存的是 UTC（…Z），直接显示会比本地时钟差几小时
  const metaVals = metaBox.children
    .filter(c => String(c.className).indexOf('data-meta-v') >= 0)
    .map(c => String(c.textContent));
  const built = metaVals.filter(v => v.indexOf('（本地）') >= 0)[0];
  ok(!!built && !/Z$/.test(built), '构建时间已转成本地时区：' + (built || '(缺失)'));
  $('btnExport').click();
  ok($('modalBody').children.length > 0, '导出弹窗有内容');

  console.log('=== 干员详情（精英化 / 技能 / 天赋 / 模组 / 范围） ===');
  // 回归：operators 表把 favor 拍成了 favorHp/favorAtk/favorDef 三列，
  // makeSquadEntry 只认嵌套的 favor 时信赖会静默变成 0（面板整体偏低且勾选框不显示）。
  const yh = window.OperatorRepo.getByName('银灰');
  const yEntry = window.OperatorRepo.makeSquadEntry(yh);
  ok(yEntry.favor.atk === yh.favorAtk && yEntry.favor.atk > 0,
     'makeSquadEntry 从拍平的 favorAtk 列读到信赖（' + yEntry.favor.atk + '）');
  const yCalc = window.OperatorRepo.toCalcInput(yEntry);
  ok(yCalc.panel.atk === yh.atk + yh.favorAtk,
     'toCalcInput 叠加信赖后攻击力 ' + yh.atk + '→' + yCalc.panel.atk);
  ok(yCalc.panel.def === yh.def + yh.favorDef,
     'toCalcInput 叠加信赖后防御力 ' + yh.def + '→' + yCalc.panel.def);

  const walk = (node, pred, out) => {
    out = out || [];
    (node.children || []).forEach(c => {
      if (pred(c)) out.push(c);
      walk(c, pred, out);
    });
    return out;
  };
  $('btnReset').click();
  tiles()[0].click();
  await sleep(260);
  const detailBtn = () => walk(cards()[0], c => c.textContent === '详情')[0];
  ok(!!detailBtn(), '编队卡上有「详情」按钮');
  detailBtn().click();

  const dB = $('modalBody');
  const dTitle = dB.children.filter(c => c.tagName === 'H2')[0];
  ok(!!dTitle && /★/.test(dTitle.textContent), '详情标题带星级：' + (dTitle && dTitle.textContent));
  const sections = dB.children.filter(c => c.tagName === 'H3').map(c => c.textContent);
  ok(sections.indexOf('精英化面板') >= 0, '有「精英化面板」小节');
  ok(sections.indexOf('技能') >= 0, '有「技能」小节');
  ok(sections.indexOf('天赋') >= 0, '有「天赋」小节');
  ok(sections.some(t => /攻击范围/.test(t)), '有「攻击范围」小节');

  const phaseRows = walk(dB, c => c.tagName === 'TR');
  ok(phaseRows.length >= 4, '精英化表至少有表头 + 3 行（实际 ' + phaseRows.length + ' 行）');
  const useBtns = walk(dB, c => c.textContent === '用此面板');
  ok(useBtns.length === 3, '三档各有一个「用此面板」按钮（实际 ' + useBtns.length + '）');

  const cells = walk(dB, c => String(c.className).indexOf('range-cell') >= 0);
  ok(cells.length >= 1, '攻击范围画出了格子（' + cells.length + ' 格）');
  ok(cells.filter(c => c.classList.contains('self')).length === 1, '攻击范围里有且只有一格是「自己」');

  // 点「用此面板」应把该档面板写进编队
  const panelOf = () => JSON.stringify(savedSquads()[0].panel);
  const firstUse = useBtns[0];
  const panelBefore = panelOf();
  firstUse.click();
  await sleep(260);
  ok($('modal').classList.contains('hidden'), '用完此面板后弹窗关闭');
  const panelAfter = panelOf();
  ok(panelBefore !== panelAfter, 'E0 面板与默认 E2 面板不同，确实被替换了');
  ok(/面板/.test($('toast').textContent), '提示已换面板：' + $('toast').textContent);

  // 手动改过名字的干员在图鉴里查不到，不能崩
  const nameIn = cards()[0].children[0].children[0];
  nameIn.value = '不存在的干员';
  nameIn.oninput();
  detailBtn().click();
  ok(/图鉴里没有/.test($('toast').textContent), '查不到的干员给出提示而不是白屏：' + $('toast').textContent);
  $('modalClose').click();

  console.log('=== 头像白名单（存档可被粘贴，不能带外链） ===');
  const avatarOf = v => {
    const r = window.SquadRepo.deserialize({
      squad: [{ name: 'X', panel: { hp: 1, atk: 1, def: 1 }, avatar: v }]
    });
    return r.ok && r.squad[0] ? r.squad[0].avatar : '(读取失败)';
  };
  ok(avatarOf('https://evil.example/x.png') === '', 'http(s) 外链头像被丢弃');
  ok(avatarOf('//evil.example/x.png') === '', '协议相对外链被丢弃');
  ok(avatarOf('javascript:alert(1)') === '', 'javascript: 伪协议被丢弃');
  ok(avatarOf('assets/a.png') === 'assets/a.png', '本站相对路径保留');
  ok(avatarOf('data:image/png;base64,AAA') === 'data:image/png;base64,AAA', 'data:image 内联图保留');
  ok(avatarOf('') === '', '空头像仍是空串');

  console.log('=== 存档：主键损坏时回退备份 ===');
  $('btnReset').click();
  tiles().filter(x => !x.classList.contains('on'))[0].click();
  await sleep(260);
  const goodMain = global.localStorage._d['is6calc.v1'];
  ok(!!goodMain && !!global.localStorage._d['is6calc.v1.bak'], '写入时同时留下了备份键');
  global.localStorage._d['is6calc.v1.bak'] = goodMain;      // 备份 = 一份好存档
  global.localStorage._d['is6calc.v1'] = '{ 这不是 JSON';    // 主键被写坏
  doc._ready.forEach(fn => fn());                            // 等价于刷新一次
  ok(cards().length === 1, '主键损坏后从备份恢复出 1 名干员（实际 ' + cards().length + '）');
  ok(/备份/.test($('toast').textContent), '提示从备份恢复：' + $('toast').textContent);

  console.log('=== 存档：写失败不能静默 ===');
  const realSetItem = global.localStorage.setItem;
  global.localStorage.setItem = function (k, v) {
    if (k === 'is6calc.v1') {
      const e = new Error('quota exceeded');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return realSetItem.call(this, k, v);
  };
  $('btnReset').click();
  await sleep(260);
  ok(/存储已满/.test($('toast').textContent), '写失败时明确提示存储已满：' + $('toast').textContent);
  global.localStorage.setItem = realSetItem;
  $('btnReset').click();
  ok(/已清空/.test($('toast').textContent), '存储恢复后能正常写入并提示：' + $('toast').textContent);

  console.log('=== 无障碍：Esc 关弹窗 / aria 状态 ===');
  $('btnHelp').click();
  ok(!$('modal').classList.contains('hidden'), '弹窗已打开');
  (doc._on && doc._on.keydown || []).forEach(fn => fn({ key: 'Escape', preventDefault() {} }));
  ok($('modal').classList.contains('hidden'), 'Esc 能关掉弹窗');
  $('tabSummary').click();
  ok($('tabSummary').getAttribute('aria-selected') === 'true', '切页后 aria-selected=true');
  ok($('tabSquad').getAttribute('aria-selected') === 'false', '离开的页 aria-selected=false');
  $('tabSquad').click();
  $('btnTogglePicker').click();
  const t0 = tiles()[0];
  ok(t0.getAttribute('role') === 'button', '网格卡片有 role=button');
  ok(/未在编队|已在编队/.test(t0.getAttribute('aria-label') || ''),
     '网格卡片有可访问名：' + t0.getAttribute('aria-label'));
  ok(t0.getAttribute('tabindex') === '0', '网格卡片可键盘聚焦');

  console.log('=== 分享链接往返 ===');
  $('btnReset').click();
  tiles()[0].click();
  await sleep(260);
  $('btnShare').click();
  const shareTa = $('modalBody').children.filter(c => c.tagName === 'TEXTAREA')[0];
  const shareLink = shareTa ? shareTa.value : '';
  ok(/^http:\/\/localhost:8000\/index\.html#cfg=/.test(shareLink),
     '分享链接带 #cfg=：' + shareLink.slice(0, 46) + '…');
  ok(shareLink.length < 6000, '单编队分享链接长度 ' + shareLink.length + ' 字符（未超 6000 上限）');
  $('btnReset').click();
  await sleep(260);
  ok(cards().length === 0, '清空后编队为空');
  global.location.hash = shareLink.slice(shareLink.indexOf('#'));
  doc._ready.forEach(fn => fn());            // 等价于打开这个链接
  ok(cards().length === 1, '打开分享链接后还原出 1 名干员（实际 ' + cards().length + '）');
  ok(/已载入分享的配置/.test($('toast').textContent), '提示已载入分享配置：' + $('toast').textContent);
  ok(global.location.hash === '', 'hash 被清掉，刷新不会重复覆盖用户后续改动');

  console.log('=== 分享链接：满编 12 人也要塞得进 URL ===');
  $('btnReset').click();
  const pool = window.OperatorRepo.all();
  for (let i = 0; i < 12; i++) {
    const t = tiles().filter(x => x.dataset.name === pool[i].name)[0];
    if (t) t.click();
  }
  ok(cards().length === 12, '先加满 12 人（实际 ' + cards().length + '）');
  await sleep(260);
  $('btnShare').click();
  const fullTa = $('modalBody').children.filter(c => c.tagName === 'TEXTAREA')[0];
  const fullLink = fullTa ? fullTa.value : '';
  ok(fullLink.length > 0 && fullLink.length < 6000,
     '12 人满编链接 ' + fullLink.length + ' 字符（上限 6000，v3 存档直编会是 ~14000）');
  $('modalClose').click();

  console.log('=== 藏品键盘流（不碰鼠标连续录入）===');
  $('btnReset').click();
  const searchBox = $('search');
  searchBox.value = '折戟';
  searchBox.keydown('Enter');
  ok(Number($('relicCount').textContent) === 1, '输入名称 + 回车直接选中');
  ok(searchBox.value === '', '回车后输入框清空，可接着录下一件');
  searchBox.value = '折戟';
  searchBox.keydown('Enter');
  ok(Number($('relicCount').textContent) === 0, '同一件再回车一次 = 取消选中');

  searchBox.value = '';
  searchBox.keydown('Escape');
  ok($('relicList').children.filter(c => c.dataset.id).length === 251, 'Esc 清空后恢复全部 251 件');

  searchBox.keydown('ArrowDown');
  ok($('relicList').children.filter(c => String(c.className).indexOf('cursor') >= 0).length === 1,
     '↓ 高亮一件');
  searchBox.keydown('ArrowDown');
  ok($('relicList').children.filter(c => String(c.className).indexOf('cursor') >= 0).length === 1,
     '再按 ↓ 仍然只有一件高亮（不累积）');
  searchBox.keydown('Enter');
  ok(Number($('relicCount').textContent) === 1, '回车选中高亮项');

  ok($('relicList').children.filter(c => c.dataset.id && c.classList.contains('r2')).length > 0,
     '稀有度色条类名已挂上（紧凑瓦片里标签是隐藏的）');

  console.log('=== 批量录入（粘贴藏品名）===');
  $('btnReset').click();
  $('btnPaste').click();
  const pasteTa = $('modalBody').children.filter(c => c.tagName === 'TEXTAREA')[0];
  ok(!!pasteTa, '批量录入弹窗有输入框');
  pasteTa.value = '折戟-锋刃、猎印\n1. 残弩-新典训\n不存在的藏品名';
  const pasteBtn = $('modalBody').children.filter(c => c.tagName === 'BUTTON' && /解析/.test(c.textContent))[0];
  ok(!!pasteBtn, '有「解析并勾选」按钮');
  pasteBtn.onclick();
  ok(Number($('relicCount').textContent) === 3, '三种写法都匹配上（实际 ' + $('relicCount').textContent + ' 件）');
  const pasteMsg = $('modalBody').children.filter(c => /未找到/.test(c.textContent))[0];
  ok(!!pasteMsg && /不存在的藏品名/.test(pasteMsg.textContent), '未匹配的条目原样列出，不静默丢弃');
  $('modalClose').click();

  console.log('=== 藏品按编队收敛（默认只淡化，不隐藏）===');
  $('btnReset').click();
  const relicCardCount = () => $('relicList').children.filter(c => c.dataset && c.dataset.id).length;
  const dimmed = () => $('relicList').children.filter(c => c.dataset && c.dataset.id && c.classList.contains('off'));
  const noteText = () => $('relicScopeNote').children.map(c => c.textContent || '').join(' ');
  const noteBtn = re => $('relicScopeNote').children
    .filter(c => c.tagName === 'BUTTON' && re.test(c.textContent))[0];

  ok(relicCardCount() === 251, '空编队时 251 件全在');
  ok($('relicScopeNote').children.length === 0, '没有编队时不显示收敛提示条');

  tiles()[0].click();
  ok(cards().length === 1, '加 1 名干员后编队非空（实际 ' + cards().length + '）');
  ok(relicCardCount() === 251, '默认不隐藏：编队非空时仍然渲染 251 件');
  ok(dimmed().length > 0 && dimmed().length < 251,
     '与本队无关的 ' + dimmed().length + ' 件被淡化，其余保留');
  ok(/与本队无关/.test(noteText()), '提示条说明淡化含义：' + noteText());
  // 提示条的件数必须等于肉眼看到的淡化瓦片数：已选中的无关藏品不淡化，也不能被算进去
  const offNum = () => +((/淡化的 (\d+) 件/.exec(noteText()) || [])[1] || -1);
  ok(offNum() === dimmed().length,
     '提示条件数与实际淡化数一致（' + offNum() + ' / ' + dimmed().length + '）');

  // 先勾一件「无关」藏品：收敛后它必须还在，否则玩家取消不掉
  const offId = dimmed()[0].dataset.id;
  const offBefore = offNum();
  dimmed()[0].click();
  ok(!!cardOf(offId) && !cardOf(offId).classList.contains('off'),
     '勾选后该藏品不再淡化（已选中的永远显示）');
  ok(offNum() === offBefore - 1, '勾选后提示条件数跟着减 1（' + offNum() + '）');

  const onlyBtn = noteBtn(/只看这些/);
  ok(!!onlyBtn, '淡化模式下有「只看这些」按钮');
  onlyBtn.click();
  const narrowed = $('relicList').children.filter(c => c.dataset && c.dataset.id);
  ok(narrowed.length < 251 && narrowed.length > 0, '收敛后只剩 ' + narrowed.length + ' 件');
  ok(narrowed.every(c => !c.classList.contains('off')), '收敛后列表里没有淡化项');
  ok(!!cardOf(offId), '已选中的无关藏品在收敛后仍可见（能取消）');

  const backBtn = noteBtn(/显示全部/);
  ok(!!backBtn, '收敛模式下有「显示全部」按钮');
  backBtn.click();
  ok(relicCardCount() === 251, '「显示全部」恢复 251 件');
  ok(!!cardOf(offId) && String($('relicCount').textContent) === '1', '恢复全部后选择态没丢');

  cardOf(offId).click();
  ok(String($('relicCount').textContent) === '0', '再点一次取消选中');
  $('btnReset').click();

  console.log('=== 首屏结论 + 一键示例 ===');
  // 结论条是多层嵌套的 span/b，桩里的 textContent 不会聚合子节点，得自己递归拼
  const deepText = n => {
    if (!n) return '';
    if (n.nodeType === 3) return n.textContent;
    if (n.children && n.children.length) return n.children.map(deepText).join('');
    return n.textContent || '';
  };
  const verdictText = () => deepText($('verdict'));
  const verdictBtn = re => $('verdict').children
    .filter(c => c.tagName === 'BUTTON' && re.test(c.textContent))[0];

  ok(/还没有干员和藏品/.test(verdictText()), '空状态给出一句话引导：' + verdictText());
  const demoBtn = verdictBtn(/载入示例/);
  ok(!!demoBtn, '空状态有「载入示例」按钮');
  ok(!!verdictBtn(/添加干员/), '空状态有「添加干员」按钮');

  demoBtn.click();
  ok(cards().length === 6, '示例载入 6 名干员（实际 ' + cards().length + '）');
  ok(Number($('relicCount').textContent) === 8, '示例勾上 8 件藏品（实际 ' + $('relicCount').textContent + '）');
  ok(/8 件藏品/.test(verdictText()), '结论条显示藏品件数：' + verdictText());
  ok(/项加成生效/.test(verdictText()), '结论条显示生效项数');
  ok(/全队平均 攻击 \+/.test(verdictText()), '结论条给出全队平均攻击涨幅：' + verdictText());
  ok(/已载入示例/.test($('toast').textContent), '提示已载入示例：' + $('toast').textContent);

  console.log('=== 主工作区实时结果 ===');
  const preview = () => $('workspacePreview');
  const statButtons = () => preview().children.filter(c => c.className === 'preview-stats')[0].children;
  ok(/实时结果/.test(deepText(preview())), '编队页直接展示当前干员结果');
  ok(statButtons().length === 6, '关键面板一屏显示 6 项');
  const previewAtkBefore = deepText(statButtons()[0]);
  const nextRelic = $('relicList').children.filter(c => c.dataset && c.dataset.id && !savedState().relics[c.dataset.id])[0];
  if (nextRelic) nextRelic.children[0].children[0].checked = true, nextRelic.children[0].children[0].change();
  ok(/实时结果/.test(deepText(preview())) && !!previewAtkBefore, '选藏品后结果区仍在原位并刷新');
  statButtons()[1].click();
  ok(statButtons()[1].getAttribute('aria-pressed') === 'true', '切换属性时来源明细同步切换');
  $('tabSummary').click();
  $('quickResults').click();
  ok($('tabSquad').getAttribute('aria-selected') === 'true', '手机结果入口返回主工作区');
  if (nextRelic) {
    const cb = cardOf(nextRelic.dataset.id).children[0].children[0];
    cb.checked = false;
    cb.change();
  }

  // 同一份示例跑两次必须一模一样，否则「示例」就不可复现
  const squadNames = () => (savedState().squad || []).map(o => o.name).join(',');
  const firstPick = Object.keys(savedState().relics).sort().join(',');
  const firstSquad = squadNames();
  $('btnReset').click();
  verdictBtn(/载入示例/).click();
  ok(Object.keys(savedState().relics).sort().join(',') === firstPick, '示例藏品可复现（两次一致）');
  ok(squadNames() === firstSquad, '示例编队可复现（两次一致）');
  $('btnReset').click();

  console.log('=== 技能查询页（不选藏品也能用）===');
  $('tabSkill').click();
  ok($('tabSkill').getAttribute('aria-selected') === 'true', '技能页能切过去');
  ok(String($('paneSkill').className).indexOf('on') >= 0, '技能页面板显示');
  const skillGrid = () => $('skillBody').children.filter(c => String(c.className) === 'skill-ops')[0];
  ok(!!skillGrid() && skillGrid().children.length > 0,
     '没编队没藏品也列出干员（' + (skillGrid() ? skillGrid().children.length : 0) + ' 名）');

  $('skillSearch').value = 'Mechanist';
  $('skillSearch').handlers.input.forEach(fn => fn.call($('skillSearch')));
  await sleep(260);
  ok(skillGrid() && skillGrid().children.length === 1, '搜索后只剩 1 名（实际 ' +
     (skillGrid() ? skillGrid().children.length : 0) + '）');
  ok(/共 1 名/.test($('skillHint').textContent), '顶部说明匹配数量：' + $('skillHint').textContent);

  $('skillSearch').keydown('Enter');
  const cards2 = $('skillBody').children.filter(c => String(c.className) === 'skill-card');
  ok(cards2.length > 0, '回车打开第一名干员的 ' + cards2.length + ' 个技能');
  const skMeta = cards2[0].children.filter(c => String(c.className) === 'skill-meta')[0];
  ok(!!skMeta && /SP|持续|触发/.test(skMeta.textContent), '技能卡给出数值：' + (skMeta || {}).textContent);
  const skDesc = cards2[0].children.filter(c => String(c.className) === 'skill-desc')[0];
  ok(!!skDesc && skDesc.textContent.length > 4, '技能卡给出描述原文');

  const useBtn = cards2
    .map(c => c.children.filter(x => String(x.className) === 'skill-acts')[0])
    .filter(Boolean)
    .map(a => a.children.filter(x => /算伤害/.test(x.textContent))[0])
    .filter(Boolean)[0];
  ok(!!useBtn, '能从描述读出倍率的技能带「算伤害」按钮：' + (useBtn ? useBtn.textContent : '（无）'));
  if (useBtn) {
    const beforeScale = Number($('dmgScale').value);
    useBtn.click();
    ok(Number($('dmgScale').value) !== beforeScale, '点一下把倍率填进伤害估算：' + $('dmgScale').value);
    ok($('tabSummary').getAttribute('aria-selected') === 'true', '并自动跳到汇总页看结果');
    $('tabSkill').click();
  }

  const linkBtn = $('skillBody').children
    .filter(c => String(c.className) === 'skill-head')[0]
    .children.filter(c => /复制链接/.test(c.textContent))[0];
  ok(!!linkBtn, '技能页有「复制链接」');
  linkBtn.click();
  const skTa = $('modalBody').children.filter(c => c.tagName === 'TEXTAREA')[0];
  ok(!!skTa && /#skill=Mechanist/.test(skTa.value), '链接里带 #skill=干员名：' +
     (skTa ? skTa.value.split('#')[1] : '（缺）'));
  $('modalClose').click();

  // 深度链接：重新走一遍启动流程，#skill= 应该直接落到这名干员的技能页
  global.location.hash = '#skill=Mechanist';
  doc._ready.forEach(fn => fn());
  ok($('tabSkill').getAttribute('aria-selected') === 'true', '带 #skill= 打开直接落在技能页');
  ok($('skillBody').children.filter(c => String(c.className) === 'skill-card').length > 0,
     '落地即有技能卡，不用再点一次');
  ok(/已打开Mechanist的技能页/.test($('toast').textContent), '提示已打开：' + $('toast').textContent);
  ok(global.location.hash === '', 'hash 被清掉，刷新不会重复覆盖');

  await sleep(260);
  console.log('');
  if (fail) { console.log('失败 %d 项', fail); process.exit(1); }
  console.log('冒烟测试全部通过');
  process.exit(0);
}

main().catch(e => {
  console.log('未捕获异常：' + (e && e.stack || e));
  process.exit(1);
});

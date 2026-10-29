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
const tableOf = () => $('summaryBody').children
  .filter(c => /编队面板对照/.test((c.children[0] || {}).textContent || ''))[0];
ok(!!tableOf(), '汇总页有「编队面板对照」卡');
ok(tableOf().children.filter(x => String(x.className) === 'empty').length === 1,
   '编队为空时显示引导文案而不是空表');
tiles()[0].click();
const tbl = tableOf();
ok(tbl.children.filter(x => x.tagName === 'TABLE').length === 1, '对照表渲染成 table');
const tbody = tbl.children.filter(x => x.tagName === 'TABLE')[0].children.filter(x => x.tagName === 'TBODY')[0];
ok(tbody.children.length === 1, '表体 1 行对应 1 名干员');

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

  console.log('=== 弹窗 ===');
  $('btnHelp').click();
  ok($('modalBody').children.length > 0, '公式说明弹窗有内容');
  // 数据版本块：用户反馈数值问题时靠它确认双方看的是不是同一份数据
  const metaBox = $('modalBody').children.filter(c => String(c.className).indexOf('data-meta') >= 0)[0];
  ok(!!metaBox && metaBox.children.length >= 8, '公式说明里有数据版本块（' + (metaBox ? metaBox.children.length : 0) + ' 格）');
  $('btnExport').click();
  ok($('modalBody').children.length > 0, '导出弹窗有内容');

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

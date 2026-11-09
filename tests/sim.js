'use strict';
/* 中土远征 · 离线回归
   用法：node tests/sim.js
   零依赖。把 index.html 里的 <script> 抽出来放进 mock DOM 里跑：
   1) 数据完整性  2) 阴影机制  3) 规则接线  4) 刷新恢复  5) 可复现性  6) 300 局模拟
   7) 渲染结构  8) 内容扩容与回响埋点  9) 产物。
   不启动浏览器，不写网络，不改仓库文件。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('× 找不到内嵌 <script>'); process.exit(1); }
const code = m[1];

/* ---------- 极简 DOM / 存储 ---------- */
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', className: '', disabled: false,
    dataset: {}, style: {}, scrollWidth: 0, clientWidth: 0, scrollLeft: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, focus() {}, select() {}, setAttribute() {},
    onclick: null
  };
}

const warns = [];
const fakeConsole = {
  log() {}, warn(...a) { warns.push(a.join(' ')); }, error(...a) { warns.push('ERROR ' + a.join(' ')); }
};

function makeCtx(store) {
  const cache = {};
  const ui = { created: [], rollbox: makeEl(), timers: [] };
  const document = {
    getElementById(id) { return cache[id] || (cache[id] = makeEl()); },
    querySelectorAll() { return []; },
    querySelector(sel) { return sel === '.rollbox' ? ui.rollbox : makeEl(); },
    createElement() { const e = makeEl(); ui.created.push(e); return e; }
  };
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };
  const sandbox = {
    __ui: ui,
    console: fakeConsole, document, localStorage,
    location: { search: '' }, URLSearchParams,
    setInterval(fn) { ui.timers.push(fn); return ui.timers.length; }, clearInterval() {},
    setTimeout() { return 0; }, clearTimeout() {},
    navigator: { clipboard: null }
  };
  const c = vm.createContext(sandbox);
  vm.runInContext(code, c, { filename: 'index.html' });
  return c;
}

let ctx = makeCtx({});
const get = expr => vm.runInContext(expr, ctx);
function call(name, ...args) {
  ctx.__a = args;
  return vm.runInContext(name + '(...__a)', ctx);
}
const fn = name => get(name);

const EVENTS = get('EVENTS');
const TEXTS = get('TEXTS');
const SHADOW_TEXTS = get('SHADOW_TEXTS');
const SHADOW_TAIL = get('SHADOW_TAIL');
const REGION_TEXTS = get('REGION_TEXTS');
const TOKENS = get('TOKENS');
const ITEMS = get('ITEMS');
const HEROES = get('HEROES');
const TIERS = get('TIERS');
const TALENTS = get('TALENTS');
const SHADOW_MAX = get('SHADOW_MAX');
const TOTAL_LAYERS = get('TOTAL_LAYERS');

const hashStr = fn('hashStr');
const mulberry32 = fn('mulberry32');
const hasNeed = fn('hasNeed');
const effDC = fn('effDC');
const settleCheck = fn('settleCheck');
const chooseOption = fn('chooseOption');
const enterNode = fn('enterNode');
const endRun = fn('endRun');
const saveRun = fn('saveRun');
const newGame = fn('newGame');
const injectShadowOptions = fn('injectShadowOptions');
const takeGentleOptions = fn('takeGentleOptions');

const EVENT_IDS = new Set(EVENTS.map(e => e.id));
const FX_KEYS = new Set(['hp', 'supply', 'resolve', 'renown', 'material', 'shadow', 'token', 'item', 'flag']);

let failures = 0;
const note = [];
function fail(msg) { failures++; console.error('  × ' + msg); }
function ok(msg) { note.push(msg); }
function section(t) { console.log('\n' + t); }

/* ---------- 1. 数据完整性 ---------- */
section('① 数据完整性');
{
  const ids = new Set();
  let optCount = 0, branchCount = 0, textsWithOpts = 0;
  for (const e of EVENTS) {
    if (ids.has(e.id)) fail('重复事件 id：' + e.id);
    ids.add(e.id);
    if (!TEXTS[e.id]) fail('缺正式叙事文本：' + e.id);
    const t = TEXTS[e.id];
    if (t && t.opts) {
      textsWithOpts++;
      if (t.opts.length !== e.options.length) {
        fail('TEXTS 选项数不符：' + e.id + ' (' + t.opts.length + '≠' + e.options.length + ')');
      }
    }
    for (const o of e.options) {
      optCount++;
      for (const branch of [o.fx, o.ok && o.ok.fx, o.no && o.no.fx]) {
        if (!branch) continue;
        for (const k of Object.keys(branch)) {
          if (!FX_KEYS.has(k)) fail('非法效应键：' + e.id + ' → ' + k);
        }
      }
      if (o.ok) branchCount++;
      if (o.no) branchCount++;
      if (o.need && o.need.token && !TOKENS[o.need.token]) fail('凭证不存在：' + e.id + ' → ' + o.need.token);
      if (o.chain && !EVENTS.some(x => x.id === o.chain)) fail('断链：' + e.id + ' → ' + o.chain);
      if (o.reframe && !EVENTS.some(x => x.id === o.reframe)) fail('重构目标不存在：' + e.id + ' → ' + o.reframe);
    }
  }
  ok('事件 ' + EVENTS.length + ' 条 / 唯一 id ' + ids.size + ' / 选项 ' + optCount + ' / 分支文本 ' + branchCount);
  ok('正式叙事文本 ' + Object.keys(TEXTS).length + ' 条，其中带 opts 的 ' + textsWithOpts + ' 条（覆盖率 ' +
     Math.round(Object.keys(TEXTS).length / EVENTS.length * 100) + '%）');

  const shadowKeys = Object.keys(SHADOW_TEXTS);
  const tailKeys = Object.keys(SHADOW_TAIL);
  const overlap = shadowKeys.filter(k => SHADOW_TAIL[k]);
  if (overlap.length) fail('阴影整篇与注脚重叠（注脚永不生效）：' + overlap.join(', '));
  for (const k of shadowKeys.concat(tailKeys)) if (!EVENT_IDS.has(k)) fail('阴影文本指向不存在的事件：' + k);
  ok('阴影改写：整篇 ' + shadowKeys.length + ' / 注脚 ' + tailKeys.length + ' / 重叠 ' + overlap.length);

  let regionVariants = 0;
  for (const r of Object.keys(REGION_TEXTS)) {
    for (const id of Object.keys(REGION_TEXTS[r])) {
      regionVariants++;
      const e = EVENTS.find(x => x.id === id);
      if (!e) fail('地区版指向不存在的事件：' + r + '/' + id);
      else if (e.region !== 'any') fail('地区版用在专属事件上：' + r + '/' + id);
    }
  }
  ok('通用池地区版正文 ' + regionVariants + ' 段，覆盖 ' + Object.keys(REGION_TEXTS.shire).length + ' 条通用事件');

  const byRegion = EVENTS.reduce((a, e) => (a[e.region] = (a[e.region] || 0) + 1, a), {});
  ok('地区分布 夏尔 ' + (byRegion.shire || 0) + ' / 通用 ' + (byRegion.any || 0) +
     ' / 布理 ' + (byRegion.bree || 0) + ' / 荒野 ' + (byRegion.wild || 0));

  /* README 状态表的数字必须和实测一致，改内容时忘了改文档会直接报错 */
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pairs = [
    ['| 事件 | ' + EVENTS.length + ' 条', '事件总数'],
    ['| 分支结果 | ' + branchCount + ' 段', '分支结果'],
    ['| 通用池地区版正文 | ' + regionVariants + ' 段', '地区版正文'],
    ['| 阴影改写 | ' + shadowKeys.length + ' 条整篇替换 + ' + tailKeys.length + ' 条注脚', '阴影改写'],
    ['夏尔 ' + byRegion.shire + ' / 通用 ' + byRegion.any + ' / 布理 ' + byRegion.bree + ' / 荒野 ' + byRegion.wild, '地区分布'],
    ['v0.4，能完整玩通。', '版本号']
  ];
  for (const [needle, label] of pairs) {
    if (!readme.includes(needle)) fail('README 口径不符：' + label + '（应为 ' + needle + '）');
  }
  ok('README 状态表 6 项与实测一致（含版本号）');

  if (warns.length) for (const w of warns) fail('运行时告警：' + w);
  else ok('运行时告警 0 条（TEXTS 对齐通过）');
}

/* ---------- 2. 阴影机制专项 ---------- */
section('② 阴影机制专项');
{
  vm.runInContext('G = {shadow:5, seed:"mech", layer:0, tokens:[], flags:{}, echoes:[]}', ctx);
  const enc = EVENTS.find(e => e.id === 'shire_rider');
  const before = enc.options.length;
  const injected = injectShadowOptions(enc);
  if (injected.options.length !== before + 1) fail('暗选项没有注入');
  if (enc.options.length !== before) fail('injectShadowOptions 污染了 EVENTS 原对象（跨局泄漏）');
  const shadowOpt = injected.options[injected.options.length - 1];
  if (!shadowOpt.fx || shadowOpt.fx.shadow !== 3) fail('暗选项的 fx 没有生效');
  ok('暗选项注入返回副本、原事件不被改写、fx 生效');

  const fake = { id: 'test_take', type: 'story', region: 'any', options: [
    { label: '绕道走' }, { label: '不管它' }, { label: '硬闯' }, { label: '蹲下来看' }
  ] };
  const rows = [];
  for (const s of [0, 3, 4, 5, 6, 7, 8]) {
    vm.runInContext('G.shadow = ' + s, ctx);
    const out = takeGentleOptions(fake);
    const taken = out.options.filter(o => o.taken).length;
    const left = out.options.filter(o => !o.taken).length;
    if (left < 2) fail('阴影 ' + s + ' 时可点选项只剩 ' + left + ' 个（保底 2）');
    if (fake.options.some(o => o.taken)) fail('阴影 ' + s + ' 污染了输入事件');
    rows.push(s + '→夺' + taken + '/剩' + left);
  }
  ok('夺走阈值 ' + rows.join('  '));

  /* 保底：只有两个可选选项时，一个也不该夺走 */
  const tiny = { id: 'test_tiny', type: 'story', region: 'any', options: [{ label: '绕道走' }, { label: '硬闯' }] };
  vm.runInContext('G.shadow = 8', ctx);
  const tinyOut = takeGentleOptions(tiny);
  if (tinyOut.options.filter(o => o.taken).length !== 0) fail('两选项事件被夺走后无路可走');
  ok('两选项事件在阴影 8 下仍保留全部选项（保底生效）');
}

/* ---------- 3. 规则接线 ---------- */
section('③ 规则接线（天赋 / 出身 / 难度）');
{
  function fresh(store) {
    const c = makeCtx(store || {});
    return {
      c,
      run: e => vm.runInContext(e, c),
      call(n, ...a) { c.__a = a; return vm.runInContext(n + '(...__a)', c); },
      G: () => vm.runInContext('G', c),
      html: () => vm.runInContext('document.getElementById("app").innerHTML', c)
    };
  }
  function started(talents, heroId, tierId, seed) {
    const h = fresh();
    h.run('META = defaultMeta(); META.talents = ' + JSON.stringify(talents || []) + ';');
    h.call('newGame', heroId || 'ranger', tierId || 1, seed || 'RULES');
    return h;
  }
  /* mock 里 setInterval 只存回调；手动跑满 10 帧才到 showRollActions */
  function roll(h, raw, attr, dc, extra) {
    h.run('rollD20 = () => ' + raw);
    h.c.__opt = Object.assign({
      label: '试一下', check: { attr: attr, dc: dc },
      ok: { text: '成了', fx: {} }, no: { text: '没成', fx: {} }
    }, extra || {});
    h.run('G.event = {id:"__t",title:"测试检定",type:"encounter",text:"",options:[]}; ' +
          'G.pending = {opt:__opt,checkBonus:0}; G.screen="check";');
    h.c.__ui.timers.length = 0;
    h.call('renderCheck');
    const fns = h.c.__ui.timers.splice(0);
    for (let i = 0; i < 10; i++) for (const f of fns) f();
    return {
      detail: h.run('document.getElementById("rollDetail").textContent'),
      buttons: h.c.__ui.created.filter(e => e.className === 'btn sm').map(e => e.textContent)
    };
  }
  function failOpt(fx) {
    return { label: '试一下', check: { attr: 'valor', dc: 12 },
             ok: { text: '成了', fx: {} }, no: { text: '没成', fx: fx || {} } };
  }
  function setupFail(h, fx) {
    h.c.__opt = failOpt(fx);
    h.run('G.event = {id:"__t",title:"测试检定",type:"encounter",text:"",options:[]}; ' +
          'G.pending = {opt:__opt,checkBonus:0}; G.screen="check";');
  }

  /* 3.1 每条 rule / extra 键都必须真的进局内规则表 */
  let wired = 0;
  for (const t of TALENTS) {
    const keys = [t.rule].concat(Object.keys(t.extra || {})).filter(Boolean);
    if (!keys.length) continue;
    const rules = started([t.id]).run('G.rules') || {};
    for (const k of keys) {
      if (!(k in rules)) fail('天赋 ' + t.id + ' 的 ' + k + ' 没接进 G.rules');
      else wired++;
    }
  }
  ok(wired + ' 条天赋 rule / extra 键全部接进局内规则表');

  /* 3.2 数值类天赋在开局属性上生效 */
  const b = started([]).G();
  for (const [id, key, delta] of [['v4', 'hpMax', 3], ['v5', 'resolveMax', 1], ['k1', 'supplyMax', 2]]) {
    const g = started([id]).G();
    if (g[key] - b[key] !== delta) fail(id + ' 的 ' + key + ' 实际差 ' + (g[key] - b[key]) + '，应为 ' + delta);
  }
  ok('数值类天赋 v4 / v5 / k1 在开局属性上生效');

  /* 3.3 一次性检定加成：只给第一次，重掷不重复拿 */
  const k5 = started(['k5']);
  k5.call('chooseOption', failOpt());
  if (k5.G().pending.checkBonus !== 2) fail('k5 预感没给第一次检定 +2');
  if (k5.G().firstCheck !== false) fail('k5 第一次检定后没消费标记');
  k5.call('chooseOption', failOpt());
  if (k5.G().pending.checkBonus !== 0) fail('k5 第二次检定仍在 +2');
  const rd = started([], 'rider');
  rd.call('chooseOption', failOpt());
  if (rd.G().pending.checkBonus !== 2) fail('洛汗骑手「一鼓作气」的 +2 没拿到');
  rd.call('chooseOption', failOpt());
  if (rd.G().pending.checkBonus !== 0) fail('洛汗骑手同一层第二次勇武检定不该再 +2');
  if (rd.G().supplyMax !== rd.G().hero.supply - 1) fail('洛汗骑手补给上限没有 −1');
  ok('k5 预感 / 洛汗骑手：一次性 +2 只给一次，马吃草的 −1 生效');

  /* 3.4 明察：DC 预览只有在点亮时才带概率 */
  const hintOn = started(['l2']).call('dcHint', { attr: 'valor', dc: 12 });
  const hintOff = started([]).call('dcHint', { attr: 'valor', dc: 12 });
  if (hintOn.indexOf('%') < 0 || hintOff.indexOf('%') >= 0) fail('l2 明察没有控制 DC 概率预览');
  ok('l2 明察：点亮才显示成败概率');

  /* 3.5 预习：免费重掷不扣决心，且只用一次 */
  const l3 = started(['l3']);
  if (l3.G().freeRerolls !== 1) fail('l3 没有发免费重掷次数');
  const r3 = roll(l3, 3, 'valor', 30);
  if (!r3.buttons.some(s => s.indexOf('免费重掷') >= 0)) fail('l3 检定失败时没出现免费重掷按钮');
  const before = l3.G().resolve;
  const freeBtn = l3.c.__ui.created.filter(e => e.className === 'btn sm' && e.textContent.indexOf('免费重掷') >= 0).pop();
  if (!freeBtn) fail('l3 找不到免费重掷按钮');
  else {
    freeBtn.onclick();
    if (l3.G().resolve !== before) fail('免费重掷扣了决心');
    if (l3.G().freeRerolls !== 0) fail('免费重掷没有消费次数');
  }
  ok('l3 预习：1 次不花决心的重掷，用完即止');

  /* 3.6 失败分支上的保命 / 减伤 / 出身 */
  const st = started(['v3']);
  st.run('G.hp = 0;');
  setupFail(st);
  st.call('settleCheck', 'fail', '');
  if (!st.G().standUsed || st.G().hp !== 1) fail('v3 再起没有把生命归零拉回 1');
  const v7 = started(['v7']);
  v7.run('G.hp = 10;');
  setupFail(v7, { hp: -3 });
  v7.call('settleCheck', 'fail', '');
  if (v7.G().hp !== 8) fail('v7 破阵没有把 3 点伤害减成 2（实际 ' + v7.G().hp + '）');
  const plain = started([]);
  plain.run('G.hp = 10;');
  setupFail(plain, { hp: -3 });
  plain.call('settleCheck', 'fail', '');
  if (plain.G().hp !== 7) fail('没点 v7 时伤害不该减免');
  const v7d = started(['v7']);
  v7d.run('G.hp = 10;');
  const dchg = v7d.call('applyFx', { hp: -3 });
  if (v7d.G().hp !== 8) fail('v7 对选项直接伤害没有减 1');
  if (dchg.some(x => x.k === '生命' && x.v !== -2)) fail('v7 减伤后结算数字没跟着改');
  const v7one = started(['v7']);
  v7one.run('G.hp = 10;');
  v7one.call('applyFx', { hp: -1 });
  if (v7one.G().hp !== 9) fail('v7 把 1 点伤害减成 0 了（应至少吃 1 点）');
  const wd = started([], 'warden');
  wd.run('G.hp = 2;');
  setupFail(wd);
  wd.call('settleCheck', 'fail', '');
  if (!wd.G().wardenUsed || wd.G().hp !== 5) fail('盾卫「屹立不倒」没有回 3 点');
  ok('v3 再起 / v7 破阵 / 盾卫屹立不倒：失败分支行为正确');

  /* 3.7 老练：只对原本就有恢复的营地选项加 +2 */
  const k6 = started(['k6']);
  k6.run('G.hp = 5; G.supply = 3;');
  k6.call('applyFx', { hp: 2, supply: 2 }, { camp: true });
  if (k6.G().hp !== 9 || k6.G().supply !== 7) fail('k6 老练没有给营地恢复 +2');
  const n6 = started([]);
  n6.run('G.hp = 5; G.supply = 3;');
  n6.call('applyFx', { hp: 2, supply: 2 }, { camp: true });
  if (n6.G().hp !== 7 || n6.G().supply !== 5) fail('没点 k6 时营地恢复不该加 +2');
  ok('k6 老练：营地恢复额外 +2，不点亮则不生效');

  /* 3.8 撤退折损：带走与留下不能是同一批 */
  function retreatWith(talents) {
    const h = started(talents);
    h.run('G.loot = [{id:"sword",plus:0},{id:"mail",plus:0},{id:"ring",plus:0},{id:"cloak",plus:0}]; G.layer = 4;');
    h.call('endRun', 'retreat');
    return h.G().over;
  }
  const half = retreatWith([]), full = retreatWith(['v6']);
  if (full.kept.length !== 4 || full.lost.length !== 0) fail('v6 不退没有保住全部战利品');
  if (half.kept.length !== 2 || half.lost.length !== 2) fail('默认撤退没有折损一半');
  if (half.lost.some(l => half.kept.includes(l))) fail('撤退时「带走」和「留下」重叠了');
  const dh = started([]);
  dh.run('G.loot = [{id:"sword",plus:0},{id:"mail",plus:0},{id:"ring",plus:0},{id:"cloak",plus:0}]; G.layer = 4;');
  dh.call('endRun', 'dead');
  const dOver = dh.G().over;
  if (dOver.lost.some(l => dOver.kept.includes(l))) fail('倒下时「带走」和「留下」重叠了');
  if (dOver.lost.length + dOver.kept.length !== 4) fail('倒下时战利品账目对不上');
  ok('撤退 / 倒下：kept 与 lost 互斥且合计守恒，v6 全带');

  /* 3.9 辨物 / 寻宝：秘藏节点真的多出东西 */
  function treasureGame(talents) {
    const h = started(talents, 'ranger', 1, 'RULES-T');
    const t = h.run('(function(){var idx=G.map.index;for(var k in idx){var n=idx[k];' +
      'if(n.type==="treasure"&&n.layer>0){for(var p in idx){' +
      'if(idx[p].next&&idx[p].next.indexOf(n.id)>=0)return {id:n.id,parent:p};}}}return null;})()');
    if (!t) return null;
    h.run('G.at = ' + JSON.stringify(t.parent) + '; G.screen="map"; G.loot=[]; G.materials=0; G.shadow=0;');
    h.call('enterNode', t.id);
    return { loot: h.G().loot.length, mats: h.G().materials };
  }
  const tg0 = treasureGame([]), tg4 = treasureGame(['l4']), tgK4 = treasureGame(['k4']);
  if (!tg0 || !tg4 || !tgK4) fail('测试地图上找不到可进入的秘藏节点');
  else {
    if (tg4.loot !== 1) fail('l4 辨物点亮后秘藏没有必出装备');
    if (tgK4.mats !== 2 || tg0.mats !== 1) fail('k4 寻宝没有让秘藏多出 1 份材料');
    if (tg4.loot === 1 && !(tg4.loot >= tg0.loot)) fail('l4 的产出反而少于默认');
  }
  ok('l4 辨物（必出装备）/ k4 寻宝（+1 材料）在秘藏节点生效');

  /* 3.10 通晓：每三个事件一条观察选项，且不会被阴影夺走 */
  const l6 = started(['l6']);
  const sample = EVENTS.find(e => e.type === 'encounter' && !e.group);
  l6.run('G.eventCount = 3;');
  const obs = l6.call('injectObserveOption', sample);
  if (!obs.options.some(o => o.observe)) fail('l6 第三个事件没给「观察」选项');
  if (sample.options.some(o => o.observe)) fail('injectObserveOption 污染了原事件');
  l6.run('G.eventCount = 2;');
  if (l6.call('injectObserveOption', sample).options.some(o => o.observe)) fail('l6 在不是第三个事件时也给了观察选项');
  const n6o = started([]);
  n6o.run('G.eventCount = 3;');
  if (n6o.call('injectObserveOption', sample).options.some(o => o.observe)) fail('没点 l6 却出现观察选项');
  l6.run('G.shadow = 8; G.eventCount = 3;');
  if (!l6.call('takeGentleOptions', obs).options.some(o => o.observe && !o.taken)) fail('观察选项被阴影误夺');
  ok('l6 通晓：每三事件一条「观察」，不改原题、不被阴影夺走');

  /* 3.11 远见：地图多出再下一程的类型预览 */
  const l7 = started(['l7']);
  l7.run('G.screen = "map"; renderMap();');
  const mapH = l7.html();
  if (mapH.indexOf('远见 · 再下一程') < 0) fail('l7 地图没有远见提示');
  if (mapH.indexOf('stroke-dasharray="2 4"') < 0) fail('l7 远见节点没有虚线圈标识');
  const n7 = started([]);
  n7.run('G.screen = "map"; renderMap();');
  if (n7.html().indexOf('远见') >= 0) fail('没点 l7 却出现远见');
  ok('l7 远见：再下一程节点以虚线圈标出，不点亮则不显示');

  /* 3.12 命运偏袒：自然 1 → 20，合计也要跟着改 */
  const k8 = started(['k8']);
  const r8 = roll(k8, 1, 'valor', 12);
  if (r8.detail.indexOf('命运的偏袒') < 0) fail('k8 自然 1 没有改判为 20');
  const mm = r8.detail.match(/20 \+ (\d+) = (\d+)/);
  if (!mm) fail('k8 掷骰明细格式异常：' + r8.detail);
  else if ((+mm[1] + 20) !== +mm[2]) fail('自然 1 改判为 20 后明细合计没跟着重算：' + r8.detail);
  const n8 = started([]);
  const n8r = roll(n8, 1, 'valor', 12);
  if (n8r.detail.indexOf('命运的偏袒') >= 0) fail('没点 k8 却触发了命运偏袒');
  ok('k8 命运偏袒：自然 1 改判 20，掷骰明细数字一致');

  /* 3.13 出身规则 */
  const rg = roll(started([], 'ranger'), 10, 'cunning', 16);
  if (rg.detail.indexOf('林中潜行') < 0) fail('游侠「差值 ≤2 视为成功」没生效：' + rg.detail);
  const lr = roll(started([], 'lore'), 10, 'lore', 16);
  if (lr.detail.indexOf('博闻强识') < 0) fail('学士「每程首次学识 +2」没生效：' + lr.detail);
  const elf = started([], 'elf').G(), hob = started([], 'hobbit').G();
  if (elf.attrs.lore !== elf.hero.attrs.lore + 1) fail('精灵学识永久 +1 没生效');
  if (hob.attrs.cunning !== hob.hero.attrs.cunning + 2 || hob.resolveMax !== hob.hero.resolve + 1) fail('霍比特人 +2 机敏 / +1 决心没生效');
  function renownOf(heroId) {
    const h = started([], heroId);
    h.run('G.layer = 4;');
    h.call('endRun', 'win');
    return h.G().over.renown;
  }
  const rn = renownOf('ranger'), nm = renownOf('nameless');
  if (nm !== Math.round(rn * 1.4)) fail('无籍者结算声望 +40% 没生效（' + rn + ' → ' + nm + '）');
  const dw = fresh();
  dw.run('META = defaultMeta(); META.lastHero = "dwarf";');
  if (dw.call('forgeCost', 2) !== 2) fail('矮人锻造没有半价');
  dw.run('META.lastHero = "ranger";');
  if (dw.call('forgeCost', 2) !== 3) fail('非矮人锻造被误判为半价');
  const dwGame = started([], 'dwarf');
  if (dwGame.run('META.lastHero') !== 'dwarf') fail('用矮人开局没有记下 lastHero');
  ok('8 个出身规则全部生效（含矮人锻造半价按局外 lastHero 判定）');

  /* 3.14 难度 mods 真的接到局内状态 */
  const t1 = started([], 'ranger', 1).G();
  if (started([], 'ranger', 2).call('effDC', 10) !== 11) fail('难度 II 的 DC +1 没生效');
  if (started([], 'ranger', 3).G().supplyMax !== t1.supplyMax - 1) fail('难度 III 的补给上限 −1 没生效');
  const t4 = started([], 'ranger', 4).G();
  if (!t4.hunt || t4.supplyDrain !== 1) fail('难度 IV 的追踪 / 路耗 +1 没生效');
  const t6 = started([], 'ranger', 6).G();
  if (!t6.noRetreat || t6.finalDC !== 16 || t6.dmgBonus !== 1) fail('难度 VI 的禁退 / 终局检定 / 伤害 +1 没生效');
  const combo = started(['v7'], 'ranger', 6);
  combo.run('G.hp = 10;');
  combo.call('applyFx', { hp: -2 });
  if (combo.G().hp !== 8) fail('难度 VI +1 伤害与 v7 −1 没有正确叠加（应为 −3+1 = −2）');
  ok('6 档难度 mods 全部接到局内状态（DC / 补给 / 追踪 / 禁退 / 终局 / 伤害）');

  /* 3.15 旧存档补齐新字段，不会刷新后半途停摆 */
  const old = fresh();
  old.run('META = defaultMeta(); META.talents = ["l3","k3"];');
  old.call('newGame', 'ranger', 1, 'OLDSAVE');
  old.call('saveRun');
  const raw = JSON.parse(old.run('localStorage.getItem("me_run_v2")'));
  delete raw.rules; delete raw.freeRerolls; delete raw.eventCount; delete raw.echoes;
  raw.pending = { opt: { label: '试一下' }, riderBonus: 2 };
  /* 刷新后 META 从自己的 localStorage 重建，得把「当前已点的天赋」一起带上 */
  const meta = { renown: 0, materials: 0, maxTier: 1, talents: ['l3', 'k3'], armory: {}, loadout: {},
                 runs: 0, wins: 0, best: 0, seen: {}, origins: ['ranger', 'warden', 'lore'], lastHero: 'ranger' };
  const c2 = fresh({ me_run_v2: JSON.stringify(raw), me_meta_v2: JSON.stringify(meta) });
  const g2 = c2.G();
  if (!g2) fail('旧存档刷新后没有恢复');
  else {
    if (!g2.rules || !g2.rules.extraReroll || !g2.rules.roadSave) fail('旧存档的天赋规则没有按当前 META 补齐');
    if (g2.freeRerolls !== 1) fail('旧存档没补 freeRerolls');
    if (g2.eventCount !== 0 || !Array.isArray(g2.echoes)) fail('旧存档没补 eventCount / echoes');
    if (g2.pending.checkBonus !== 2) fail('旧 pending 的 riderBonus 没有兼容成 checkBonus');
  }
  ok('旧存档（无 rules / freeRerolls / eventCount / echoes，pending 用旧名）刷新后行为不丢');
}

/* ---------- 4. 刷新恢复 ---------- */
section('④ 刷新恢复');
{
  ctx = makeCtx({});
  // 重新绑定函数到新 context
  ctx.__a = null;
  vm.runInContext('newGame("ranger", 1, "restore-test")', ctx);
  vm.runInContext('saveRun()', ctx);
  const raw = vm.runInContext('localStorage.getItem("me_run_v2")', ctx);
  if (!raw) fail('saveRun 没有写入存档');
  const parsed = JSON.parse(raw);
  delete parsed.echoes;                         // 模拟 v0.2 的旧存档
  const c2 = makeCtx({ me_run_v2: JSON.stringify(parsed) });
  const G2 = vm.runInContext('G', c2);
  if (!G2 || G2.screen === 'title') fail('刷新后没有接上未结束的一局');
  else if (!Array.isArray(G2.echoes)) fail('旧存档缺少 echoes 字段时没有兼容补齐');
  else ok('刷新恢复到 ' + G2.screen + '，旧存档 echoes 已补空数组');
}

/* ---------- 5/6. 自动模拟 ---------- */
ctx = makeCtx({});
// 换 context 后重新取函数（函数内部读的是自己 realm 的 G）
const F = {
  hashStr: vm.runInContext('hashStr', ctx),
  mulberry32: vm.runInContext('mulberry32', ctx),
  hasNeed: vm.runInContext('hasNeed', ctx),
  effDC: vm.runInContext('effDC', ctx),
  chooseOption: vm.runInContext('chooseOption', ctx),
  settleCheck: vm.runInContext('settleCheck', ctx),
  enterNode: vm.runInContext('enterNode', ctx),
  endRun: vm.runInContext('endRun', ctx),
  newGame: vm.runInContext('newGame', ctx)
};
const callC = (name, ...args) => { ctx.__a = args; return vm.runInContext(name + '(...__a)', ctx); };
const getG = () => vm.runInContext('G', ctx);

function checkState(G, where) {
  if (!G) return fail(where + '：G 为空');
  for (const [k, max] of [['hp', G.hpMax], ['supply', G.supplyMax], ['resolve', G.resolveMax]]) {
    const v = G[k];
    if (!Number.isFinite(v) || v < -0.001 || v > max + 0.001) {
      fail(where + '：' + k + ' 越界 = ' + v + ' / 上限 ' + max);
    }
  }
  if (!Number.isFinite(G.shadow) || G.shadow < 0 || G.shadow > SHADOW_MAX) {
    fail(where + '：阴影越界 = ' + G.shadow);
  }
}

function fakeTier(G, o) {
  const chk = o.check;
  const rnd = F.mulberry32(F.hashStr(G.seed + '|' + G.at + '|' + chk.attr + '|' + G.event.id + '|' + (G.rerolls || 0)));
  const raw = 1 + Math.floor(rnd() * 20);
  const base = G.attrs[chk.attr] + ((G.pending && G.pending.checkBonus) || 0);
  const diff = raw + base - F.effDC(chk.dc);
  if (raw === 20) return 'crit';
  if (raw === 1) return 'fumble';
  return diff >= 5 ? 'clean' : (diff >= 0 ? 'cost' : 'fail');
}

const stats = { steps: 0, takenSeen: 0, regionSeen: 0, echoOK: 0, kinds: {}, echoes: new Set(), echoTypes: new Set() };

function runOne(heroId, tierId, seed, wantTrace) {
  vm.runInContext('META = defaultMeta()', ctx);
  const drnd = F.mulberry32(F.hashStr(seed + '|sim'));
  const trace = [];
  F.newGame(heroId, tierId, seed);
  let G = getG();
  let steps = 0;

  while (!G.over && steps++ < 400) {
    if (G.screen === 'map') {
      /* 血量低且本档允许撤退时收手，贴近 README 描述的模拟策略 */
      if (G.hp <= 2 && !G.noRetreat && G.layer >= 2) { F.endRun('retreat'); G = getG(); continue; }
      const cur = G.map.index[G.at];
      if (!cur.next || !cur.next.length) { F.endRun('win'); G = getG(); continue; }
      F.enterNode(cur.next[Math.floor(drnd() * cur.next.length)]);
    } else if (G.screen === 'event') {
      const ev = G.event;
      if (EVENT_IDS.has(ev.id)) {
        trace.push(ev.id);
        if (ev.options.some(o => o.taken)) stats.takenSeen++;
        if (ev.text && ev.text.indexOf('车辙') >= 0) stats.regionSeen++;
        const totalClickable = ev.options.filter(o => !(o.need && !F.hasNeed(o.need))).length;
        const clickable = ev.options.filter(o => !o.taken && !(o.need && !F.hasNeed(o.need)));
        /* 保底是「至少留 2 个」；有些重构后的障碍事件原本就只有 1 个可点，别误判 */
        const floor = Math.min(2, totalClickable);
        if (clickable.length < floor) fail('选项保底被破坏：' + ev.id + ' 只剩 ' + clickable.length + ' 个（原有 ' + totalClickable + '）');
        const o = clickable[Math.floor(drnd() * clickable.length)];
        trace.push('>' + o.label);
        F.chooseOption(o);
      } else {
        F.chooseOption(ev.options.find(x => !x.taken) || ev.options[0]);
      }
    } else if (G.screen === 'check') {
      const tier = fakeTier(G, G.pending.opt);
      trace.push('tier:' + tier);
      F.settleCheck(tier, '');
    } else {
      fail('未知屏幕：' + G.screen + ' @ ' + seed);
      break;
    }
    G = getG();
    checkState(G, seed + ' 第 ' + steps + ' 步');
  }
  if (steps >= 400) fail('未能结束：' + seed);
  if (!G.over) { F.endRun('dead'); G = getG(); }

  stats.steps += steps;
  const o = G.over;
  for (const e of (G.echoes || [])) {
    stats.echoTypes.add(e.t);
    if (e.t === 'region' && /边境|古大道|风云顶/.test((e.from || '') + (e.to || '')))
      fail('跨地区埋点用了地区全称（回响应使用简称）：' + e.from + '→' + e.to);
  }
  stats.kinds[o.kind] = (stats.kinds[o.kind] || 0) + 1;
  if (!o.echo || typeof o.echo !== 'string' || !o.echo.trim()) fail('结算回响为空：' + seed + '/' + o.kind);
  else {
    stats.echoOK++;
    stats.echoes.add(o.echo);
    if (/undefined|NaN|\[object/.test(o.echo)) fail('回响含脏值：' + seed + ' → ' + o.echo);
  }
  trace.push('END:' + o.kind + ':' + o.reached + ':' + o.renown);
  return wantTrace ? trace : null;
}

section('⑤ 同种子可复现');
{
  const a = runOne('ranger', 3, 'REPRO-001', true);
  const b = runOne('ranger', 3, 'REPRO-001', true);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail('同种子两次结果不同（长度 ' + a.length + '/' + b.length + '）');
    const i = a.findIndex((x, k) => x !== b[k]);
    if (i >= 0) fail('首个分歧 @' + i + '：' + a[i] + ' vs ' + b[i]);
  } else ok('REPRO-001 两次一致：' + a.length + ' 个决策点，' + a[a.length - 1]);
}

section('⑥ 300 局自动模拟');
{
  const heroes = HEROES.map(h => h.id);
  const tiers = TIERS.map(t => t.id);
  stats.echoOK = 0; stats.kinds = {}; stats.echoes.clear(); stats.steps = 0;
  stats.takenSeen = 0; stats.regionSeen = 0; stats.echoTypes.clear();
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    runOne(heroes[i % heroes.length], tiers[(i * 7) % tiers.length], 'SIM-' + i, false);
  }
  ok('300 局全部结束，耗时 ' + (Date.now() - t0) + ' ms，平均 ' + (stats.steps / 300).toFixed(1) + ' 步/局');
  ok('结局分布 ' + Object.entries(stats.kinds).map(([k, v]) => k + '=' + v).join(' / '));
  ok('结算回响非空 ' + stats.echoOK + '/300，去重后 ' + stats.echoes.size + ' 种（不是同一段模板复读）');
  ok('出现被夺走选项的事件 ' + stats.takenSeen + ' 次；地区版正文命中 ' + stats.regionSeen + ' 次');
  if (stats.echoTypes.size < 10) fail('300 局里回响埋点只覆盖 ' + stats.echoTypes.size + ' 类（应 ≥10）');
  ok('回响埋点实际覆盖 ' + stats.echoTypes.size + ' 类：' + Array.from(stats.echoTypes).sort().join(' / '));
}

section('⑦ 渲染结构');
{
  vm.runInContext('META = defaultMeta()', ctx);
  vm.runInContext('newGame("ranger", 1, "render-check")', ctx);
  vm.runInContext('G.shadow = 6', ctx);
  let view = callC('regionVariant', EVENTS.find(e => e.id === 'shire_tracks'), 'bree');
  view = callC('injectShadowOptions', view);
  view = callC('takeGentleOptions', view);
  ctx.__v = view;
  vm.runInContext('G.event = __v; G.screen = "event"; render()', ctx);
  const h1 = vm.runInContext('document.getElementById("app").innerHTML', ctx);
  if (!h1.includes('taken-opt')) fail('renderEvent 没有输出被夺走选项的样式');
  if (!h1.includes('taken-note')) fail('renderEvent 没有输出阴影低语');
  if (/undefined|NaN/.test(h1)) fail('事件页渲染含脏值');
  ok('高阴影事件页：划掉标记与低语均已渲染');

  callC('endRun', 'dead');
  const h2 = vm.runInContext('document.getElementById("app").innerHTML', ctx);
  if (!h2.includes('echo-card')) fail('renderResult 没有输出回响卡片');
  if (!h2.includes('回响')) fail('renderResult 缺回响标题');
  if (/undefined|NaN/.test(h2)) fail('结算页渲染含脏值');
  ok('结算页：回响卡片已渲染，无脏值');

  /* 通晓的观察选项：必须显示成「直接可行」，不能掉进 dcHint(undefined) */
  vm.runInContext('META = defaultMeta(); META.talents = ["l6"]; newGame("ranger", 1, "render-observe")', ctx);
  vm.runInContext('G.eventCount = 3', ctx);
  ctx.__v = callC('injectObserveOption', EVENTS.find(e => e.type === 'encounter' && !e.group));
  vm.runInContext('G.event = __v; G.screen = "event"; render()', ctx);
  const h3 = vm.runInContext('document.getElementById("app").innerHTML', ctx);
  if (!h3.includes('先站一会儿，把这一处看清楚')) fail('观察选项没有渲染出来');
  if (!/先站一会儿[\s\S]{0,200}直接可行/.test(h3)) fail('观察选项没有显示「直接可行」提示');
  if (/undefined|NaN/.test(h3)) fail('观察选项事件页渲染含脏值');
  ok('通晓观察选项：渲染为「直接可行」，无脏值');

  /* 矮人锻造半价：提示文案与实际扣费必须同源 */
  vm.runInContext('META = defaultMeta(); META.armory = {sword:2}; META.materials = 9; newGame("dwarf", 1, "render-forge")', ctx);
  if (callC('forgeCost', 2) !== 2) fail('矮人局外锻造成本没有半价');
  vm.runInContext('G = null; renderArmory()', ctx);
  const h4 = vm.runInContext('document.getElementById("app").innerHTML', ctx);
  if (!h4.includes('炉火的手艺还在')) fail('军械库没有写明当前是矮人半价');
  if (/undefined|NaN/.test(h4)) fail('军械库渲染含脏值');
  ok('军械库：矮人半价提示与 forgeCost 同源，文案与扣费一致');

  /* v0.4 新事件：长叙事文本要真的进 DOM，且不出现脏值 */
  vm.runInContext('META = defaultMeta(); newGame("ranger", 1, "render-v04")', ctx);
  ctx.__ev = EVENTS.find(e => e.id === 'bree_chalk');
  vm.runInContext('G.event = shadowVariant(__ev); G.layer = 6; G.screen = "event"; render()', ctx);
  const h5 = vm.runInContext('document.getElementById("app").innerHTML', ctx);
  if (!h5.includes('第三道只画了一半')) fail('v0.4 新事件的正式叙事文本没有渲染');
  if (/undefined|NaN|\[object/.test(h5)) fail('v0.4 事件页渲染含脏值');
  ok('v0.4 事件页：新叙事文本已渲染、无脏值');
}

/* ---------- 8. 内容扩容与回响埋点 ---------- */
section('⑧ 内容扩容与回响埋点');
{
  /* 地区版只给「有实体场景、且选项叙事不绑定地点」的通用事件写。
     独白抽离地点、阴影吞掉地方气味、多解障碍与凭证事件的 ok 文本写死了
     「巷子 / 泥地 / 村子」—— 这四类刻意保持中性，不许误加。 */
  const keys = Object.keys(REGION_TEXTS.shire);
  const norm = a => a.slice().sort().join(',');
  if (norm(keys) !== norm(Object.keys(REGION_TEXTS.bree)) ||
      norm(keys) !== norm(Object.keys(REGION_TEXTS.wild))) fail('三个地区的地区版键不一致');
  for (const k of keys) {
    const ev = EVENTS.find(e => e.id === k);
    if (!ev || ev.region !== 'any') fail('地区版指向非通用事件：' + k);
  }
  const groups = {
    '独白':      e => e.group === 'solitude',
    '阴影专用':  e => /^any_shadow_/.test(e.id),
    '多解障碍':  e => /^gate_(chain|wall)/.test(e.id),
    '凭证事件':  e => /^token_/.test(e.id)
  };
  let neutralCount = 0;
  for (const [name, pred] of Object.entries(groups)) {
    const list = EVENTS.filter(e => e.region === 'any' && pred(e));
    neutralCount += list.length;
    const leaked = list.filter(e => keys.includes(e.id));
    if (leaked.length) fail(name + '被误地区化：' + leaked.map(e => e.id).join(', '));
  }
  const anyCount = EVENTS.filter(e => e.region === 'any').length;
  if (keys.length + neutralCount !== anyCount) fail('通用池分类不闭合：' + keys.length + ' + ' + neutralCount + ' ≠ ' + anyCount);
  ok('地区版 ' + keys.length + ' 条 × 3 = ' + keys.length * 3 + ' 段；其余 ' + neutralCount +
     ' 条按设计保持中性（独白 / 阴影 / 多解障碍 / 凭证），分类闭合');

  /* 新补的 3 条地区版：三地正文确实不同，且原事件不被改写 */
  const probe = EVENTS.find(e => e.id === 'any_cleanse_water');
  const vs = ['shire', 'bree', 'wild'].map(r => call('regionVariant', probe, r));
  if (new Set(vs.map(v => v.text)).size !== 3) fail('新地区版三条正文没有差异');
  if (probe.text === vs[0].text || !probe.text) fail('regionVariant 改了原事件');
  if (!vs[0].text.includes('田埂') || !vs[1].text.includes('驿棚') || !vs[2].text.includes('岩根'))
    fail('新地区版缺地区特征词');
  ok('v0.4 新增地区版：泉眼在夏尔 / 布理 / 荒野三处正文互异，原事件保持完整');

  /* v0.4 新增事件：三件配套缺一不可 —— 正式叙事文本、可被夺走的温和选项、阴影改写 */
  const v4 = ['shire_hedge','shire_oven','shire_roost','shire_shortcut','shire_basket',
              'bree_signpost','bree_nails','bree_scale','bree_chalk','bree_lamp',
              'wild_thread','wild_steps','wild_box','wild_lee','wild_ridge'];
  const byR = {};
  for (const id of v4) {
    const ev = EVENTS.find(e => e.id === id);
    if (!ev) { fail('v0.4 事件缺失：' + id); continue; }
    byR[ev.region] = (byR[ev.region] || 0) + 1;
    if (!TEXTS[id] || !TEXTS[id].opts) fail('v0.4 事件缺正式叙事文本：' + id);
    if (!ev.options.some(o => o.gentle)) fail('v0.4 事件没有可被阴影夺走的温和选项：' + id);
    if (!SHADOW_TEXTS[id] && !SHADOW_TAIL[id]) fail('v0.4 事件没有阴影改写：' + id);
  }
  if (byR.shire !== 5 || byR.bree !== 5 || byR.wild !== 5) fail('v0.4 事件地区分布不是 5/5/5');
  ok('v0.4 新增 15 条：TEXTS / 温和选项 / 阴影改写全覆盖，地区 5/5/5');

  /* 构造一局同时含 14 类埋点的行程，逐结局验证挑选逻辑 */
  const echoes = [
    { t:'fail',    layer:7, title:'雾里的石圈', label:'走进石圈，看看中间有什么' },
    { t:'stage',   layer:6, name:'沉重' },
    { t:'gear',    layer:3, kind:'break', name:'铁匠的斧' },
    { t:'pick',    layer:2, name:'铁匠的斧' },
    { t:'letter',  layer:5 },
    { t:'vow',     layer:4 },
    { t:'region',  layer:5, from:'夏尔', to:'布理' },
    { t:'reframe', layer:6, title:'锁着的门' },
    { t:'token',   layer:4, kind:'got',  name:'生锈的钥匙' },
    { t:'token',   layer:8, kind:'used', name:'生锈的钥匙' },
    { t:'taken',   layer:7, title:'一堵墙' },
    { t:'cost',    layer:3, title:'断了的桥' },
    { t:'reroll',  layer:6, title:'一堵墙' },
    { t:'hurt',    layer:9, cause:'supply' }
  ];
  vm.runInContext('G = ' + JSON.stringify({ layer:9, echoes }), ctx);
  const heads = {
    dead:    '那之后你没有再试第二次',
    shadow:  '那天，你还在走',
    retreat: '来时的路你刚走过一遍',
    win:     '最后一段路上你没有再回头'
  };
  const outs = {};
  for (const k of Object.keys(heads)) {
    const out = vm.runInContext('buildEcho(' + JSON.stringify(k) + ', 10)', ctx);
    outs[k] = out;
    const ps = out.split('\n\n').filter(x => x.trim());
    if (!out.trim()) fail('回响为空：' + k);
    if (/undefined|NaN|\[object/.test(out)) fail('回响含脏值：' + k);
    if (new Set(ps).size !== ps.length) fail('回响段落重复：' + k);
    if (ps.length > 5) fail('回响超过 5 段：' + k);
    if (out.indexOf(heads[k]) < 0) fail('结局 ' + k + ' 的开头段不对：' + out.slice(0, 60));
  }
  if (outs.shadow.indexOf('被划掉') < 0) fail('堕影结局没有抬高「被夺走」痕迹');
  if (outs.win.indexOf('立过誓') < 0) fail('通关结局没有抬高「立誓」痕迹');
  if (outs.retreat.indexOf('换成了') < 0) fail('撤退结局没有抬高「跨地区」痕迹');
  if (outs.dead.indexOf('是第 2 程捡的') < 0) fail('倒下结局没有把「捡到→碎掉」连成因果');
  ok('4 类结局回响：开头段正确、按结局抬高对应痕迹、捡到与碎掉连成因果、无脏值无重复');

  /* once 类型不能刷屏，也不能把标记写进存档 */
  vm.runInContext('G = { layer:2, echoes:[] }', ctx);
  vm.runInContext('pushEcho({t:"taken",once:true,title:"一堵墙"}); pushEcho({t:"taken",once:true,title:"另一堵墙"}); pushEcho({t:"cost",once:true,title:"桥"})', ctx);
  const saved = JSON.parse(vm.runInContext('JSON.stringify(G.echoes)', ctx));
  if (saved.filter(e => e.t === 'taken').length !== 1) fail('once 去重失效：taken 记了多次');
  if (saved.some(e => e.once)) fail('once 标记被写进存档');
  if (saved[0].layer !== 3) fail('埋点层数不对（应为 layer+1）');
  ok('once 埋点只记第一次，标记不进存档，层数按 layer+1');
}

section('⑨ 产物');
ok('index.html ' + (fs.statSync(HTML_PATH).size / 1024).toFixed(1) + ' KB / ' + html.split('\n').length + ' 行');
ok('总层数 ' + TOTAL_LAYERS + '，装备 ' + Object.keys(ITEMS).length + ' 件，出身 ' + HEROES.length + ' 个，难度 ' + TIERS.length + ' 档');

console.log('\n' + '─'.repeat(60));
note.forEach(n => console.log('  ✓ ' + n));
if (warns.length) console.log('  运行时告警：' + warns.join(' | '));
console.log('─'.repeat(60));
if (failures) {
  console.error('\n× 回归失败：' + failures + ' 项');
  process.exit(1);
}
console.log('\n✓ 全部通过');

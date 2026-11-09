'use strict';
/* 中土远征 · 离线回归
   用法：node tests/sim.js
   零依赖。把 index.html 里的 <script> 抽出来放进 mock DOM 里跑：
   1) 数据完整性  2) 阴影机制专项  3) 刷新恢复  4) 同种子可复现  5) 300 局自动模拟。
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
  const document = {
    getElementById(id) { return cache[id] || (cache[id] = makeEl()); },
    querySelectorAll() { return []; },
    querySelector() { return makeEl(); },
    createElement() { return makeEl(); }
  };
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; }
  };
  const sandbox = {
    console: fakeConsole, document, localStorage,
    location: { search: '' }, URLSearchParams,
    setInterval() { return 0; }, clearInterval() {},
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
    ['v0.3，能完整玩通。', '版本号']
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

/* ---------- 3. 刷新恢复 ---------- */
section('③ 刷新恢复');
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

/* ---------- 4/5. 自动模拟 ---------- */
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
  const base = G.attrs[chk.attr] + ((G.pending && G.pending.riderBonus) || 0);
  const diff = raw + base - F.effDC(chk.dc);
  if (raw === 20) return 'crit';
  if (raw === 1) return 'fumble';
  return diff >= 5 ? 'clean' : (diff >= 0 ? 'cost' : 'fail');
}

const stats = { steps: 0, takenSeen: 0, regionSeen: 0, echoOK: 0, kinds: {}, echoes: new Set() };

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

section('④ 同种子可复现');
{
  const a = runOne('ranger', 3, 'REPRO-001', true);
  const b = runOne('ranger', 3, 'REPRO-001', true);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail('同种子两次结果不同（长度 ' + a.length + '/' + b.length + '）');
    const i = a.findIndex((x, k) => x !== b[k]);
    if (i >= 0) fail('首个分歧 @' + i + '：' + a[i] + ' vs ' + b[i]);
  } else ok('REPRO-001 两次一致：' + a.length + ' 个决策点，' + a[a.length - 1]);
}

section('⑤ 300 局自动模拟');
{
  const heroes = HEROES.map(h => h.id);
  const tiers = TIERS.map(t => t.id);
  stats.echoOK = 0; stats.kinds = {}; stats.echoes.clear(); stats.steps = 0;
  stats.takenSeen = 0; stats.regionSeen = 0;
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    runOne(heroes[i % heroes.length], tiers[(i * 7) % tiers.length], 'SIM-' + i, false);
  }
  ok('300 局全部结束，耗时 ' + (Date.now() - t0) + ' ms，平均 ' + (stats.steps / 300).toFixed(1) + ' 步/局');
  ok('结局分布 ' + Object.entries(stats.kinds).map(([k, v]) => k + '=' + v).join(' / '));
  ok('结算回响非空 ' + stats.echoOK + '/300，去重后 ' + stats.echoes.size + ' 种（不是同一段模板复读）');
  ok('出现被夺走选项的事件 ' + stats.takenSeen + ' 次；地区版正文命中 ' + stats.regionSeen + ' 次');
}

section('⑥ 渲染结构');
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
}

section('⑦ 产物');
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

'use strict';
/* 中土远征 · 可玩性诊断（不是回归测试）
   用法：node tests/diag.js
   回答三个问题：
   1) 地图给了多少真选择（分叉宽度 / 分叉两端是否同类）
   2) 核心机制玩家能不能遇到（阴影到达 4/6/7/8 的比例）
   3) 决策有没有回报（同一批 seed，稳健策略 vs 蛮干策略的结果差异）
   零依赖，只读 index.html，不写仓库文件。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('× 找不到内嵌 <script>'); process.exit(1); }
const code = m[1];

function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '', className: '', disabled: false,
    dataset: {}, style: {}, scrollWidth: 0, clientWidth: 0, scrollLeft: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, removeChild() {}, focus() {}, select() {}, setAttribute() {},
    onclick: null
  };
}
function makeCtx() {
  const cache = {}, store = {}, timers = [];
  const document = {
    getElementById(id) { return cache[id] || (cache[id] = makeEl()); },
    querySelectorAll() { return []; },
    querySelector(sel) { return sel === '.rollbox' ? makeEl() : makeEl(); },
    createElement() { return makeEl(); }
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    location: { search: '' }, URLSearchParams,
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    setTimeout() { return 0; }, clearTimeout() {},
    navigator: { clipboard: null }
  };
  const c = vm.createContext(sandbox);
  vm.runInContext(code, c, { filename: 'index.html' });
  return c;
}

const ctx = makeCtx();
const get = expr => vm.runInContext(expr, ctx);
function F(name, ...args) { ctx.__a = args; return vm.runInContext(name + '(...__a)', ctx); }
const fn = name => get(name);

const HEROES = get('HEROES');
const TIERS = get('TIERS');
const TOTAL_LAYERS = get('TOTAL_LAYERS');
const SHADOW_MAX = get('SHADOW_MAX');
const hashStr = fn('hashStr');
const mulberry32 = fn('mulberry32');
const hasNeed = fn('hasNeed');
const effDC = fn('effDC');

/* 这不只是报表：平衡被改坏时返回非零退出码，方便接进 CI 或提交前自检 */
let diagFailures = 0;
function must(cond, msg) {
  if (!cond) { diagFailures++; console.error('  × ' + msg); }
}

const W = { hp: 3, supply: 1.6, resolve: 1.1, renown: 0.35, material: 0.5 };
function fxScore(fx, shadowWeight) {
  if (!fx) return 0;
  let s = 0;
  for (const k in W) if (typeof fx[k] === 'number') s += W[k] * fx[k];
  if (typeof fx.shadow === 'number') s += shadowWeight * fx.shadow;
  if (fx.item || fx.token) s += 2;
  return s;
}
function prob(attr, dc, G, bonus) {
  const base = G.attrs[attr] + (bonus || 0);
  return Math.max(5, Math.min(95, Math.round((21 - (dc - base)) / 20 * 100))) / 100;
}
function optScore(o, G, style) {
  const sw = style === 'reckless' ? 2.2 : -2.6;
  let v = fxScore(o.fx, sw);
  if (o.check) {
    const p = prob(o.check.attr, effDC(o.check.dc), G, (G.pending && G.pending.checkBonus) || 0);
    v += p * fxScore(o.ok && o.ok.fx, sw) + (1 - p) * fxScore(o.no && o.no.fx, sw);
    v += (o.ok && o.ok.text ? 0 : 0);
    /* 检定本身有波动；稳健策略偏好不掷骰的确定收益 */
    if (style === 'careful') v -= 0.4;
  } else if (o.ok) v += fxScore(o.ok.fx, sw);
  if (o.shadowOpt) v += style === 'reckless' ? 6 : -9;
  if (o.final) v += 100;
  if (o.free) v += 0.1;
  if (style === 'careful' && G.hp <= 4 && (o.fx && o.fx.hp < 0 || o.check)) v -= 5;
  return v;
}
const NODE_PREF = {
  careful: { camp: 3, treasure: 2.4, story: 1.2, encounter: -2, final: 99, start: 0 },
  reckless: { camp: -1, treasure: 1, story: -0.5, encounter: 3, final: 99, start: 0 },
  random: null
};
function nodeScore(n, G, style) {
  const p = NODE_PREF[style];
  if (!p) return 0;
  let v = p[n.type] || 0;
  if (n.type === 'camp' && G.hp < G.hpMax * 0.5) v += 4;
  if (n.type === 'camp' && G.shadow >= 5) v += 2;
  return v;
}

function play(seed, heroId, tierId, style) {
  vm.runInContext('META = defaultMeta()', ctx);
  const rnd = mulberry32(hashStr(seed + '|' + style + '|drive'));
  F('newGame', heroId, tierId, seed);
  let G = get('G');
  let steps = 0;
  const peak = { shadow: 0, events: 0, checks: 0, choices: 0, forks: 0, sameFork: 0 };

  while (!G.over && steps++ < 400) {
    if (G.screen === 'map') {
      /* 稳健策略在阴影第一次 ≥4 时用一次「记起自己的名字」，看它值不值 */
      if (style === 'careful' && !peak.steadied && G.shadow >= 4 && get('steadyCost()').ok) {
        F('doSteady'); peak.steadied = true; G = get('G'); continue;
      }
      const cur = G.map.index[G.at];
      if (!cur.next || !cur.next.length) { F('endRun', 'win'); G = get('G'); continue; }
      const cands = cur.next.map(id => G.map.index[id]);
      if (cands.length > 1) {
        peak.forks++;
        if (cands.every(n => n.type === cands[0].type)) peak.sameFork++;
      } else peak.choices++;
      let pick;
      if (style === 'random') pick = cands[Math.floor(rnd() * cands.length)];
      else {
        const scored = cands.map(n => ({ n, v: nodeScore(n, G, style) + rnd() * 0.35 }));
        scored.sort((a, b) => b.v - a.v);
        pick = scored[0].n;
      }
      F('enterNode', pick.id);
    } else if (G.screen === 'event') {
      const ev = G.event;
      if (ev.id && ev.id.indexOf('__') !== 0) peak.events++;
      const clickable = ev.options.filter(o => !o.taken && !(o.need && !hasNeed(o.need)));
      let o;
      if (style === 'random' || !clickable.length) o = clickable[Math.floor(rnd() * clickable.length)] || ev.options[0];
      else {
        const scored = clickable.map(o => ({ o, v: optScore(o, G, style) + rnd() * 0.5 }));
        scored.sort((a, b) => b.v - a.v);
        o = scored[0].o;
      }
      F('chooseOption', o);
    } else if (G.screen === 'check') {
      peak.checks++;
      const o = G.pending.opt;
      const p = prob(o.check.attr, effDC(o.check.dc), G, (G.pending && G.pending.checkBonus) || 0);
      const r = rnd() * 100;
      F('settleCheck', r < 2 ? 'crit' : r < p * 100 ? 'clean' : r < p * 100 + 20 ? 'cost' : 'fail', '');
    } else if (G.screen === 'shadowend') {
      /* 阴影到顶的终局抉择：稳健的人愿意付代价翻盘，蛮干的人直接接受 */
      if (style === 'careful' && !G.shadowResistUsed && G.hp > 3) F('resistShadow');
      else F('endRun', 'shadow');
    } else break;
    G = get('G');
    peak.shadow = Math.max(peak.shadow, G.shadow || 0);
  }
  if (!G.over) { F('endRun', 'dead'); G = get('G'); }
  const o = G.over;
  return {
    kind: o.kind, reached: o.reached, renown: o.renown, shadow: peak.shadow,
    events: peak.events, checks: peak.checks, forks: peak.forks, sameFork: peak.sameFork,
    solo: peak.choices
  };
}

/* ---------- 1. 地图结构 ---------- */
console.log('\n【1】地图给的选择空间（400 张图）');
{
  const genMap = get('genMap');
  let total = 0, one = 0, same = 0, multi = 0;
  const typePairs = {};
  for (let i = 0; i < 400; i++) {
    const map = genMap('MAP-' + i);
    for (const ls of map.layers) for (const n of ls) {
      if (!n.next.length) continue;
      total++;
      if (n.next.length === 1) { one++; continue; }
      multi++;
      const ts = n.next.map(id => map.index[id].type);
      if (ts.every(t => t === ts[0])) same++;
      const key = ts.slice().sort().join('+');
      typePairs[key] = (typePairs[key] || 0) + 1;
    }
  }
  console.log('  有出边的节点 ' + total + ' 个：只有 1 个可去 ' + one + ' (' + (one / total * 100).toFixed(1) + '%)，2 个及以上 ' + multi);
  console.log('  多分叉里两端类型相同（选择可能无意义）：' + same + ' / ' + multi + ' = ' + (same / multi * 100).toFixed(1) + '%');
  console.log('  常见分叉组合：' + Object.entries(typePairs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + '=' + v).join('  '));
  console.log('  每局层数：' + TOTAL_LAYERS);
  must(one / total < 0.15, '单点路占比 ' + (one / total * 100).toFixed(1) + '%（应 <15%，仅允许通向唯一终点）');
  must(same / multi < 0.05, '同类型分叉占比 ' + (same / multi * 100).toFixed(1) + '%（应 <5%）');
}

/* ---------- 2/3. 策略对照 ---------- */
console.log('\n【2】同一批 400 个 seed × 3 种策略（同一出身/难度，不主动撤退）');
{
  const hero = HEROES[0].id, tier = 1;
  const styles = ['random', 'careful', 'reckless'];
  const agg = {};
  for (const s of styles) agg[s] = { kinds: {}, renown: 0, reached: 0, shadow: 0, at4: 0, at6: 0, at7: 0, at8: 0, events: 0, checks: 0, forks: 0, sameFork: 0, n: 0 };
  for (let i = 0; i < 400; i++) {
    for (const s of styles) {
      const r = play('DIAG-' + i, hero, tier, s);
      const a = agg[s];
      a.n++;
      a.kinds[r.kind] = (a.kinds[r.kind] || 0) + 1;
      a.renown += r.renown; a.reached += r.reached; a.shadow += r.shadow;
      a.events += r.events; a.checks += r.checks; a.forks += r.forks; a.sameFork += r.sameFork;
      if (r.shadow >= 4) a.at4++;
      if (r.shadow >= 6) a.at6++;
      if (r.shadow >= 7) a.at7++;
      if (r.shadow >= 8) a.at8++;
    }
  }
  for (const s of styles) {
    const a = agg[s], n = a.n;
    console.log('  ' + s.padEnd(9) +
      ' 通关 ' + String(a.kinds.win || 0).padStart(3) +
      ' 倒下 ' + String(a.kinds.dead || 0).padStart(3) +
      ' 堕影 ' + String(a.kinds.shadow || 0).padStart(3) +
      ' 撤退 ' + String(a.kinds.retreat || 0).padStart(3) +
      ' | 均声望 ' + (a.renown / n).toFixed(1).padStart(6) +
      ' 均程 ' + (a.reached / n).toFixed(1) +
      ' 均峰值阴影 ' + (a.shadow / n).toFixed(2));
    console.log('  '.padEnd(11) + '阴影达 4/6/7/8 的局：' + [a.at4, a.at6, a.at7, a.at8].map(v => (v / n * 100).toFixed(0) + '%').join(' / ') +
      ' | 均事件 ' + (a.events / n).toFixed(1) + ' 均检定 ' + (a.checks / n).toFixed(1));
  }
  const c = agg.careful, r = agg.random, k = agg.reckless;
  console.log('\n  稳健相对随机：声望 ' + ((c.renown - r.renown) / r.renown * 100).toFixed(1) + '%，通关 ' + ((c.kinds.win || 0) - (r.kinds.win || 0)) + ' 局');
  console.log('  蛮干相对稳健：堕影 ' + ((k.kinds.shadow || 0) - (c.kinds.shadow || 0)) + ' 局，均程差 ' + ((k.reached - c.reached) / 400).toFixed(2));
  must((c.kinds.win || 0) > (r.kinds.win || 0) * 1.5, '稳健策略的通关率没有显著高于乱点 —— 决策失去回报');
  must((k.kinds.shadow || 0) > (c.kinds.shadow || 0) * 2, '蛮干策略的堕影率没有显著高于稳健 —— 阴影机制失去后果');
}

/* ---------- 4. 决策点密度 ---------- */
console.log('\n【3】单个事件的可选项与检定占比');
{
  const EVENTS = get('EVENTS');
  let opts = 0, checks = 0, gentle = 0, noCheck = 0;
  for (const e of EVENTS) {
    opts += e.options.length;
    const c = e.options.filter(o => o.check).length;
    checks += c;
    if (!c) noCheck++;
    gentle += e.options.filter(o => o.gentle).length;
  }
  console.log('  ' + EVENTS.length + ' 事件 / ' + opts + ' 选项 / 检定 ' + checks + ' (' + (checks / opts * 100).toFixed(0) + '%)');
  console.log('  完全不需要掷骰的事件 ' + noCheck + ' (' + (noCheck / EVENTS.length * 100).toFixed(0) + '%)，显式 gentle 标记 ' + gentle + ' 个');
}

/* ---------- 5. 出身/难度区分度 ---------- */
console.log('\n【4】出身与难度是否拉开差距（各 120 局，稳健策略）');
{
  for (const h of HEROES) {
    let win = 0, rn = 0;
    for (let i = 0; i < 120; i++) { const r = play('H-' + i, h.id, 1, 'careful'); if (r.kind === 'win') win++; rn += r.renown; }
    console.log('  出身 ' + h.id.padEnd(9) + ' 通关 ' + String(win).padStart(3) + '/120  均声望 ' + (rn / 120).toFixed(1).padStart(6) + '  | ' + h.trait);
  }
  const tierWins = [];
  for (const t of TIERS) {
    let win = 0, rn = 0;
    for (let i = 0; i < 120; i++) { const r = play('T-' + i, 'ranger', t.id, 'careful'); if (r.kind === 'win') win++; rn += r.renown; }
    tierWins.push(win);
    console.log('  难度 ' + String(t.id).padEnd(9) + ' 通关 ' + String(win).padStart(3) + '/120  均声望 ' + (rn / 120).toFixed(1).padStart(6) + '  | ' + t.name);
  }
  for (let i = 1; i < tierWins.length; i++)
    must(tierWins[i] <= tierWins[i - 1], '难度 ' + (i + 1) + ' 比第 ' + i + ' 档更容易通关（' + tierWins[i] + ' > ' + tierWins[i - 1] + '），曲线断了');
  must(tierWins[0] - tierWins[tierWins.length - 1] >= 30, '首尾难度差距不足 30 局，六档没有拉开');
}

if (diagFailures) { console.error('\n× 平衡诊断未通过：' + diagFailures + ' 项\n'); process.exitCode = 1; }
else console.log('\n✓ 平衡诊断通过：分叉空间、策略回报、难度单调\n');

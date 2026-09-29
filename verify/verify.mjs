#!/usr/bin/env node
/**
 * verify.mjs — 一次性验收服务（Compose 服务名：verify）
 *
 * 依次完成：
 *   1. 复现登记 A→B=5、B→C=-2 ⇒ 可行且 A→C=3；
 *      再登记 A→C=4 ⇒ 推导值与冲突值构成的矛盾环（逐项相加复算）；
 *      撤回后下一检查点恢复可行。矛盾环标识由活动集合本身稳定决定：
 *      环上三条关系中取标识最小者 r1（G−r1 推出 A→B=6 ≠ 登记值 5）。
 *   1b. 回归业务路径：C/D 站点上 e0: C→D=2、e1: D→C=-1，六个检查点
 *      依次为 无冲突、e0、e0、e0、无冲突、无冲突；同一活动集合
 *      {e0,e1} 在三个检查点上给出逐字段相同的见证（由 e1 推出 C→D=1
 *      与 e0 的 2 冲突），撤回 e0 后恢复可行。
 *   2. 运行全部代码测试（node --test test/）。
 *   3. 构建产物并做清单/校验和检查（tools/build.mjs --check）。
 *   4. 对页面与健康状态做 HTTP 冒烟：
 *      - 容器网络地址 WEB_BASE_URL（默认 http://web:8080）
 *      - 宿主机映射端口地址 WEB_PUBLISHED_URL（默认
 *        http://host.docker.internal:${WEB_PORT:-8080}，验证可配置宿主机端口）
 *
 * 全部通过退出码 0；任一阶段失败退出码 1。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTERNAL_URL = process.env.WEB_BASE_URL || 'http://web:8080';
const PUBLISHED_URL = process.env.WEB_PUBLISHED_URL
  || `http://host.docker.internal:${process.env.WEB_PORT || '8080'}`;
const SKIP_PUBLISHED = process.env.SMOKE_SKIP_PUBLISHED === '1';
const READY_TIMEOUT_MS = 60_000;

const DSParser = (await import('../web/js/parser.js')).default;
const DSCable = (await import('../web/js/solver.js')).default;
const { parseScript } = DSParser;
const { solveAudit, deriveAt } = DSCable;

let failures = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail && !cond ? ` —— ${detail}` : ''}`);
  if (!cond) failures += 1;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('close', (code) => res(code));
  });
}

/* ---------- 阶段 1：业务场景复现 ---------- */
section('阶段 1：复现登记 / 冲突 / 撤回恢复场景');

const scenario = [
  'stations: A,B,C',
  'r1: A→B=5',
  'r2: B→C=-2',
  'checkpoint', // 1：可行，A→C 可推导为 3
  'r3: A→C=4',
  'checkpoint', // 2：不相容环上标识最小者 r1 被稳定选出
  'withdraw r3',
  'checkpoint', // 3：撤回后恢复可行
].join('\n');

const parsed = parseScript(scenario);
check('脚本能无错误解析', parsed.ok, JSON.stringify(parsed.errors));

if (parsed.ok) {
  const results = solveAudit(parsed.ops, parsed.stations);
  check('共得到 3 个检查点结论', results.length === 3, `实际 ${results.length}`);

  const cp1 = results[0];
  check('检查点 1 可行', cp1 && cp1.feasible === true);
  const d1 = cp1 && deriveAt(cp1, parsed.stations, 'A', 'C');
  check('检查点 1 可推导 A→C = 3', d1 && d1.status === 'ok' && d1.value === 3n,
    `实际 ${d1 && d1.status} ${d1 && d1.value}`);

  const cp2 = results[1];
  check('检查点 2 判定冲突', cp2 && cp2.feasible === false);
  const c = cp2 && cp2.conflict;
  // 稳定选环：矛盾环成员为 r1/r2/r3，取标识最小者 r1，而不是“闭合边” r3
  check('矛盾环稳定选取环上标识最小的关系 r1', c && c.id === 'r1', c && c.id);
  check('环推导值为 6（= 4 + 2：沿 r3 正向、r2 反向）',
    c && c.derived === 6n, c && String(c.derived));
  check('冲突值为 r1 的登记值 5', c && c.d === 5n, c && String(c.d));
  if (c) {
    let sum = 0n;
    for (const row of c.ring) sum += row.contrib;
    check('环中各式逐项相加 ∑ = 6 (= 4 + 2)', sum === 6n, `实际 ${sum}`);
    const byId = Object.fromEntries(c.ring.map((r) => [r.id, r]));
    check('矛盾环包含 r3（贡献 +4）', byId.r3 && byId.r3.contrib === 4n);
    check('矛盾环包含 r2（反向使用，贡献 +2）',
      byId.r2 && byId.r2.reversed === true && byId.r2.contrib === 2n);
    console.log('  环复算明细：');
    for (const row of c.ring) {
      console.log(
        `    - ${row.id}: ${row.u}→${row.v}=${row.d}` +
        `  环方向 x_${row.plus}−x_${row.minus}${row.reversed ? '（反向）' : ''}` +
        `  取值 ${row.contrib}`
      );
    }
  }

  const cp3 = results[2];
  check('撤回 r3 后检查点 3 恢复可行', cp3 && cp3.feasible === true);
  check('检查点 3 活动关系仅剩 r1、r2',
    cp3 && JSON.stringify(cp3.activeIds) === JSON.stringify(['r1', 'r2']));
  const d3 = cp3 && deriveAt(cp3, parsed.stations, 'A', 'C');
  check('检查点 3 重新推导 A→C = 3', d3 && d3.status === 'ok' && d3.value === 3n);
}

/* ---------- 阶段 1b：矛盾环标识跨检查点稳定（回归） ---------- */
section('阶段 1b：同一活动集合跨检查点的矛盾环见证必须稳定');

const regress = [
  'stations: C,D',
  'e0: C→D=2',
  'checkpoint', // 1：仅 e0，无冲突
  'e1: D→C=-1',
  'checkpoint', // 2：e0,e1 同时活动，冲突，稳定选 e0
  'checkpoint', // 3：活动关系不变，见证必须不变
  'checkpoint', // 4：活动关系不变，见证必须不变
  'withdraw e0',
  'checkpoint', // 5：撤回 e0，恢复可行
  'checkpoint', // 6：仍可行
].join('\n');

const parsedR = parseScript(regress);
check('回归脚本能无错误解析', parsedR.ok, JSON.stringify(parsedR.errors));

if (parsedR.ok) {
  const rs = solveAudit(parsedR.ops, parsedR.stations);
  check('共得到 6 个检查点结论', rs.length === 6, `实际 ${rs.length}`);
  check('六个检查点冲突标识依次为 无、e0、e0、e0、无、无',
    rs.map((r) => (r.conflict ? r.conflict.id : null))
      .every((id, i) => id === [null, 'e0', 'e0', 'e0', null, null][i]),
    rs.map((r) => (r.conflict ? r.conflict.id : '无冲突')).join('、'));
  check('六个检查点可行性依次为 可行、冲突、冲突、冲突、可行、可行',
    rs.map((r) => r.feasible).join(',') === 'true,false,false,false,true,true');

  let fingerprint = null;
  for (const k of [1, 2, 3]) {
    const r = rs[k];
    check(`检查点 ${k + 1} 活动关系为 e0,e1`,
      JSON.stringify(r.activeIds) === JSON.stringify(['e0', 'e1']),
      JSON.stringify(r.activeIds));
    const c = r.conflict;
    check(`检查点 ${k + 1} 矛盾环标识为最小标识 e0`, c && c.id === 'e0', c && c.id);
    check(`检查点 ${k + 1} 由 e1 推导 C→D = 1`, c && c.derived === 1n,
      c && String(c.derived));
    check(`检查点 ${k + 1} 冲突值为 e0 登记的 2`, c && c.d === 2n, c && String(c.d));
    check(`检查点 ${k + 1} 环逐项相加 ∑ = 1`, c && c.sum === 1n, c && String(c.sum));
    const fp = JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    if (fingerprint === null) fingerprint = fp;
    else check(`检查点 ${k + 1} 见证与检查点 2 逐字段相同`, fp === fingerprint);
  }

  for (const k of [4, 5]) {
    check(`检查点 ${k + 1} 活动关系仅剩 e1 且无冲突`,
      rs[k].feasible === true && JSON.stringify(rs[k].activeIds) === JSON.stringify(['e1']));
    const d = deriveAt(rs[k], parsedR.stations, 'C', 'D');
    check(`检查点 ${k + 1} 可推导 C→D = 1`, d.status === 'ok' && d.value === 1n,
      `${d.status} ${d.value}`);
  }
}

/* ---------- 阶段 2：代码测试 ---------- */
section('阶段 2：代码测试 node --test test/');
const testCode = await run('node', ['--test', 'test/']);
check('全部单元测试通过', testCode === 0, `退出码 ${testCode}`);

/* ---------- 阶段 3：构建产物检查 ---------- */
section('阶段 3：构建产物与清单校验');
const buildCode = await run('node', ['tools/build.mjs']);
check('构建成功', buildCode === 0, `退出码 ${buildCode}`);
const checkCode = await run('node', ['tools/build.mjs', '--check']);
check('产物 sha256 清单与资源引用检查通过', checkCode === 0, `退出码 ${checkCode}`);

/* ---------- 阶段 4：HTTP 冒烟 ---------- */
async function waitReady(base) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return true;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr;
}

async function smoke(base, label) {
  section(`阶段 4：HTTP 冒烟（${label}） ${base}`);
  await waitReady(base);

  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check(`${label} GET / 返回 200`, home.status === 200, `HTTP ${home.status}`);
  check(`${label} 页面包含校核台标题`, homeText.includes('站间偏移校核台'));

  const health = await fetch(`${base}/healthz`);
  const healthText = await health.text();
  let healthJson = null;
  try { healthJson = JSON.parse(healthText); } catch { /* 下面报错 */ }
  check(`${label} GET /healthz 返回 200`, health.status === 200, `HTTP ${health.status}`);
  check(`${label} 健康状态为 ok`, healthJson && healthJson.status === 'ok', healthText);

  const asset = await fetch(`${base}/js/solver.js`);
  check(`${label} 静态资源 js/solver.js 返回 200`, asset.status === 200, `HTTP ${asset.status}`);
}

try {
  await smoke(INTERNAL_URL, '容器网络');
} catch (e) {
  check(`容器网络冒烟就绪并通过`, false, e.message);
}

if (!SKIP_PUBLISHED) {
  try {
    await smoke(PUBLISHED_URL, '宿主机映射端口');
  } catch (e) {
    check('宿主机映射端口冒烟就绪并通过', false,
      `${e.message}（可用 SMOKE_SKIP_PUBLISHED=1 跳过）`);
  }
} else {
  console.log('\n=== 阶段 4：宿主机映射端口冒烟已按配置跳过 ===');
}

/* ---------- 结论 ---------- */
section('验收结论');
if (failures === 0) {
  console.log('ACCEPTED ✅  全部验收项通过');
  process.exit(0);
} else {
  console.error(`REJECTED ❌  共 ${failures} 个验收项失败`);
  process.exit(1);
}

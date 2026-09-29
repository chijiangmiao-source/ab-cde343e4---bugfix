#!/usr/bin/env node
/**
 * verify.mjs — 一次性验收服务（Compose 服务名：verify）
 *
 * 依次完成：
 *   1. 复现登记 A→B=5、B→C=-2 ⇒ 可行且 A→C=3；
 *      再登记 A→C=4 ⇒ 推导值 3 与冲突值 4 的矛盾环（逐项相加复算）；
 *      撤回后下一检查点恢复可行。
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
  'checkpoint', // 2：推导值 3 与冲突值 4 构成矛盾环
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
  check('矛盾环由新登记关系 r3 闭合触发', c && c.id === 'r3', c && c.id);
  check('环推导值为 3', c && c.derived === 3n, c && String(c.derived));
  check('冲突值为 4', c && c.d === 4n, c && String(c.d));
  if (c) {
    let sum = 0n;
    for (const row of c.ring) sum += row.contrib;
    check('环中各式逐项相加 ∑ = 3 (= 5 + (-2))', sum === 3n, `实际 ${sum}`);
    const byId = Object.fromEntries(c.ring.map((r) => [r.id, r]));
    check('矛盾环包含 r1（贡献 +5）', byId.r1 && byId.r1.contrib === 5n);
    check('矛盾环包含 r2（贡献 -2）', byId.r2 && byId.r2.contrib === -2n);
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

/* ---------- 阶段 1b：相同活动集合跨检查点的矛盾环标识必须稳定 ---------- */
section('阶段 1b：登记—连续检查点—撤回，矛盾环标识只由活动关系决定');

const stableScript = [
  'stations: C,D',
  'e0: C→D=2',
  'checkpoint', // 1：仅 e0，无冲突
  'e1: D→C=-1', // 与 e0 矛盾：e1 推出 C→D=1，e0 给出 2
  'checkpoint', // 2：冲突，应稳定选标识最小的 e0
  'checkpoint', // 3：活动关系未变，见证必须与检查点 2 完全相同
  'checkpoint', // 4：同上（旧版本在此错误改报 e0/另一标识）
  'withdraw e0',
  'checkpoint', // 5：仅剩 e1，恢复可行
  'checkpoint', // 6：仍可行
].join('\n');

const parsedStable = parseScript(stableScript);
check('稳定场景脚本能无错误解析', parsedStable.ok, JSON.stringify(parsedStable.errors));

if (parsedStable.ok) {
  const rs = solveAudit(parsedStable.ops, parsedStable.stations);
  check('共得到 6 个检查点结论', rs.length === 6, `实际 ${rs.length}`);
  check(
    '六个检查点矛盾环标识依次为：无、e0、e0、e0、无、无',
    JSON.stringify(rs.map((r) => (r.conflict ? r.conflict.id : null)))
      === JSON.stringify([null, 'e0', 'e0', 'e0', null, null]),
    JSON.stringify(rs.map((r) => (r.conflict ? r.conflict.id : null))),
  );
  for (const k of [1, 2, 3]) {
    const c = rs[k] && rs[k].conflict;
    check(`检查点 ${k + 1} 展示 e1 推导 C→D = 1`, c && c.u === 'C' && c.v === 'D' && c.derived === 1n,
      c && `id=${c.id} ${c.u}→${c.v} derived=${c && c.derived}`);
    check(`检查点 ${k + 1} 与 e0 登记值 2 冲突`, c && c.d === 2n, c && String(c.d));
    check(`检查点 ${k + 1} 环中各式相加 ∑ = 1`, c && c.sum === 1n, c && String(c && c.sum));
    check(`检查点 ${k + 1} 活动关系为 e0、e1`,
      c && JSON.stringify(rs[k].activeIds) === JSON.stringify(['e0', 'e1']));
  }
  check('三个冲突检查点的见证彼此完全一致',
    JSON.stringify(rs[1].conflict, bigReplacer) === JSON.stringify(rs[2].conflict, bigReplacer)
      && JSON.stringify(rs[2].conflict, bigReplacer) === JSON.stringify(rs[3].conflict, bigReplacer));
  check('撤回 e0 后检查点 5、6 恢复可行',
    rs[4] && rs[4].feasible === true && rs[5] && rs[5].feasible === true);
  const d5 = rs[4] && deriveAt(rs[4], parsedStable.stations, 'C', 'D');
  check('撤回后由 e1 推导 C→D = 1', d5 && d5.status === 'ok' && d5.value === 1n,
    d5 && `${d5.status} ${d5.value}`);
}

function bigReplacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
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

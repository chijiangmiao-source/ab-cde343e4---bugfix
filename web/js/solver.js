/*
 * solver.js — 深海观测缆偏移关系校核内核
 *
 * 关系形如 x_v - x_u = d（登记为 u→v=d）。
 *
 * 处理方式（不得为每个检查点重扫全部活动关系）：
 *   1. 每条关系的“登记—撤回”生命周期换算成它在检查点时间轴上的活动区间 [l,r]；
 *   2. 区间挂到检查点线段树的 O(log K) 个节点上（时间区间分治）；
 *   3. DFS 线段树，进入节点时把关系并入“可回滚带势并查集”，离开时按快照回滚。
 *      并查集只按大小合并不做路径压缩，pot[x] = x 的读数 - 父节点读数，
 *      回滚即恢复 parent/size/pot/link，总复杂度 O((E+K) log K · α)。
 *   4. 分治森林只负责判定可行性：其形态随检查点在线段树上的位置而变，不能直接
 *      用来取证。判定为冲突的叶节点，改用“当前仍活动的关系集合”本身规范构造
 *      矛盾环：凡在删掉自己的活动关系图中两端仍连通、且沿森林推出的偏移与登记
 *      值不符的关系，都是不相容环上的候选，候选中取关系标识最小者，环由其余
 *      关系的森林路径逐项相加拼成。见证只由活动集合决定，同一活动集合在任何
 *      检查点位置都得到同一矛盾环标识、推导值与冲突值。
 *
 * 同一份文件既可作为浏览器普通脚本（window.DSCable），也可在 Node 中被测试引用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSCable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 可回滚带势并查集。
   * 不变量：对任意非根节点 x，pot[x] = value(x) - value(parent[x])。
   * find 不做路径压缩，返回 {r, w}，w = value(x) - value(r)。
   */
  class RollbackDSU {
    constructor(n) {
      this.n = n;
      this.parent = Array.from({ length: n }, (_, i) => i);
      this.size = new Array(n).fill(1);
      this.pot = new Array(n).fill(0n);
      // link[x] 仅在 x 被挂到别的根之下时有效：
      // { edge, childAnchor, parentAnchor } 分别是关系对象和关系两端中
      // 落在“子树根侧 / 父树根侧”的端点名。
      this.link = new Array(n).fill(null);
      this.stack = [];
    }

    find(x) {
      let r = x;
      let w = 0n;
      while (this.parent[r] !== r) {
        w += this.pot[r];
        r = this.parent[r];
      }
      return { r, w };
    }

    snapshot() {
      return this.stack.length;
    }

    /**
     * 并入关系 x_v - x_u = d（端点编号 iu/iv，端点名 u/v）。
     * 成功：{ok:true, redundant?:true}（redundant 表示关系早已被蕴含，未改动结构）。
     * 失败：{ok:false, derived, conflict, vPath, uPath}
     *   derived = 并查集沿当前树推出的 x_v-x_u；conflict = d；
     *   vPath/uPath 为推出 derived 的两条树路径（v→根、u→根）。
     */
    union(iu, iv, u, v, d, edge) {
      const a = this.find(iu); // value(u) = value(a.r) + a.w
      const b = this.find(iv); // value(v) = value(b.r) + b.w

      if (a.r === b.r) {
        const derived = b.w - a.w; // x_v - x_u
        if (derived === d) return { ok: true, redundant: true };
        return {
          ok: false,
          derived,
          conflict: d,
          vPath: this._path(iv),
          uPath: this._path(iu),
        };
      }

      // 默认把 a 根挂到 b 根之下：
      // value(u)=value(a)+a.w, value(v)=value(b)+b.w，且 value(v)-value(u)=d
      // ⇒ pot[a] = value(a)-value(b) = b.w - a.w - d
      let child = a.r;
      let big = b.r;
      let delta = b.w - a.w - d;
      let childAnchor = u;
      let parentAnchor = v;
      if (this.size[child] > this.size[big]) {
        // 改为把 b 挂到 a 下，势与锚点全部反号
        child = b.r;
        big = a.r;
        delta = -delta;
        childAnchor = v;
        parentAnchor = u;
      }

      this.stack.push({
        child,
        big,
        sizeBigWas: this.size[big],
        potWas: this.pot[child],
        linkWas: this.link[child],
      });
      this.parent[child] = big;
      this.pot[child] = delta;
      this.size[big] += this.size[child];
      this.link[child] = { edge, childAnchor, parentAnchor };
      return { ok: true };
    }

    _path(x) {
      const rows = [];
      let c = x;
      while (this.parent[c] !== c) {
        const lk = this.link[c];
        rows.push({
          edge: lk.edge,
          value: this.pot[c], // value(child) - value(parent)
          childAnchor: lk.childAnchor,
          parentAnchor: lk.parentAnchor,
        });
        c = this.parent[c];
      }
      return rows;
    }

    rollback(snap) {
      while (this.stack.length > snap) {
        const h = this.stack.pop();
        this.parent[h.child] = h.child;
        this.pot[h.child] = h.potWas;
        this.link[h.child] = h.linkWas;
        this.size[h.big] = h.sizeBigWas;
      }
    }
  }

  function byIdAsc(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function byLineAsc(a, b) {
    return a.line - b.line || byIdAsc(a, b);
  }

  /**
   * 由“当前仍活动的关系集合”本身规范构造矛盾环（与检查点位置无关）。
   *
   * 活动关系构成带势无向图 G。一条关系 e: u→v=d 确实落在某个不相容环上，
   * 当且仅当 G−e 中 u、v 仍连通，且存在一条 u→v 路径其权值和 ≠ d。
   * 按关系标识升序枚举，第一条满足的关系即稳定选出的最小标识；环由 G−e
   * 的生成树路径（必要时借道一条矛盾回边）拼成，环上各式逐项相加即为
   * 推导值，e 的登记值为冲突值。返回的 value/rootOf 是 G−e 生成树在同一
   * 确定性遍历下赋予的势，供冲突页稳定展示推导读数。
   *
   * @returns {Object|null} {edge, derived, ring, value, rootOf}；相容时返回 null
   */
  function canonicalWitness(edges, n, index) {
    const sorted = edges.slice().sort(byIdAsc);

    // 环中一行：行走式 x_plus − x_minus = contrib（行走方向为 minus→plus）
    const rowOf = (e, plus, minus) => ({
      id: e.id,
      u: e.u,
      v: e.v,
      d: e.d,
      line: e.line,
      plus,
      minus,
      reversed: plus === e.u, // plus 为登记起点 u 时，行走与登记方向相反
      contrib: plus === e.v ? e.d : -e.d,
    });

    // 生成树上 x→y 的行走行（x、y 同根）：x 上溯到 LCA，再反向沿 y 的父边下来
    const treePath = (x, y, depth, parentNode, parentEdge) => {
      // 从子节点 a 沿其父边走向父节点时的行走行
      const upRow = (a) => {
        const e = parentEdge[a];
        const back = a === index.get(e.v); // a 在登记终点一侧：行走方向为 v→u
        return rowOf(e, back ? e.u : e.v, back ? e.v : e.u);
      };
      let a = x;
      let b = y;
      const up = [];
      while (depth[a] > depth[b]) {
        up.push(upRow(a));
        a = parentNode[a];
      }
      const down = [];
      while (depth[b] > depth[a]) {
        down.push(upRow(b));
        b = parentNode[b];
      }
      while (a !== b) {
        up.push(upRow(a));
        a = parentNode[a];
        down.push(upRow(b));
        b = parentNode[b];
      }
      // 下行段逐行逆向：正负端互换、贡献取反
      for (let i = down.length - 1; i >= 0; i -= 1) {
        const r = down[i];
        up.push({ ...r, plus: r.minus, minus: r.plus, reversed: !r.reversed, contrib: -r.contrib });
      }
      return up;
    };

    for (const e of sorted) {
      // 在 G−e 上以 BFS 建生成树并赋势；value[x] = x 的读数 − 根读数
      const adj = new Array(n);
      for (let i = 0; i < n; i += 1) adj[i] = [];
      for (const g of sorted) {
        if (g === e) continue;
        adj[index.get(g.u)].push(g);
        adj[index.get(g.v)].push(g);
      }
      const value = new Array(n).fill(null);
      const parentNode = new Array(n).fill(-1);
      const parentEdge = new Array(n).fill(null);
      const depth = new Array(n).fill(0);
      const rootOf = new Array(n).fill(-1);
      const badByRoot = new Map(); // root -> 该分量第一条矛盾回边 {g, from}

      for (let s = 0; s < n; s += 1) {
        if (value[s] !== null || adj[s].length === 0) continue;
        value[s] = 0n;
        rootOf[s] = s;
        const queue = [s];
        for (let qi = 0; qi < queue.length; qi += 1) {
          const x = queue[qi];
          for (const g of adj[x]) {
            // 从 x 走向另一端 y：顺登记方向（u→v）增量为 d，反向为 -d
            const forward = index.get(g.u) === x;
            const y = forward ? index.get(g.v) : index.get(g.u);
            const w = forward ? g.d : -g.d;
            if (value[y] === null) {
              value[y] = value[x] + w;
              parentNode[y] = x;
              parentEdge[y] = g;
              depth[y] = depth[x] + 1;
              rootOf[y] = s;
              queue.push(y);
            } else if (!badByRoot.has(s) && value[y] - value[x] !== w) {
              badByRoot.set(s, { g, from: x }); // 从 x 顺登记方向走向 y 即矛盾
            }
          }
        }
      }

      const iu = index.get(e.u);
      const iv = index.get(e.v);
      if (value[iu] === null || value[iv] === null) continue; // 删掉 e 后两端不连通
      if (rootOf[iu] !== rootOf[iv]) continue;

      let ring = treePath(iu, iv, depth, parentNode, parentEdge);
      let derived = value[iv] - value[iu]; // G−e 生成树推出的 x_v − x_u
      if (derived === e.d) {
        // 树路径恰好相容，但同一分量存在非零和矛盾环：经矛盾回边 g 绕道，
        // u→from 走树、顺向过 g、to→v 走树，其和相对 e.d 偏离一个非零矛盾量。
        const bad = badByRoot.get(rootOf[iu]);
        if (!bad) continue;
        const g = bad.g;
        const from = bad.from;
        const to = from === index.get(g.u) ? index.get(g.v) : index.get(g.u);
        ring = treePath(iu, from, depth, parentNode, parentEdge);
        // 从 from 走到 to（即 BFS 发现的矛盾方向）：行走式 x_to − x_from
        ring.push(rowOf(g,
          to === index.get(g.v) ? g.v : g.u,
          from === index.get(g.v) ? g.v : g.u));
        ring.push(...treePath(to, iv, depth, parentNode, parentEdge));
        derived = 0n;
        for (const r of ring) derived += r.contrib;
      }
      return { edge: e, derived, ring, value, rootOf };
    }
    return null;
  }

  /**
   * 离线求解全部检查点。
   *
   * @param {Array} ops 已通过语法/语义校验的操作序列：
   *   {kind:'reg', id, u, v, d(BigInt), line}
   *   {kind:'withdraw', id, line}
   *   {kind:'checkpoint', line}
   * @param {string[]} stations 全部合法站点名（声明或隐式出现），编号即下标
   * @param {Object|null} stats 可选统计：{unionCalls, rollbackCalls, intervals} 由函数填充，
   *   用于证明并入次数随区间分治为 O(E log K) 而非 O(E·K)
   * @returns {Array<Object>} 每个检查点一个结论，顺序对应检查点出现次序
   */
  function solveAudit(ops, stations, stats) {
    if (stats) {
      stats.unionCalls = 0;
      stats.rollbackCalls = 0;
      stats.intervals = 0;
    }
    const index = new Map();
    stations.forEach((name, i) => index.set(name, i));

    // 1. 统计检查点数量，并把每条登记关系换算为活动检查点区间
    let m = 0;
    for (const op of ops) if (op.kind === 'checkpoint') m += 1;

    const intervals = [];
    const live = new Map(); // id -> edge（当前仍活动的那次登记）
    let cp = 0; // 已经过的检查点数（时间轴游标）
    for (const op of ops) {
      if (op.kind === 'reg') {
        const edge = {
          id: op.id,
          u: op.u,
          v: op.v,
          d: op.d,
          line: op.line,
          start: cp + 1, // 只对“未来”的检查点生效（1-based）
        };
        live.set(op.id, edge);
      } else if (op.kind === 'withdraw') {
        const edge = live.get(op.id);
        edge.end = cp; // 撤回操作之前出现过的检查点仍包含该关系
        intervals.push(edge);
        live.delete(op.id);
      } else if (op.kind === 'checkpoint') {
        cp += 1;
      }
    }
    for (const edge of live.values()) {
      edge.end = m;
      intervals.push(edge);
    }
    if (stats) stats.intervals = intervals.length;

    const results = new Array(m);
    if (m === 0) return results;

    // 2. 区间挂线段树
    const tree = Array.from({ length: 4 * m + 4 }, () => []);
    const add = (node, l, r, ql, qr, edge) => {
      if (ql <= l && r <= qr) {
        tree[node].push(edge);
        return;
      }
      const mid = (l + r) >> 1;
      if (ql <= mid) add(node << 1, l, mid, ql, qr, edge);
      if (qr > mid) add(node << 1 | 1, mid + 1, r, ql, qr, edge);
    };
    for (const e of intervals) {
      if (e.start <= e.end) add(1, 1, m, e.start, e.end, e);
    }

    // 3. 时间分治 DFS + 可回滚带势并查集
    // 分治森林只用于判定可行性（相容时也提供稳定的势）；冲突见证改由
    // canonicalWitness 从活动关系集合本身构造，避免森林形态随叶位置漂移。
    const dsu = new RollbackDSU(stations.length);
    const useCount = new Array(stations.length).fill(0);
    const activeIds = new Set();
    const activeEdges = new Set();
    let badOnPath = 0; // 根→当前路径上分治森林发现的矛盾次数（仅判定有无冲突）

    // 矛盾见证只依赖活动关系集合：同一集合只规范构造一次并复用，
    // 既省去重复计算，也在结构上保证不同检查点位置拿到完全相同的结论。
    const witnessCache = new Map();
    const witnessFor = () => {
      const key = Array.from(activeEdges)
        .sort(byIdAsc)
        .map((e) => `${e.id}@${e.line}`)
        .join(' ');
      let w = witnessCache.get(key);
      if (w === undefined) {
        w = canonicalWitness(Array.from(activeEdges), stations.length, index);
        witnessCache.set(key, w);
      }
      return w;
    };

    const dfs = (node, l, r) => {
      const snap = dsu.snapshot();
      const applied = [];
      let badHere = 0;

      // 节点内按登记行号升序并入（与脚本时间顺序一致），仅用于可行性判定
      const edges = tree[node].slice().sort(byLineAsc);
      for (const e of edges) {
        activeIds.add(e.id);
        activeEdges.add(e);
        useCount[index.get(e.u)] += 1;
        useCount[index.get(e.v)] += 1;
        applied.push(e);
        if (stats) stats.unionCalls += 1;
        const rr = dsu.union(index.get(e.u), index.get(e.v), e.u, e.v, e.d, e);
        if (!rr.ok) badHere += 1;
      }
      badOnPath += badHere;

      if (l === r) {
        results[l - 1] = makeLeaf(l, badOnPath > 0);
      } else {
        const mid = (l + r) >> 1;
        dfs(node << 1, l, mid);
        dfs(node << 1 | 1, mid + 1, r);
      }

      badOnPath -= badHere;
      for (const e of applied) {
        activeIds.delete(e.id);
        activeEdges.delete(e);
        useCount[index.get(e.u)] -= 1;
        useCount[index.get(e.v)] -= 1;
      }
      if (stats) stats.rollbackCalls += 1;
      dsu.rollback(snap);
    };

    function makeLeaf(no, hasConflict) {
      let conflict = null;
      let potentials;

      if (hasConflict) {
        // 见证只依赖当前活动关系集合：同一集合在任何检查点位置完全一致
        const w = witnessFor();
        if (w) {
          let sum = 0n;
          for (const row of w.ring) sum += row.contrib;
          conflict = {
            id: w.edge.id,
            u: w.edge.u,
            v: w.edge.v,
            d: w.edge.d,
            line: w.edge.line,
            derived: w.derived,
            sum,
            ring: w.ring,
          };
          // 用 G−e 的规范生成树势展示读数（e 所在分量删掉 e 后仍连通）
          potentials = [];
          for (let i = 0; i < stations.length; i += 1) {
            if (w.value[i] !== null) {
              potentials.push({ name: stations[i], root: w.rootOf[i], w: w.value[i] });
            }
          }
        } else {
          // 不可能到达：分治已判定活动集合不相容，就必存在不相容环上的关系
          throw new Error('internal: feasibility conflict without a canonical witness');
        }
      }

      if (!conflict) {
        // 相容：直接取分治森林的势
        potentials = [];
        for (let i = 0; i < stations.length; i += 1) {
          if (useCount[i] > 0) {
            const f = dsu.find(i);
            potentials.push({ name: stations[i], root: f.r, w: f.w });
          }
        }
      }

      return {
        checkpoint: no,
        feasible: conflict === null,
        activeIds: Array.from(activeIds).sort(),
        potentials,
        conflict,
      };
    }

    dfs(1, 1, m);
    return results;
  }

  /**
   * 在某个检查点结论上推导 x_b - x_a。
   * 返回 {status:'ok', value(BigInt)} |
   *      {status:'unknown_endpoint', which} |
   *      {status:'inactive_endpoint', which} |
   *      {status:'disconnected'}
   */
  function deriveAt(result, stations, a, b) {
    const at = new Map(stations.map((n, i) => [n, i]));
    if (!at.has(a)) return { status: 'unknown_endpoint', which: a };
    if (!at.has(b)) return { status: 'unknown_endpoint', which: b };
    const pa = result.potentials.find((p) => p.name === a);
    const pb = result.potentials.find((p) => p.name === b);
    if (!pa) return { status: 'inactive_endpoint', which: a };
    if (!pb) return { status: 'inactive_endpoint', which: b };
    if (pa.root !== pb.root) return { status: 'disconnected' };
    return { status: 'ok', value: pb.w - pa.w };
  }

  return {
    RollbackDSU,
    solveAudit,
    deriveAt,
  };
});

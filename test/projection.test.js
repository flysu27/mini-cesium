/**
 * projection.test.js —— 把"投影公式"钉死在"投影矩阵"上
 *
 * ── 为什么必须有这个测试 ──────────────────────────────────────────
 * 这个项目里同一个投影有两套写法:
 *   · 文档、注释、实验台用"闭式公式"—— 便于教学,能一眼看出每个量的来历
 *       x_ndc = x / (d · tan(fovY/2) · aspect)
 *       y_ndc = y / (d · tan(fovY/2))
 *       z_ndc = f_far·(d − n) / (d·(f_far − n))
 *   · 引擎用"矩阵"—— 便于 GPU,一次乘法算完 4 个分量
 *       m = perspective(fovY, aspect, n, f_far),然后 transformPoint
 *
 * 两套写法只要有一处不一致,教学就是错的——而且是最坏的那种错:
 * 读者照着注释推导半天,却发现"讲的和跑的"不是一个东西。
 * 所以这里做穷举交叉验证:7168 组参数,逐点比较两套写法。
 *
 * 顺带把 11 条"教学不变量"也钉住 —— 它们是实验台每一张图、每一句解释的依据:
 *   1. 近平面 n 完全不出现在 NDC 里(推导中被约掉)
 *   2. aspect 只进 x,不进 y、不进 z
 *   3. 视锥截面对角线上的点,落在 NDC 方框的对角线上
 *   4. z_ndc 的边界(z=-n→0, z=-f→1)与对 d 的单调性
 *   5. w_clip = −z_view(相机背后的点 w 为负,所以拾取必须先查符号)
 *   6. 从眼睛看,两个相似三角形投影到同一个屏幕三角形(这是"投影"的定义)
 *   7. 小三角形是大三角形以眼睛为中心的 n/d 位似
 *   8. z_ndc 在 1/d 上均分,不在 d 上均分
 *   9. 最近的一倍视距永远拿走至少 50% 的深度值(极限恰为 50%)
 *  10. z_ndc 就是"屏幕高度"的仿射重标定
 *  11. 行向量约定(转置形式)与列向量约定给出逐位相同的结果,−1 在 m[11]
 *
 * 这几条一旦被后人改坏,测试会立刻红——它们不是"可能成立",是"必须成立"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perspective, transformPoint } from '../src/math/mat4.js';

/** 闭式公式(与 demo/m0-projection-lab.html 里逐字一致) */
const closedForm = (n, fFar, fovDeg, aspect, d, x, y) => {
  const tan = Math.tan(fovDeg * Math.PI / 360);
  return {
    x: x / (d * tan * aspect),
    y: y / (d * tan),
    z: fFar * (d - n) / (d * (fFar - n)),
  };
};

/** 容差:矩阵用 Float32Array 存储,相对误差 ~6e-8;除以很小的 d 会被放大,故用相对容差 */
const tolerance = (want) => 1e-6 + 1e-6 * Math.abs(want);

test('闭式公式 ≡ perspective 矩阵(穷举 7168 组参数)', () => {
  let worst = { x: 0, y: 0, z: 0 };
  let worstAt = null;
  let cases = 0;

  for (const n of [0.1, 1, 2, 5]) {
    for (const fFar of [12, 40, 100, 800]) {
      for (const fovDeg of [20, 50, 90, 110]) {
        for (const aspect of [0.6, 1, 1.6, 2.4]) {
          // 深度必须覆盖:近平面本身、近处、中间、远平面本身
          const depths = [n, n * 1.5, n * 3, n * 10, (n + fFar) / 2, fFar * 0.9, fFar];
          for (const d of depths) {
            for (const [x, y] of [[0, 0], [3, 5], [-7.3, 2.1], [12, -7]]) {
              const m = perspective(fovDeg * Math.PI / 180, aspect, n, fFar);
              const got = transformPoint(m, { x, y, z: -d });   // 相机看向 -Z,故 z = -d
              const want = closedForm(n, fFar, fovDeg, aspect, d, x, y);
              cases++;

              for (const k of ['x', 'y', 'z']) {
                const err = Math.abs(got[k] - want[k]);
                if (err > worst[k]) {
                  worst[k] = err;
                  worstAt = { n, fFar, fovDeg, aspect, d, x, y, k, got: got[k], want: want[k] };
                }
                assert.ok(
                  err <= tolerance(want[k]),
                  `${k} 不一致 @ n=${n} f_far=${fFar} fov=${fovDeg} aspect=${aspect} d=${d} `
                  + `(${x},${y}): 矩阵给出 ${got[k]},闭式公式给出 ${want[k]},误差 ${err}`
                );
              }
            }
          }
        }
      }
    }
  }

  assert.equal(cases, 7168, `用例数应为 7168,实际 ${cases}`);
  // 误差必须是"Float32 量级",不能是"公式写错量级"
  assert.ok(worst.x < 1e-3, `x 最大绝对误差 ${worst.x} 过大`);
  assert.ok(worst.y < 1e-5, `y 最大绝对误差 ${worst.y} 过大`);
  assert.ok(worst.z < 1e-6, `z 最大绝对误差 ${worst.z} 过大`);
  void worstAt;   // 调试时打印用,断言通过即无需输出
});

test('不变量 1:近平面 n 被约掉——改动 n 不动任何 NDC 读数', () => {
  const aspect = 1.6, fovDeg = 50, d = 12, x = 3, y = 5;
  const base = closedForm(1, 400, fovDeg, aspect, d, x, y);
  for (const n of [0.1, 0.5, 1, 2, 5, 8]) {
    // 注意 d 必须始终大于 n(点在相机前方、且在近平面之后),f_far 也必须大于 n
    const r = closedForm(n, 400, fovDeg, aspect, d, x, y);
    assert.equal(r.x, base.x, `n=${n} 时 x_ndc 变了`);
    assert.equal(r.y, base.y, `n=${n} 时 y_ndc 变了`);
  }
});

test('不变量 2:aspect 只进 x,不进 y、不进 z', () => {
  const n = 2, fFar = 40, fovDeg = 50, d = 12, x = 3, y = 5;
  const a1 = closedForm(n, fFar, fovDeg, 1.0, d, x, y);
  const a2 = closedForm(n, fFar, fovDeg, 2.4, d, x, y);
  assert.equal(a1.y, a2.y, 'aspect 影响了 y_ndc');
  assert.equal(a1.z, a2.z, 'aspect 影响了 z_ndc');
  // x_ndc 与 aspect 严格成反比:x1·aspect1 = x2·aspect2
  assert.ok(Math.abs(a1.x * 1.0 - a2.x * 2.4) < 1e-12, 'x_ndc 与 aspect 不成反比');
});

test('不变量 3:视锥截面对角线上的点 → NDC 方框的对角线', () => {
  // 截面上满足 x = aspect·y 的点,投影后必然 x_ndc = y_ndc(即 NDC 方框的对角线)
  const n = 2, fFar = 40, fovDeg = 50, d = 12;
  for (const aspect of [0.6, 1, 1.6, 2.4]) {
    const y = 5, x = aspect * y;
    const r = closedForm(n, fFar, fovDeg, aspect, d, x, y);
    assert.ok(Math.abs(r.x - r.y) < 1e-12, `aspect=${aspect} 时 (${x},${y}) 未落在 NDC 对角线上`);
  }
});

test('不变量 4:z_ndc 的两个边界与单调性(WebGPU: z ∈ [0,1])', () => {
  const n = 2, fFar = 40;
  assert.ok(Math.abs(closedForm(n, fFar, 50, 1.6, n, 0, 0).z - 0) < 1e-12, 'z_ndc(近平面) ≠ 0');
  assert.ok(Math.abs(closedForm(n, fFar, 50, 1.6, fFar, 0, 0).z - 1) < 1e-12, 'z_ndc(远平面) ≠ 1');

  let prev = -Infinity;
  for (let d = n; d <= fFar; d += 0.25) {
    const z = closedForm(n, fFar, 50, 1.6, d, 0, 0).z;
    assert.ok(z >= prev, `z_ndc 在 d=${d} 处不单调`);
    assert.ok(z >= 0 && z <= 1, `z_ndc 在 d=${d} 处越界: ${z}`);
    prev = z;
  }
});

test('不变量 6:从眼睛 E 看,两个相似三角形在屏幕上完全重合', () => {
  // 实验台里画了两个三角形:
  //   大:E(0,0,0) – Fb(x,0,−d) – P(x,y,−d)
  //   小:E(0,0,0) – Fs(x·n/d,0,−n) – p′(x·n/d, y·n/d, −n)
  // 它们是以 E 为中心的 n/d 位似。**从 E 本身看,两者投影到同一个屏幕三角形**——
  // 这是"投影"的定义,也是 y_ndc 只依赖比值 y/d(而非 d、y 各自大小)的根源。
  // 这条在渲染上是画不出来的(相机不能放在三角形顶点上),只能靠断言钉住。
  const n = 2, fFar = 40, aspect = 1.6, d = 12, x = 3, y = 5;
  const m = perspective(50 * Math.PI / 180, aspect, n, fFar);
  const k = n / d;

  // P 与 p′:同一条射线上的两点 → 屏幕坐标必须一致
  const sp = transformPoint(m, { x, y, z: -d });
  const sq = transformPoint(m, { x: x * k, y: y * k, z: -n });
  assert.ok(Math.abs(sp.x - sq.x) < 1e-6, `P.x=${sp.x} vs p′.x=${sq.x}`);
  assert.ok(Math.abs(sp.y - sq.y) < 1e-6, `P.y=${sp.y} vs p′.y=${sq.y}`);
  // 但深度值不同 —— 深度是屏幕上唯一还能区分它们的量(E6 讲 Z-fighting 的起点)
  assert.ok(sp.z > sq.z, '远处的点深度值应更大(WebGPU z 越大越远)');

  // 垂足 Fb 与 Fs:同样重合
  const sf = transformPoint(m, { x, y: 0, z: -d });
  const sg = transformPoint(m, { x: x * k, y: 0, z: -n });
  assert.ok(Math.abs(sf.x - sg.x) < 1e-6 && Math.abs(sf.y - sg.y) < 1e-6,
    '两个垂足在屏幕上未重合');

  // 夹角也相同:两条腿除以各自深度,得到同一个角 —— "顶角相同"的证明
  const slopeBig = y / d, slopeSmall = (y * k) / n;
  assert.ok(Math.abs(slopeBig - slopeSmall) < 1e-12, '两个三角形的顶角不相等');
});

test('不变量 7:小三角形是大三角形以 E 为中心的 n/d 位似', () => {
  const n = 2, d = 12, x = 3, y = 5, k = n / d;
  // 三个顶点逐一验证:小 = 大 × (n/d)
  const big = [[0, 0, 0], [x, 0, -d], [x, y, -d]];
  const small = [[0, 0, 0], [x * k, 0, -n], [x * k, y * k, -n]];
  for (let i = 0; i < 3; i++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(small[i][c] - big[i][c] * k) < 1e-12,
        `顶点 ${i} 分量 ${c} 不是位似关系`);
    }
  }
  // 位似 ⇒ 相似 ⇒ 三边长度全部成 k 倍
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
    assert.ok(Math.abs(len(small[i], small[j]) - len(big[i], big[j]) * k) < 1e-12,
      `边 ${i}-${j} 未按 k 缩放`);
  }
});

test('不变量 5:w_clip = -z_view(相机背后的点 w 为负)', () => {
  // 这不是"能算出来"的问题,而是"M2 拾取必须先检查 w 符号"的原因:
  // 相机看向 -Z,所以前方点的 z_view < 0 → w = -z_view > 0;
  // 背后点的 z_view > 0 → w < 0,透视除法会把它翻到画面里(符号翻转)。
  const m = perspective(50 * Math.PI / 180, 1.6, 0.1, 100);
  const wOf = (z) => m[11] * z + m[15];   // 矩阵第 4 行只有 (3,2) = -1
  assert.ok(wOf(-5) > 0, '相机前方(z_view=-5)的 w 应为正');
  assert.ok(wOf(5) < 0, '相机背后(z_view=+5)的 w 应为负——这正是需要提前检查的地方');
  assert.ok(wOf(0) === 0, '过原点的点 w = 0,透视除法会得到 Inf/NaN(视线平面上的退化情形)');
});

// ── 深度值分配:三条钉住"为什么近处占一大半"的不变量 ────────────────
// 这三条是 demo 里「深度值到底分给了谁」那张图的全部依据。
// 图只是把式子的数值画出来 —— 数值错了,图就是在骗人。

test('不变量 8:z_ndc 在 1/d 上均分,不在 d 上均分', () => {
  const n = 2, f = 40;
  const zNdc = (d) => f * (d - n) / (d * (f - n));
  const dAtZ = (z) => 1 / (1 / n - z * (1 / n - 1 / f));

  // (a) 等 z 步长 ⇒ 1/d 严格等步长。这就是"在 1/d 上均分"的字面意思。
  const zs = [0, 0.25, 0.5, 0.75, 1];
  const inv = zs.map((z) => 1 / dAtZ(z));
  const step = inv[1] - inv[0];
  for (let i = 2; i < inv.length; i++) {
    assert.ok(Math.abs((inv[i] - inv[i - 1]) - step) < 1e-12, '1/d 步长不相等');
  }

  // (b) 反过来:等 d 步长 ⇒ z_ndc 步长单调递减(近密远疏)。
  const steps = [];
  for (let k = 0; k < 10; k++) {
    const d0 = n + (f - n) * k / 10;
    const d1 = n + (f - n) * (k + 1) / 10;
    steps.push(zNdc(d1) - zNdc(d0));
  }
  for (let k = 1; k < steps.length; k++) {
    assert.ok(steps[k] < steps[k - 1], `第 ${k} 个等距段的 z_ndc 步长没有缩小`);
  }
  assert.ok(steps[0] / steps[9] > 100,
    `首尾等距段的 z_ndc 步长比只有 ${(steps[0] / steps[9]).toFixed(1)},近密远疏不明显`);
});

test('不变量 9:最近的一倍视距永远拿走至少 50% 的深度值', () => {
  // 这是那张图最反直觉的结论,也是它存在的理由。
  // 参照位移取 d: n → 2n —— "最近的一倍视距",长度恰好是 n。
  const zNdc = (n, f, d) => f * (d - n) / (d * (f - n));
  for (const n of [0.1, 1, 2, 5, 8]) {
    for (const f of [12, 40, 100, 1e3, 1e6]) {
      if (!(2 * n < f)) continue;      // 参照位移超出视锥就没有意义
      const z = zNdc(n, f, 2 * n);
      assert.ok(z > 0.5 - 1e-9, `n=${n} f=${f}:z_ndc(2n)=${z} 低于 50%`);
      assert.ok(z <= 1 + 1e-12, `n=${n} f=${f}:z_ndc(2n)=${z} 超过 1`);
    }
  }
  // 极限:f_far → ∞ 时 z_ndc = 1 − n/d,所以 z_ndc(2n) = 0.5,且从上方单调逼近。
  let prev = Infinity;
  for (const f of [12, 40, 100, 1e3, 1e4, 1e6]) {
    const z = zNdc(2, f, 4);
    assert.ok(z < prev, 'f_far 变大时 z_ndc(2n) 应单调下降');
    prev = z;
  }
  assert.ok(Math.abs(prev - 0.5) < 1e-4, `f→∞ 的极限应为 0.5,实为 ${prev}`);
});

test('不变量 10:z_ndc 就是"屏幕高度"的仿射重标定', () => {
  // 这是「为什么近处占一大半」的真正答案 —— 不是"设计者选择了不均分":
  //   屏幕上的高度 ∝ 1/d(相似三角形,与 n 无关)
  //   z_ndc = (1/n − 1/d)/(1/n − 1/f) 恰好是 1/d 的仿射函数
  // 两者是同一条曲线、只差一次线性重标定 —— 于是"深度值的分配"
  // 就是"屏幕大小的分配"。屏幕是均匀的,深度值也就必须均匀。
  const n = 2, f = 40;
  const h = (d) => 1 / d;                          // 屏幕高度(差一个常数因子)
  const zNdc = (d) => f * (d - n) / (d * (f - n));
  for (const d of [n, 3, 5, 9, 17, 31, f]) {
    const affine = (h(d) - h(n)) / (h(f) - h(n));
    assert.ok(Math.abs(affine - zNdc(d)) < 1e-12, `d=${d} 处仿射关系不成立`);
  }
  // 直接推论:z_ndc = 0.5 时,屏幕高度恰好落在首尾的中点。
  const dHalf = 2 / (1 / n + 1 / f);
  assert.ok(Math.abs(h(dHalf) - (h(n) + h(f)) / 2) < 1e-12, 'z=0.5 处屏幕高度不是中点');
  // 图上标出来的两个百分比,也在断言里算一遍,免得标错。
  assert.ok(Math.abs(zNdc(2 * n) - 0.526315789) < 1e-6, 'z_ndc(2n) 应为 52.6%');
  assert.ok(Math.abs((2 * n - n) / (f - n) - 0.052631578) < 1e-6, '距离轴占比应为 5.3%');
});

// ── 约定:两种书写形式是同一件事 ────────────────────────────────────
// 同一个投影有两套排版习惯,矩阵"长得不一样",经常让人以为其中一个写错了:
//   列向量右乘  v' = M · v    (本仓库 / WGSL / OpenGL)  → -1 在最后一行
//   行向量左乘  v' = v · Mᵀ   (DirectX / 不少教材)      → -1 在最后一列
// 下面把这条等价关系钉住,并顺手钉住"忘了转置会出事"。

test('不变量 11:行向量约定(转置形式)与列向量约定结果逐位相同', () => {
  const m = perspective(50 * Math.PI / 180, 1.6, 0.1, 100);
  // 列主序下标 → 数学行列:m[col*4 + row] 就是 M[row][col]。
  // 注意矩阵里的 -1 在 m[11](第 3 行第 2 列),不在 m[14]。
  const at = (row, col) => m[col * 4 + row];
  assert.ok(m[11] === -1, `w_clip 的 -1 应在 m[11](第 3 行第 2 列),实为 m[11]=${m[11]}`);

  for (const [x, y, z] of [[3, 5, -12], [-7.3, 2.1, -1.5], [0, 0, -40]]) {
    const byColumn = transformPoint(m, { x, y, z });   // M · v

    // 行向量 v · Mᵀ:Mᵀ 的第 i 行第 j 列 = M 的第 j 行第 i 列 = at(j, i)
    const v = [x, y, z, 1];
    const clip = [0, 1, 2, 3].map((j) => v.reduce((s, vi, i) => s + vi * at(j, i), 0));
    const w = clip[3];

    assert.ok(Math.abs(w - -z) < 1e-6, `转置形式下 w_clip 应为 -z = ${-z},实为 ${w}`);
    const byRow = { x: clip[0] / w, y: clip[1] / w, z: clip[2] / w };
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Math.abs(byRow[k] - byColumn[k]) < 1e-6,
        `分量 ${k} 不一致:行向量 ${byRow[k]} vs 列向量 ${byColumn[k]}`);
    }

    // 反例:拿行向量直接乘这一版(忘了转置)。w_clip 会变成 z·B 而不是 -z。
    // 这条断言的作用是"防改":若有人把 perspective 换成行主序输出,
    // 这里会立刻红,提醒他 transformPoint 与所有注释必须同步改。
    const wrongW = v.reduce((s, vi, i) => s + vi * m[3 * 4 + i], 0);
    assert.ok(Math.abs(wrongW - -z) > 1e-3,
      '行向量直接乘本矩阵竟然也对——说明矩阵约定已被改动,需同步检查 transformPoint 与注释');
  }
});

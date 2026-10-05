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
 * 顺带把三条"教学不变量"也钉住:
 *   1. 近平面 n 完全不出现在 NDC 里(推导中被约掉)
 *   2. aspect 只进 x,不进 y、不进 z
 *   3. 视锥截面对角线上的点,落在 NDC 方框的对角线上
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

/**
 * quat 测试 —— 旋转的第二种表示,以及它和矩阵表示的一致性。
 *
 * 这里只验证数学,不碰 GPU。重点钉三件事:
 *   1. 四元数乘法与矩阵乘法**同构**(同一个旋转,两条路走出来的矩阵逐位相同);
 *   2. q 与 −q 是同一个旋转(双覆盖),toMat4 必须给出逐位相同的矩阵;
 *   3. slerp 是"匀速最短弧",不是"参数空间里走直线"。
 * 第 1 条是整套约定得以成立的地基:只要它成立,四元数就能直接替换那两个角,
 * 而不需要动视图矩阵一个字。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quat, identity, fromAxisAngle, multiply, conjugate, dot, length, normalize, toMat4, slerp,
} from '../src/math/quat.js';
import { rotationX, rotationY, rotationZ, multiply as matMultiply, transformPoint } from '../src/math/mat4.js';

const D2R = Math.PI / 180;

/** 逐元素比较两个矩阵(都是 Float32Array,所以容差按单精度给;tol=0 表示逐位相同)。 */
function assertMatClose(a, b, tol = 1e-5, msg = '') {
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(a[i] - b[i]) <= tol,
      `${msg} 第 ${i} 项差 ${Math.abs(a[i] - b[i])}: ${a[i]} vs ${b[i]}`);
  }
}

/**
 * 两个姿态之间的夹角(度)。
 * 用四元数的弦长算:既对 0° 附近稳定(不走 acos),又自动处理双覆盖
 * (q 与 −q 是同一个旋转,取两支弦长的较小者)。
 */
function angleBetween(a, b) {
  const d1 = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
  const d2 = Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
  return 2 * Math.asin(Math.min(1, Math.min(d1, d2) / 2)) * 180 / Math.PI;
}

test('identity 是单位元:作用后不动,且左乘右乘都是自己', () => {
  const q = fromAxisAngle([0.3, -0.8, 0.5], 1.1);
  assertMatClose(toMat4(multiply(identity(), q)), toMat4(q), 1e-6, 'e⊗q');
  assertMatClose(toMat4(multiply(q, identity())), toMat4(q), 1e-6, 'q⊗e');
  assertMatClose(toMat4(identity()), rotationX(0), 1e-6, '单位四元数 = 单位矩阵');
});

test('fromAxisAngle:轴不需要预先单位化,角度公式与基本旋转矩阵一致', () => {
  for (const [axis, ref] of [
    [[1, 0, 0], rotationX],
    [[0, 1, 0], rotationY],
    [[0, 0, 1], rotationZ],
  ]) {
    for (const deg of [0, 30, -45, 137]) {
      const rad = deg * D2R;
      // 轴故意乘一个非 1 的倍数:fromAxisAngle 内部必须自己归一化
      assertMatClose(toMat4(fromAxisAngle(axis.map((v) => v * 7), rad)), ref(rad), 1e-5,
        `轴 ${axis} 转 ${deg}°`);
    }
  }
});

test('乘法与矩阵乘法同构:toMat4(a⊗b) = toMat4(a)·toMat4(b)', () => {
  // 这条恒等式是"四元数可以直接替掉那两个角"的全部依据。
  // 它一旦不成立,TrackballCamera 的 viewMatrix() 就不能长得和 OrbitCamera 一样。
  const cases = [
    [[0, 1, 0], 0.7, [1, 0, 0], 0.4],
    [[1, 0, 0], -1.9, [0, 0, 1], 2.3],
    [[0.5, 0.5, 0.7], 3.0, [-0.2, 0.9, 0.1], 0.6],
  ];
  for (const [a1, ra, a2, rb] of cases) {
    const qa = fromAxisAngle(a1, ra), qb = fromAxisAngle(a2, rb);
    assertMatClose(toMat4(multiply(qa, qb)), matMultiply(toMat4(qa), toMat4(qb)), 1e-5,
      `a=(${a1}) b=(${a2})`);
  }
});

test('旋转不交换:换顺序结果不同(这不是 bug,是旋转的本性)', () => {
  const qx = fromAxisAngle([1, 0, 0], 0.9), qy = fromAxisAngle([0, 1, 0], 0.9);
  const diff = angleBetween(multiply(qx, qy), multiply(qy, qx));
  assert.ok(diff > 20, `先 X 后 Y 与先 Y 后 X 应当明显不同,实际只差 ${diff.toFixed(2)}°`);
});

test('共轭 = 逆:正着转再反着转回到原地', () => {
  const q = normalize(fromAxisAngle([0.2, -0.7, 0.4], 2.2));
  assertMatClose(toMat4(multiply(conjugate(q), q)), rotationX(0), 1e-6, 'q⁻¹⊗q');
  // 作用到向量上:先转再反着转,点回到原位
  const M = matMultiply(toMat4(conjugate(q)), toMat4(q));
  const p = { x: 1.5, y: -0.25, z: 3 };
  const back = transformPoint(M, p);
  assert.ok(Math.abs(back.x - p.x) < 1e-5 && Math.abs(back.y - p.y) < 1e-5
    && Math.abs(back.z - p.z) < 1e-5, '往返变换应当回到原坐标');
});

test('双覆盖:q 与 −q 是同一个旋转,toMat4 逐位相同', () => {
  const q = fromAxisAngle([0.3, 0.6, -0.2], 1.7);
  const neg = quat(-q.x, -q.y, -q.z, -q.w);
  assertMatClose(toMat4(neg), toMat4(q), 0, 'q 与 −q 的矩阵应当逐位相同');
  assert.ok(Math.abs(dot(q, neg) + 1) < 1e-9, 'q·(−q) 应当正好等于 −1');
});

test('normalize:长度拉回 1,方向不变;零四元数不炸', () => {
  const q = quat(2, -4, 1, 3);
  assert.ok(Math.abs(length(normalize(q)) - 1) < 1e-12, '归一化后长度应为 1');
  assertMatClose(toMat4(normalize(q)), toMat4(q), 1e-6, '归一化不该改变旋转');
  const z = normalize(quat(0, 0, 0, 0));
  assert.ok(Number.isFinite(z.w), '零四元数不能产生 NaN');
});

test('slerp:端点、中点、以及"匀速最短弧"', () => {
  const a = fromAxisAngle([0, 1, 0], 0.3);
  const b = fromAxisAngle([0, 1, 0], 0.3 + 120 * D2R);
  assert.ok(angleBetween(slerp(a, b, 0), a) < 1e-3, 't=0 应当是起点');
  assert.ok(angleBetween(slerp(a, b, 1), b) < 1e-3, 't=1 应当是终点');
  // 匀速:slerp 到 t 处的姿态,与起点的夹角应当 ≈ t·总角
  const total = angleBetween(a, b);
  for (const t of [0.25, 0.5, 0.75]) {
    const d = angleBetween(slerp(a, b, t), a);
    assert.ok(Math.abs(d - t * total) < 0.5,
      `t=${t} 处应当走了 ${(t * total).toFixed(2)}°,实际 ${d.toFixed(2)}°`);
  }
  // 同轴不同向:中点应当正好是"再走一半",不是抄近路的线性插值
  const mid = slerp(a, fromAxisAngle([0, 1, 0], 0.3 - 40 * D2R), 0.5);
  assert.ok(angleBetween(mid, fromAxisAngle([0, 1, 0], 0.3 - 20 * D2R)) < 0.5,
    '反向旋转时 slerp 必须沿短弧(取反后插值)');
});

test('slerp 的退化分支:两点几乎重合时不产生 NaN', () => {
  const a = fromAxisAngle([0.1, 0.2, 0.3], 1.0);
  const b = fromAxisAngle([0.1, 0.2, 0.3], 1.0 + 1e-7);
  for (const t of [0, 0.5, 1]) {
    const s = slerp(a, b, t);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.w), `t=${t} 不能出 NaN`);
    assert.ok(Math.abs(length(s) - 1) < 1e-6, `t=${t} 应当仍是单位四元数`);
  }
  // q 与 −q:同一个旋转,slerp 不该"扫过 180°"
  const q = fromAxisAngle([0.4, -0.5, 0.6], 0.8);
  const neg = quat(-q.x, -q.y, -q.z, -q.w);
  assert.ok(angleBetween(slerp(q, neg, 0.5), q) < 1e-3,
    'slerp 到自身的相反数应当原地不动');
});

test('slerp 不绕远路:与欧拉角线性插值对比(实测 90° 的活走成 150°)', () => {
  // 两个姿态:(yaw 0°, pitch 88°, roll 0°) → (yaw 180°, pitch 88°, roll 0°)。
  // 它们之间真正的夹角是 90°,但在欧拉角空间里把两个角同时对拉过去,
  // 姿态会在中途甩出去 60° —— 这就是"动画看着抽了一下"的来源。
  const A = [0, 88 * D2R, 0], B = [180 * D2R, 88 * D2R, 0];
  const eulerM = (t) => matMultiply(rotationY(A[0] + (B[0] - A[0]) * t),
    matMultiply(rotationX(A[1] + (B[1] - A[1]) * t), rotationZ(A[2] + (B[2] - A[2]) * t)));
  const qa = multiply(fromAxisAngle([0, 1, 0], A[0]),
    multiply(fromAxisAngle([1, 0, 0], A[1]), fromAxisAngle([0, 0, 1], A[2])));
  const qb = multiply(fromAxisAngle([0, 1, 0], B[0]),
    multiply(fromAxisAngle([1, 0, 0], B[1]), fromAxisAngle([0, 0, 1], B[2])));

  // 矩阵 → 四元数(迹公式),只为了让欧拉侧的姿态也能用同一把尺子量
  const asQuat = (m) => {
    const tr = m[0] + m[5] + m[10];
    const w = Math.sqrt(Math.max(0, 1 + tr)) / 2;
    const s = 4 * w || 1e-12;
    return quat((m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, w);
  };
  const pathLen = (at, N) => {
    let L = 0, prev = at(0);
    for (let i = 1; i <= N; i++) { const cur = at(i / N); L += angleBetween(prev, cur); prev = cur; }
    return L;
  };

  const straight = angleBetween(qa, qb);
  const eulerPath = pathLen((t) => asQuat(eulerM(t)), 400);
  const slerpPath = pathLen((t) => slerp(qa, qb, t), 400);
  const deviation = (() => {
    let dev = 0;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      dev = Math.max(dev, angleBetween(asQuat(eulerM(t)), slerp(qa, qb, t)));
    }
    return dev;
  })();

  assert.ok(Math.abs(straight - 90) < 0.5, `两点之间的真实夹角应当是 90°,实际 ${straight.toFixed(1)}°`);
  assert.ok(Math.abs(slerpPath - straight) < 1,
    `slerp 的路径长应当就是直线距离 ${straight.toFixed(1)}°,实际 ${slerpPath.toFixed(1)}°`);
  assert.ok(eulerPath > straight * 1.5,
    `欧拉角插值应当明显绕远:直线 ${straight.toFixed(1)}°,欧拉 ${eulerPath.toFixed(1)}°`);
  assert.ok(deviation > 30,
    `欧拉角插值应当在中途甩出去(实测 60°),实际最大偏离 ${deviation.toFixed(1)}°`);
});

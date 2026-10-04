import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identity, multiply, translation, rotationX, rotationY, rotationZ,
  perspective, transformPoint,
} from '../src/math/mat4.js';

/** 构造一个"乱"矩阵,用于做代数性质测试(避免撞上特殊结构的巧合)。 */
function arbitrary(seed) {
  const m = new Float32Array(16);
  let s = seed;
  for (let i = 0; i < 16; i++) {
    s = (s * 1103515245 + 12345) % 2147483648; // 线性同余,可复现
    m[i] = (s / 2147483648) * 2 - 1;
  }
  return m;
}

function assertClose(a, b, eps = 1e-9, msg = '') {
  assert.equal(a.length, b.length, msg);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < eps, `${msg} [${i}] ${a[i]} vs ${b[i]}`);
  }
}

test('identity: 任何矩阵乘单位阵保持不变', () => {
  const m = arbitrary(7);
  assertClose(multiply(identity(), m), m);
  assertClose(multiply(m, identity()), m);
});

test('multiply: 结合律 (A·B)·C = A·(B·C)', () => {
  const A = arbitrary(11), B = arbitrary(22), C = arbitrary(33);
  // 矩阵存在 Float32Array 里。中间结果被舍入到 32 位,
  // 所以结合律只在 ~1e-5 精度上成立——这是"存储精度"与"数学恒等式"的区别,
  // 也是为什么拾取这类对精度敏感的代码要用 Float64 做中间计算(M2 会遇到)。
  assertClose(multiply(multiply(A, B), C), multiply(A, multiply(B, C)), 1e-5);
});

test('rotationZ(90°): 把 +X 转到 +Y(右手定则)', () => {
  const p = transformPoint(rotationZ(Math.PI / 2), { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(p.x) < 1e-12);
  assert.ok(Math.abs(p.y - 1) < 1e-12);
});

test('旋转 + 平移的顺序不可交换(钉死乘法约定)', () => {
  const p = { x: 1, y: 0, z: 0 };
  // 先旋转(绕 Z 90°: X→Y),再平移 (0,0,1) → (0,1,1)
  const tAfterR = transformPoint(multiply(translation(0, 0, 1), rotationZ(Math.PI / 2)), p);
  assert.ok(Math.abs(tAfterR.x) < 1e-12);
  assert.ok(Math.abs(tAfterR.y - 1) < 1e-12);
  assert.ok(Math.abs(tAfterR.z - 1) < 1e-12);

  // 先平移,再旋转:X 上的点 (1,0,0) 平移到 (1,0,1),绕 Z 转 90° → (0,1,1)? 不对:
  // (1,0,1) 绕 Z 旋转只影响 x,y → x=1,y=0 转为 x=0,y=1,z 不变 → (0,1,1)。
  // 两个结果在此特例下相同!换一个能区分的平移量 (1,0,0):
  const rAfterT = transformPoint(multiply(rotationZ(Math.PI / 2), translation(1, 0, 0)), p);
  // p 平移到 (2,0,0),旋转 90° → (0,2,0)
  assert.ok(Math.abs(rAfterT.x) < 1e-12);
  assert.ok(Math.abs(rAfterT.y - 2) < 1e-12);
});

test('rotationX / rotationY 各自把正确的轴转到正确的轴', () => {
  // 绕 X 转 90°:+Y → +Z
  const py = transformPoint(rotationX(Math.PI / 2), { x: 0, y: 1, z: 0 });
  assert.ok(Math.abs(py.z - 1) < 1e-12 && Math.abs(py.y) < 1e-12);
  // 绕 Y 转 90°:+Z → +X(右手系:拇指指向 +Y)
  const pz = transformPoint(rotationY(Math.PI / 2), { x: 0, y: 0, z: 1 });
  assert.ok(Math.abs(pz.x - 1) < 1e-12 && Math.abs(pz.z) < 1e-12);
});

test('perspective: 近平面映到 NDC z=0,远平面映到 z=1(WebGPU 约定)', () => {
  const n = 0.1, f = 100;
  const P = perspective(Math.PI / 3, 1, n, f);
  const zn = transformPoint(P, { x: 0, y: 0, z: -n });
  const zf = transformPoint(P, { x: 0, y: 0, z: -f });
  assert.ok(Math.abs(zn.z - 0) < 1e-9, `near → ${zn.z}`);
  assert.ok(Math.abs(zf.z - 1) < 1e-9, `far → ${zf.z}`);
});

test('perspective: 视锥顶面边缘映到 NDC y=1', () => {
  const fovY = Math.PI / 3, aspect = 1, n = 0.1;
  const P = perspective(fovY, aspect, n, 100);
  // 近平面上的点,位于视锥上边缘:y = n·tan(fovY/2)
  const top = transformPoint(P, { x: 0, y: n * Math.tan(fovY / 2), z: -n });
  // Float32 舍入:tan(π/6) 是无理数,存进 Float32Array 后必然有 ~1e-8 的偏差
  assert.ok(Math.abs(top.y - 1) < 1e-6, `top → ${top.y}`);
});

test('perspective: 距离减半的物体,屏幕上大小翻倍(透视的本质)', () => {
  const P = perspective(Math.PI / 3, 1, 0.1, 100);
  const h = 1; // 世界空间中竖直长度为 1 的线段
  const yFar = transformPoint(P, { x: 0, y: h / 2, z: -4 }).y
             - transformPoint(P, { x: 0, y: -h / 2, z: -4 }).y;
  const yNear = transformPoint(P, { x: 0, y: h / 2, z: -2 }).y
              - transformPoint(P, { x: 0, y: -h / 2, z: -2 }).y;
  assert.ok(Math.abs(yNear / yFar - 2) < 1e-9);
});

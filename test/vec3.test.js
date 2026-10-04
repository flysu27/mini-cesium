import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  vec3, add, sub, scale, dot, cross, length, normalize, lerp,
} from '../src/math/vec3.js';

const X = vec3(1, 0, 0);
const Y = vec3(0, 1, 0);
const Z = vec3(0, 0, 1);

test('length: 3-4-5 直角三角形', () => {
  assert.equal(length(vec3(3, 4, 0)), 5);
});

test('dot: 交换律,且与正交基的点积为 0', () => {
  const a = vec3(1, 2, 3);
  const b = vec3(4, -5, 6);
  assert.equal(dot(a, b), dot(b, a));
  assert.equal(dot(X, Y), 0);
  // 自点积 = 长度平方
  assert.equal(dot(a, a), 14);
});

test('cross: 右手定则 x×y=z', () => {
  const r = cross(X, Y);
  assert.deepEqual([r.x, r.y, r.z], [0, 0, 1]);
});

test('cross: 反交换 a×b = -(b×a)', () => {
  const a = vec3(1, 2, 3);
  const b = vec3(-4, 5, 6);
  const ab = cross(a, b);
  const ba = cross(b, a);
  assert.deepEqual([ab.x + ba.x, ab.y + ba.y, ab.z + ba.z], [0, 0, 0]);
});

test('cross: 平行向量为零向量(sinθ=0)', () => {
  const r = cross(vec3(2, 0, 0), vec3(-3, 0, 0));
  // 不用 deepEqual:浮点乘法可能产出 -0(如 2 * -3 * 0 路径),
  // 而 deepStrictEqual 认为 -0 !== +0。教学点:比较浮点永远用 |a-b| < ε。
  assert.ok(Math.abs(r.x) < 1e-12 && Math.abs(r.y) < 1e-12 && Math.abs(r.z) < 1e-12);
});

test('cross: 垂直于两个输入向量', () => {
  const a = vec3(1, 2, 3);
  const b = vec3(4, 5, -6);
  const n = cross(a, b);
  assert.equal(dot(n, a), 0);
  assert.equal(dot(n, b), 0);
});

test('normalize: 结果长度为 1;零向量返回零向量', () => {
  const n = normalize(vec3(3, 4, 0));
  assert.ok(Math.abs(length(n) - 1) < 1e-12);
  const z = normalize(vec3(0, 0, 0));
  assert.deepEqual([z.x, z.y, z.z], [0, 0, 0]);
});

test('add / sub / scale / lerp 基础语义', () => {
  assert.deepEqual([add(X, Y).x, add(X, Y).y], [1, 1]);
  const s = sub(X, Y);
  assert.deepEqual([s.x, s.y], [1, -1]);
  const sc = scale(Y, 2.5);
  assert.equal(sc.y, 2.5);
  const l = lerp(vec3(0, 0, 0), vec3(10, -10, 4), 0.5);
  assert.deepEqual([l.x, l.y, l.z], [5, -5, 2]);
});

test('纯函数性:所有操作不得修改入参', () => {
  const a = vec3(1, 2, 3);
  const snapshot = { ...a };
  add(a, X); sub(a, X); scale(a, 2); normalize(a); lerp(a, X, 0.5); cross(a, X);
  assert.deepEqual(a, snapshot);
});

/**
 * camera 测试 —— 把"极点到底会怎样"这句话从口头说法变成可执行的断言。
 *
 * 这一课最容易以讹传讹的就是极点(很多人叫万向节锁)。所以这里不写评论、
 * 只写测量:横向拖拽在极点多做了什么、少了做什么,clamp 到底挡住了什么,
 * 四元数版又真的改变了什么。demo/m0-gimbal-lock.html 上的每一个读数
 * 都对应下面某一条断言。
 *
 * 三条实测结论(和常见的说法不完全一样,是本文件把它们钉住的):
 *   1. 去掉 clamp 越过极点**不会**让画面"瞬间翻面"。本实现用的是
 *      T·Rx·Ry·T 合成写法,极点处相机基依然正交、依然连续。
 *   2. "瞬间翻面"来自 lookAt 写法:right = normalize(cross(look, worldUp)),
 *      长度 = |cos pitch| 在极点归零。
 *   3. 真正在极点附近坏掉的是**手势的含义**:横向拖拽的公转速率 = |cos p|、
 *      自转速率 = |sin p|,比值 = |tan p| 爆炸 —— 而且 clamp 挡不住它。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrbitCamera, TrackballCamera } from '../src/scene/camera.js';
import { transformPoint, multiply, rotationX, rotationY, rotationZ } from '../src/math/mat4.js';

const D2R = Math.PI / 180;
/** 与 camera.js 里的 SENSITIVITY 一致:横向拖 1 像素 = 0.005 rad。 */
const SENS = 0.005;

const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/**
 * 两个单位向量的夹角(度)。
 *
 * 为什么不用 acos(a·b):矩阵是 Float32Array,点积在 1 附近只有 ~1e-7 的绝对精度,
 * 而 acos 在 1 附近把 1e-7 的噪声放大成 √(2e-7) ≈ 4.5e-4 弧度 —— 比我们
 * 要在极点附近测量的量还大。改用弦长公式 2·asin(|a−b|/2):噪声是线性的
 * (1e-7),而且对 0° 和 180° 两端都稳定。
 */
const angle = (a, b) => {
  const u = unit(a), v = unit(b);
  const chord = Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
  return 2 * Math.asin(Math.min(1, chord / 2)) * 180 / Math.PI;
};
/** 把向量投到屏幕平面(垂直于视轴)上 —— 它的转角就是"画面打滚"。 */
const onScreen = (v, look) => {
  const k = dot3(v, look);
  return unit([v[0] - k * look[0], v[1] - k * look[1], v[2] - k * look[2]]);
};
/** 一次拖拽里"公转"(视点移动)了多少度。 */
const panOf = (b0, b1) => angle(b0.look, b1.look);
/** 一次拖拽里"自转"(画面打滚)了多少度。 */
const rollOf = (b0, b1) => angle(onScreen(b0.up, b0.look), onScreen(b1.up, b1.look));

/** 相机基必须永远是一组正交单位向量 —— 这是"没有数值奇异"的最低要求。 */
function assertOrthonormal(b, msg) {
  const n = (v) => Math.hypot(v[0], v[1], v[2]);
  for (const [name, v] of [['right', b.right], ['up', b.up], ['look', b.look]]) {
    assert.ok(Math.abs(n(v) - 1) < 1e-5, `${msg}:|${name}| = ${n(v)}`);
  }
  assert.ok(Math.abs(dot3(b.right, b.up)) < 1e-5, `${msg}:right ⊥ up`);
  assert.ok(Math.abs(dot3(b.right, b.look)) < 1e-5, `${msg}:right ⊥ look`);
  assert.ok(Math.abs(dot3(b.up, b.look)) < 1e-5, `${msg}:up ⊥ look`);
  for (const v of [b.right, b.up, b.look, b.position]) {
    assert.ok(v.every(Number.isFinite), `${msg}:出现 NaN/Infinity`);
  }
}

/** 同一个手势喂给两台相机,各自做一次。 */
const stroke = (cam, dx, dy) => { const b0 = cam.basis(); cam.drag(dx, dy); return [b0, cam.basis()]; };

test('OrbitCamera:相机站在 target 的 distance 处,target 落在正前方一个 d', () => {
  const cam = new OrbitCamera({ distance: 84, yaw: 0.95, pitch: 0.42, target: [0, 0, -18] });
  const b = cam.basis();
  assert.ok(Math.abs(Math.hypot(b.position[0], b.position[1], b.position[2] - (-18)) - 84) < 1e-3,
    '相机到 target 的距离应当正好等于 distance');

  const v = cam.viewMatrix();
  const self = transformPoint(v, b.position);
  assert.ok(Math.abs(self.x) < 1e-4 && Math.abs(self.y) < 1e-4 && Math.abs(self.z) < 1e-4,
    `相机自己应当被映射到原点,实际 (${self.x}, ${self.y}, ${self.z})`);
  const t = transformPoint(v, cam.target);
  assert.ok(Math.abs(t.x) < 1e-4 && Math.abs(t.y) < 1e-4 && Math.abs(t.z + 84) < 1e-3,
    `target 应当落在正前方一个 distance 处,实际 z = ${t.z}`);
});

test('两台相机可以逐位给出同一个视图矩阵(四元数只是换了 R 的来源)', () => {
  for (const [yaw, pitch] of [[0, 0], [0.6, 0.4], [-2.3, -1.1], [3.0, 1.5]]) {
    const o = new OrbitCamera({ distance: 5, yaw, pitch });
    const t = new TrackballCamera({ distance: 5, yaw, pitch });
    const a = o.viewMatrix(), b = t.viewMatrix();
    for (let i = 0; i < 16; i++) {
      assert.ok(Math.abs(a[i] - b[i]) < 1e-5,
        `yaw=${yaw} pitch=${pitch} 第 ${i} 项:${a[i]} vs ${b[i]}`);
    }
  }
});

test('极点留白是 0.01 度,不是 0.01 弧度 —— 差 57.3 倍', () => {
  // 这条钉的是一个单位陷阱,不是数学。写成弧度会得到 89.427°,
  // 于是"极点附近打滚"这一课的结论从 5730:1 变成 100:1。
  const MARGIN_DEG = 0.01;
  const cam = new OrbitCamera({ distance: 5 });
  assert.ok(Math.abs(cam.maxPitch - (Math.PI / 2 - MARGIN_DEG * D2R)) < 1e-12,
    `默认上限应当是 90°−0.01°,实际 ${(cam.maxPitch / D2R).toFixed(4)}°`);
  assert.ok((Math.PI / 2 - cam.maxPitch) / D2R < 0.011,
    `留白必须只有 0.01°,实际 ${((Math.PI / 2 - cam.maxPitch) / D2R).toFixed(4)}°`);

  // 另一半:构造时也必须夹。否则能造出一台"一入场就越界"的相机 ——
  // 它要等到第一次 drag() 才被悄悄拽回上限,那一下 pitch 突变会混进拖拽
  // 读数里:上限还是 89.427° 的时候,实测把 573:1 污染成了 24:1。
  // 注意输入要真的越界(95°),否则夹不夹都看不出来 —— 这条用例必须
  // 能靠"删掉构造函数里的 _clamp()"变红,已反向验证过。
  const over = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: 95 * D2R });
  assert.ok(over.pitch <= over.maxPitch + 1e-12,
    `构造后 |pitch| 就应当 ≤ maxPitch,实际 ${(over.pitch / D2R).toFixed(3)}°`);
  const pinned = over.pitch;
  const [o0, o1] = stroke(over, 40, 0);
  assert.ok(Math.abs(over.pitch - pinned) < 1e-12,
    `纯横向拖拽不该改变 pitch,实际从 ${(pinned / D2R).toFixed(3)}° 变到 ${(over.pitch / D2R).toFixed(3)}°`);
  const ratioOver = rollOf(o0, o1) / panOf(o0, o1);
  assert.ok(Math.abs(ratioOver / Math.abs(Math.tan(pinned)) - 1) < 0.01,
    `pitch 没被偷改时比值就该是 |tan p| ≈ ${Math.tan(pinned).toFixed(0)},实际 ${ratioOver.toFixed(0)}`);
});

test('clamp:默认停在 89.99°;maxPitch=Infinity 就真的能越过去', () => {
  const clamped = new OrbitCamera({ distance: 5, yaw: 0.7, pitch: 0.5 });
  clamped.drag(0, 400);                       // 使劲往上拖
  assert.ok(Math.abs(clamped.pitch - (Math.PI / 2 - 0.01 * D2R)) < 1e-9,
    `带 clamp 应当停在 89.99°,实际 ${(clamped.pitch / D2R).toFixed(3)}°`);
  assert.ok((clamped.pitch / D2R) > 89.98, '留在 89.99° 才叫"贴着上限"');

  const free = new OrbitCamera({ distance: 5, yaw: 0.7, pitch: 0.5, maxPitch: Infinity });
  free.drag(0, 400);
  assert.ok(free.pitch > Math.PI / 2, `去掉上限后应当越过 90°,实际 ${(free.pitch / D2R).toFixed(2)}°`);
  assertOrthonormal(free.basis(), '越过极点后');
});

test('越过极点不是"瞬间翻面":up 是连续转过去的,只差 0.002°', () => {
  // 这条直接推翻一个常见说法。本实现的相机基由 T·Rx·Ry·T 合成,
  // 公式里没有叉积,所以在极点不会塌缩成 0/0,也就不会有 180° 跳变。
  const at = (deg) => new OrbitCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R, maxPitch: Infinity });
  const uBefore = at(89.999).basis().up;
  const uAfter = at(90.001).basis().up;
  const jump = angle(uBefore, uAfter);
  assert.ok(jump < 0.01, `跨极点时 up 的变化应当极小,实际 ${jump.toFixed(4)}°(若"翻面"应是 180°)`);

  // 但"翻面"这件事本身是真的,只是它连续地分布在 0°→180° 整段上:
  // 90° 时 up 恰好水平,再往前就沉到地平线以下,100° 已经朝下。
  assert.ok(Math.abs(at(90).basis().up[1]) < 1e-6, '极点处 up 的竖直分量应当为 0(恰好水平)');
  assert.ok(at(100).basis().up[1] < 0, '越过极点后 up 应当朝下 —— 世界开始倒过来');
  assert.ok(at(180).basis().up[1] < -0.999, '180° 时完全倒立');
});

test('横向拖拽的两副面孔:公转 = |cos p|,自转 = |sin p|', () => {
  // 这是极点问题的真正来源:横向拖拽绕的是**世界 Y 轴**,
  // 而世界 Y 轴与视轴的夹角随俯仰角变化,于是同一个手势的含义会变。
  for (const deg of [0, 30, 60, 80, 85, 89]) {
    const cam = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R });
    const [b0, b1] = stroke(cam, 40, 0);           // 横向拖 40px = 0.2 rad
    const drag = 40 * SENS * 180 / Math.PI;        // 该手势对应的总转角(度)
    const pan = panOf(b0, b1), roll = rollOf(b0, b1);
    assert.ok(Math.abs(pan - drag * Math.cos(deg * D2R)) < 0.5,
      `p=${deg}° 公转应当 ≈ cos p·拖拽量 ${(drag * Math.cos(deg * D2R)).toFixed(2)}°,实际 ${pan.toFixed(3)}°`);
    assert.ok(Math.abs(roll - drag * Math.sin(deg * D2R)) < 0.5,
      `p=${deg}° 自转应当 ≈ sin p·拖拽量 ${(drag * Math.sin(deg * D2R)).toFixed(2)}°,实际 ${roll.toFixed(3)}°`);
    // 两件事加起来恒等于拖拽量本身(能量守恒的样子):cos² + sin² = 1
    assert.ok(Math.abs(Math.hypot(pan, roll) - drag) < 0.5,
      `p=${deg}° 两个分量应当合成拖拽量 ${drag.toFixed(2)}°,实际 ${Math.hypot(pan, roll).toFixed(3)}°`);
  }

  // 比值 = |tan p|:85° 时 11.4:1,89.9° 时 573:1 —— 手势已经不是原来那个手势了。
  // (注意 89.9° 仍在默认上限 89.99° 之内,所以这里量的是"没被 clamp 动过"的纯退化。)
  const ratio = (deg) => {
    const cam = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R });
    const [b0, b1] = stroke(cam, 40, 0);
    return rollOf(b0, b1) / panOf(b0, b1);
  };
  assert.ok(Math.abs(ratio(45) - 1) < 0.02, '45° 时自转与公转刚好一样多');
  assert.ok(Math.abs(ratio(85) - Math.tan(85 * D2R)) < 0.5, '85° 时应约等于 tan 85° ≈ 11.4');
  assert.ok(ratio(89.9) > 400, `89.9° 时比值应当爆炸,实际 ${ratio(89.9).toFixed(0)}:1`);
  assert.ok(Math.abs(ratio(89.9) - Math.tan(89.9 * D2R)) < 1,
    `89.9° 的比值应当就是 tan 89.9° ≈ 573,实际 ${ratio(89.9).toFixed(1)}`);
});

test('clamp 挡不住"打滚":89.99° 处的手势退化照旧发生', () => {
  // 关键澄清。clamp 只是禁止越过极点,它并不改变世界 Y 轴与视轴的夹角,
  // 所以"横向拖拽退化成打滚"这件事在 clamp 之内一样严重。
  const cam = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: 0 });
  cam.drag(0, 400);                       // 拖到被 clamp 挡住的位置
  assert.ok(Math.abs(cam.pitch - (Math.PI / 2 - 0.01 * D2R)) < 1e-9, '应当已经贴在上限');
  const [b0, b1] = stroke(cam, 40, 0);
  const ratio = rollOf(b0, b1) / panOf(b0, b1);
  assert.ok(ratio > 400, `贴着 clamp 上限时,自转:公转 仍然是 ${ratio.toFixed(0)}:1`);
  // 上限改成 0.01 度之后,这里的退化程度直接顶到 tan 89.99° ≈ 5730。
  // clamp 唯一做到的事是把 pitch 挡在 89.99°,而不是让这个比值变小。
  assert.ok(Math.abs(ratio - Math.tan(cam.pitch)) < 10,
    `贴着上限时比值应当 ≈ tan ${(cam.pitch / D2R).toFixed(2)}° ≈ ${Math.tan(cam.pitch).toFixed(0)},实际 ${ratio.toFixed(0)}`);
});

test('极点处三条线索同源:同一个 |cos p|', () => {
  // ① 公转速率 ② lookAt 写法里 right = normalize(cross(look, worldUp)) 的长度
  // ③ 欧拉雅可比矩阵的行列式。三个地方出现的是同一件事。
  for (const deg of [0, 30, 60, 85, 89.9]) {
    const p = deg * D2R, yaw = 0.95;
    const b = new OrbitCamera({ distance: 5, yaw, pitch: p }).basis();
    const c = Math.abs(Math.cos(p));

    // ① 公转速率:世界 Y 轴上垂直于视轴的那部分 = |Y × look|
    const YxL = unit([
      (1 * b.look[2] - 0 * b.look[1]),
      (0 * b.look[0] - 0 * b.look[2]),
      (0 * b.look[1] - 1 * b.look[0]),
    ]);
    assert.ok(Math.abs(Math.hypot(...[
      (1 * b.look[2] - 0 * b.look[1]), (0 * b.look[0] - 0 * b.look[2]), (0 * b.look[1] - 1 * b.look[0]),
    ]) - c) < 1e-5, `p=${deg}° |Y × look| 应当 = |cos p|`);
    assert.ok(YxL.every(Number.isFinite));

    // ③ 欧拉雅可比:三个角分别绕三根轴(列向量 [0,1,0]、[,0]、[,2] 的叉积结构),
    //    行列式 = −cos p。极点处归零 = 三个角里有一个被"吃掉"了。
    const e1 = [0, 1, 0];
    const e2 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const R = multiply(rotationY(yaw), rotationX(p));
    const col = (m, i) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]];
    const e3 = col(multiply(rotationY(yaw), rotationX(p)), 2);
    const cross = (a, b2) => [a[1] * b2[2] - a[2] * b2[1], a[2] * b2[0] - a[0] * b2[2], a[0] * b2[1] - a[1] * b2[0]];
    const det = dot3(e1, cross(e2, e3));
    assert.ok(Math.abs(Math.abs(det) - c) < 1e-5, `p=${deg}° |det W| 应当 = |cos p|,实际 ${Math.abs(det)}`);
    assert.ok(Math.abs(Math.hypot(...[R[0], R[1], R[2]]) - 1) < 1e-5, '旋转矩阵的列应当是单位向量');
  }
});

test('万向节锁的教科书表述:极点处 yaw 与 roll 塌缩成同一个旋转', () => {
  // R(yaw, pitch, roll) = Ry(yaw)·Rx(pitch)·Rz(roll)。在 pitch = ±90° 时
  // 它会退化成 Ry(yaw ∓ roll)·Rx(±90°) —— 两个角只剩一个组合量,
  // 另一自由度被吃掉。这就是三参数参数化在极点必然发生的降秩。
  const build = (y, p, r) => multiply(rotationY(y), multiply(rotationX(p), rotationZ(r)));

  for (const sign of [1, -1]) {
    const P = sign * Math.PI / 2;
    for (const d of [0.3, -1.1, 2.0]) {
      // 由推导:R 只依赖 (yaw − sign(pitch)·roll)
      const a = build(0.4, P, 0.25);
      const b = build(0.4 + d, P, 0.25 + sign * d);
      for (let i = 0; i < 16; i++) {
        assert.ok(Math.abs(a[i] - b[i]) < 1e-5,
          `pitch=${sign * 90}° 时 (yaw+${d}, roll+${sign * d}) 应当是同一个旋转,第 ${i} 项差 ${Math.abs(a[i] - b[i])}`);
      }
    }
    // 差 1° 就没这个性质了 —— 说明塌缩是极点独有的,不是"近似"
    const near = 89 * D2R * sign;
    const a = build(0.4, near, 0.25);
    const b = build(0.4 + 0.3, near, 0.25 + sign * 0.3);
    let maxDiff = 0;
    for (let i = 0; i < 16; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    assert.ok(maxDiff > 0.001, `89° 处不该有这个塌缩,实际最大差 ${maxDiff}`);
  }
});

test('lookAt 写法才是"瞬间翻面"的出处:极点处 cross(look, worldUp) 归零', () => {
  // 这解释了那句"上方向会翻转、画面瞬间打滚"到底在讲哪一个实现。
  // 这条测的是 lookAt 公式的几何,不是相机自己的 clamp 策略 ——
  // 所以显式把上限放开,好让 pitch 真的走到 90°(默认会被夹在 89.99°)。
  const lenAt = (deg) => {
    const { look } = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R, maxPitch: Infinity }).basis();
    const Y = [0, 1, 0];
    return Math.hypot(...[
      look[1] * Y[2] - look[2] * Y[1],
      look[2] * Y[0] - look[0] * Y[2],
      look[0] * Y[1] - look[1] * Y[0],
    ]);
  };
  assert.ok(Math.abs(lenAt(0) - 1) < 1e-6, '水平看时右向量的原料长度是 1');
  assert.ok(Math.abs(lenAt(60) - 0.5) < 1e-6, '60° 时只剩一半');
  assert.ok(lenAt(90) < 1e-9, '极点处归零 —— 归一化就是 0/0,right 无定义');
});

test('TrackballCamera:横向拖拽永远不打滚,公转增益与俯仰角无关', () => {
  // 修复的核心:旋转轴取"当前相机的 up",而 up 永远垂直于视轴,
  // 所以轴永远落在屏幕平面内 —— 自转恒为 0,公转恒为 1。
  for (const deg of [0, 30, 60, 85, 89, 89.99]) {
    const cam = new TrackballCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R });
    const [b0, b1] = stroke(cam, 40, 0);
    const drag = 40 * SENS * 180 / Math.PI;    // 40px 对应的总转角(度)
    assert.ok(rollOf(b0, b1) < 0.05, `p=${deg}° 自转应当恒为 0,实际 ${rollOf(b0, b1).toFixed(4)}°`);
    assert.ok(Math.abs(panOf(b0, b1) - drag) < 0.5,
      `p=${deg}° 公转应当恒等于拖拽量 ${drag.toFixed(2)}°,实际 ${panOf(b0, b1).toFixed(2)}°`);
    assertOrthonormal(b1, `p=${deg}°`);
  }
});

test('TrackballCamera:没有 clamp,也能连续翻过极点', () => {
  const cam = new TrackballCamera({ distance: 5, yaw: 0.7, pitch: 0.5 });
  const start = cam.basis();
  // 一直往下拖:纯俯仰拖拽,累积转角远超 180°
  let prevUp = start.up;
  for (let i = 0; i < 200; i++) {
    const b0 = cam.basis();
    cam.drag(0, 4);                            // 每帧 4px = 0.02 rad,200 帧 = 4 rad ≈ 229°
    const b1 = cam.basis();
    assert.ok(angle(b0.up, b1.up) < 1.5, `第 ${i} 帧 up 不该跳变`);
    assertOrthonormal(b1, `第 ${i} 帧`);
    prevUp = b1.up;
  }
  assert.ok(prevUp[1] < 0, '翻过去之后 up 应当朝下(世界是倒的,这是不夹 pitch 的代价)');
  // 始终盯着 target:距离不因翻越而改变
  const end = cam.basis();
  assert.ok(Math.abs(Math.hypot(end.position[0], end.position[1], end.position[2]) - 5) < 1e-4,
    '翻过极点后距离仍应等于 distance');
});

test('纯俯仰拖拽时,两台相机走的是同一条轨迹(轴本来就相同)', () => {
  // OrbitCamera 的 pitch 旋转轴 = 相机 right;TrackballCamera 纵向拖的轴也是
  // 当前 right。所以只喂纵向拖拽时,两者必须逐位相同 —— 这正是
  // "同一个手势做对比"的前提:在越过极点这件事上两台相机的输入完全对等,
  // 差别只在于一个夹住、一个不夹。
  const o = new OrbitCamera({ distance: 5, yaw: 0.7, pitch: 0.5, maxPitch: Infinity });
  const t = new TrackballCamera({ distance: 5, yaw: 0.7, pitch: 0.5 });
  for (let i = 0; i < 90; i++) { o.drag(0, 4); t.drag(0, 4); }
  assert.ok((o.pitch / D2R) > 90, `欧拉相机应当越过了极点(${(o.pitch / D2R).toFixed(1)}°)`);
  const a = o.viewMatrix(), b = t.viewMatrix();
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `第 ${i} 项:${a[i]} vs ${b[i]}`);
  }
  assert.ok(t.basis().up[1] < 0, '两台相机此时都应当是倒过来的');
});

test('横向拖拽时两台相机才分道扬镳:同一手势,一个打滚一个不打', () => {
  const deg = 70;
  const o = new OrbitCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R });
  const t = new TrackballCamera({ distance: 5, yaw: 0.95, pitch: deg * D2R });
  const [o0, o1] = stroke(o, 40, 0);
  const [t0, t1] = stroke(t, 40, 0);

  assert.ok(Math.abs(panOf(o0, o1) - panOf(t0, t1)) > 1,
    '同一个横向手势,两台相机的公转量应当明显不同');
  assert.ok(rollOf(o0, o1) > 0.1 * 180 / Math.PI,
    `欧拉相机应当打滚 ${(0.2 * Math.sin(deg * D2R) * 180 / Math.PI).toFixed(2)}°,实际 ${rollOf(o0, o1).toFixed(2)}°`);
  assert.ok(rollOf(t0, t1) < 0.05, '四元数相机不该打滚');
  // 起点相同,所以差异完全来自模型,不是初始状态不同
  assert.ok(angle(o0.up, t0.up) < 0.01, '起始姿态应当一致');
});

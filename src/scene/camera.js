/**
 * 相机 —— 同一个视图矩阵,两种朝向表示
 *
 * 两个类都做同一件事:盯着 target,离它 distance 远。视图矩阵的公式也
 * **一模一样**:
 *
 *     view = T(0,0,-d) · R · T(-target)
 *
 * 唯一的区别是 R 从哪来:
 *   OrbitCamera      R = Rx(pitch)·Ry(yaw)   两个角,绕"世界 Y"和"相机 X"
 *   TrackballCamera  R = toMat4(q)           一个四元数,每次拖拽把增量左乘进去
 *
 * 这个区别就是"极点会不会出问题"的全部原因。两个类各自的注释里写了推导。
 *
 * ── 视图矩阵的推导(两个类共用)─────────────────────────
 *   相机的世界位置 P 可以这样走到目标点 T:
 *     先绕 Y 轴转 -yaw,再绕 X 轴转 -pitch,最后沿 -Z 平移 distance。
 *   相机的视图矩阵 = 相机世界变换的逆。而上面三个基本变换的逆
 *   就是各自换个符号:T(0,0,-d)·Rx(-pitch)·Ry(-yaw) 的逆……
 *   更直接的记法:把"整个世界"反过来转一遍,相机就回到了标准位姿
 *   (原点、看向 -Z)。于是:
 *
 *     view = T(0,0,-d) · R · T(-target)
 *
 *   读法(从右往左作用到顶点上):先把世界平移,让 target 落到原点;
 *   再把世界按朝向的逆转过来;最后推远 d —— 相机在原点看向 -Z。
 *   注意乘法顺序不可换(矩阵乘法不交换),M0 测试会钉死这一点。
 *   最右边的 T(-target) 就是"看着哪个点";M0 只看原点,target 默认 [0,0,0]。
 *
 * 惯性:松手后角速度按帧衰减。
 *   严格做法是解微分方程 dx/dt = -kx,得到指数衰减 exp(-k·dt);
 *   M0 用固定系数 0.94/帧 的简化版,并在注释里标注这个欠账——
 *   M7 性能工程接帧率无关化时一并偿还。
 */

import { multiply, translation, rotationX, rotationY, transformPoint } from '../math/mat4.js';
import {
  conjugate, fromAxisAngle, multiply as quatMultiply, normalize as quatNormalize, toMat4,
} from '../math/quat.js';

/**
 * 拖拽灵敏度:0.005 rad/px。换算一下才直观:拖 360px 转约 103°,
 * 转满一整圈要 2π/0.005 ≈ 1257px —— 大致等于一次横跨屏幕的拖动。
 * 两个相机共用同一个数,这样"同一个手势"才真的是同一个手势。
 */
const SENSITIVITY = 0.005;

/**
 * 极点留白:0.01 **度**(≈1.745e-4 rad),即 pitch 上限 = 90°−0.01° = 89.99°。
 *
 * 写成 0.01 **弧度** 会得到 89.427°,余量放大 57.3 倍 —— 这两个数在
 * "极点附近打滚有多严重"这一课上给出的答案完全不同(比值 5730:1 vs 100:1),
 * 所以单位这件事必须由测试钉住,不能靠读者眼力。见 test/camera.test.js
 * 的「极点留白是 0.01 度」一条。
 */
const POLAR_MARGIN = 0.01 * Math.PI / 180;

/** 从列主序矩阵里取出第 c 列的前三个分量 —— 也就是基向量 right/up/back。 */
const column = (m, c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];

/** 单位化一个三元组。 */
const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/**
 * 把 pointerdown/move/up 与 wheel 绑到 canvas 上。
 * 两个相机"手势 → drag(dx,dy)"和"滚轮 → 距离"这两步完全一样,
 * 不一样的只是 drag() 内部怎么改朝向 —— 所以这里只写一次。
 */
function attachControls(camera, canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    camera._dragging = true;
    camera._lastX = e.clientX;
    camera._lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId); // 拖出画布也能继续收事件
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!camera._dragging) return;
    const dx = e.clientX - camera._lastX;
    const dy = e.clientY - camera._lastY;
    camera._lastX = e.clientX;
    camera._lastY = e.clientY;
    camera.drag(dx, dy);
  });

  canvas.addEventListener('pointerup', () => { camera._dragging = false; });

  // 缩放:距离按指数变化。推导:滚轮的 deltaY 是"步数",
  // 手感上要求"每滚一格,距离乘以固定倍率"(对数均匀),
  // 即 d' = d·e^(k·dy)。线性相减在近距离一动就是纳米级,远距离又没感觉。
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.zoom(Math.exp(e.deltaY * 0.001));
  }, { passive: false });
}

/**
 * 轨道相机(Orbit Camera)—— 朝向由两个角描述。
 *
 *   yaw   绕**世界 Y 轴**的方位角
 *   pitch 俯仰角,默认限制在 ±(90°−ε) 内
 *
 * 它的极点问题不在于"会不会崩",而在于**参数的含义会退化**:
 *   横向拖拽 = 绕世界 Y 轴转。世界 Y 轴相对视轴有多少分量?
 *     Y 与视轴平行的分量 → 只能让画面打滚(自转)
 *     Y 与视轴垂直的分量 → 才是真正的公转(视点移动)
 *   实测(见 test/camera.test.js 与 demo/m0-gimbal-lock.html):
 *     公转速率 = |cos pitch|    自转速率 = |sin pitch|
 *   在赤道(0°)公转最大、自转 0;到极点(90°)公转 0、自转拉满 ——
 *   而且这个比值 = |tan pitch| 会在极点附近爆炸:85° 时 11.4:1,
 *   89.9° 时 573:1。于是"横向拖拽"这个手势在极点附近变成了纯打滚。
 *
 * 注意:这个退化**和 clamp 无关** —— clamp 只挡住"越过极点",
 * 不挡"极点附近打滚"。根治它的是 TrackballCamera(见下面)。
 */
export class OrbitCamera {
  /**
   * @param {object} [opts]
   * @param {number} [opts.distance=3]   初始距离
   * @param {number} [opts.yaw=0.6]      初始方位角(弧度)
   * @param {number} [opts.pitch=0.4]    初始俯仰角(弧度)
   * @param {number[]} [opts.target=[0,0,0]] 注视点(M5 的 flyTo 会动态改它)
   * @param {number} [opts.minDistance=1.2]  最近可缩放距离(随场景尺度调整)
   * @param {number} [opts.maxDistance=20]   最远可缩放距离
   * @param {number} [opts.maxPitch=π/2−0.01°] pitch 上限(≈89.99°)。传 Infinity = 不限制(见 _clamp)
   */
  constructor({ distance = 3, yaw = 0.6, pitch = 0.4, target = [0, 0, 0],
    minDistance = 1.2, maxDistance = 20, maxPitch = Math.PI / 2 - POLAR_MARGIN } = {}) {
    this.distance = distance;
    this.yaw = yaw;
    this.pitch = pitch;
    this.target = target;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;
    this.maxPitch = maxPitch;

    // 构造时也要夹一次:否则能造出一个"已经越界"的相机,而它要等到第一次
    // drag() 才被悄悄拽回上限 —— 那一下 pitch 突变会被算进拖拽读数里,
    // 把"极点附近打滚"的测量污染掉(实测 573:1 会塌成 24:1)。
    // 一句话:|pitch| ≤ maxPitch 是这台相机的不变量,入场时就成立。
    this._clamp();

    // 惯性角速度(弧度/帧)。拖拽时被持续覆写,松手后开始衰减。
    this._vyaw = 0;
    this._vpitch = 0;
    this._dragging = false;
  }

  /** 把交互绑到 canvas 上。M0 直接绑定即可;多视图/多相机时再抽离。 */
  attach(canvas) { attachControls(this, canvas); }

  /**
   * 把一次拖拽(像素)作用到 yaw/pitch 上。
   * 横向拖 —— 绕世界 Y 轴;纵向拖 —— 绕相机自己的 X 轴(pitch)。
   * TrackballCamera.drag 是同一个接口,好让"同一个手势喂给两台相机"成为可能。
   */
  drag(dx, dy) {
    this.yaw += dx * SENSITIVITY;
    this.pitch += dy * SENSITIVITY;
    this._clamp();
    // 记录本帧速度,供松手后的惯性使用
    this._vyaw = dx * SENSITIVITY;
    this._vpitch = dy * SENSITIVITY;
  }

  /** 缩放:乘一个倍率(>1 拉远,<1 拉近),夹在 min/max 之间。 */
  zoom(factor) {
    this.distance = Math.min(this.maxDistance,
      Math.max(this.minDistance, this.distance * factor));
  }

  /**
   * pitch 上限,默认 ±(90°−ε)。
   *
   * 这里要说清一件很容易记错的事(实测过,见 test/camera.test.js):
   *   过极点**不会**让"上方向向量瞬间翻转、画面打滚"。
   *   本实现用的是合成写法 T·Rx·Ry·T,公式里没有叉积,所以相机基
   *   在极点依然正交、依然连续:实测 pitch 从 89.999° 走到 90.001°,
   *   up 只动了 0.002°。画面是**连续**翻过去的 —— 90° 时 up 恰好水平,
   *   再往前它就沉到地平线以下,到 180° 完全倒立。
   *   所以 clamp 的作用不是"防崩",而是保住"北永远在上"这条不变量:
   *   宁可禁止你越过去,也不让画面倒过来。这是产品选择,不是数学必需。
   *
   * 那"瞬间打滚"的说法从哪来?来自 lookAt 写法(three.js 那条路):
   *     right = normalize(cross(look, worldUp))
   * 它的长度恰好等于 |cos pitch|,在极点归零 → 归一化 0/0 →
   * 前后符号相反 → 画面瞬间翻 180°。同一个 cos pitch 换了身衣服。
   *
   * 想把"越过极点"这件事试出来,把 maxPitch 设成 Infinity 即可 ——
   * demo/m0-gimbal-lock.html 的复选框就是这么干的。
   */
  _clamp() {
    this.pitch = Math.min(this.maxPitch, Math.max(-this.maxPitch, this.pitch));
  }

  /** 每帧调用:松手状态下施加惯性衰减。 */
  update() {
    if (this._dragging) return;
    this.yaw += this._vyaw;
    this.pitch += this._vpitch;
    this._clamp();
    // 每帧 ×0.94:约 0.5 秒后速度衰减到 4%,体感"滑一下自然停"。
    // 欠账:帧率越高停得越快,与 dt 无关。M7 偿还。
    this._vyaw *= 0.94;
    this._vpitch *= 0.94;
  }

  /** 世界的相机基向量 + 相机世界坐标,给读数和调试用(不参与渲染)。 */
  basis() {
    const R = multiply(rotationY(-this.yaw), rotationX(-this.pitch));
    const back = column(R, 2);
    const p = transformPoint(R, [0, 0, this.distance]);
    return {
      right: column(R, 0),
      up: column(R, 1),
      look: [-back[0], -back[1], -back[2]],
      position: [p.x + this.target[0], p.y + this.target[1], p.z + this.target[2]],
    };
  }

  /** 视图矩阵 = T(0,0,-d) · R · T(-target),R = Ry(-yaw)·Rx(-pitch),见文件头。 */
  viewMatrix() {
    return multiply(
      translation(0, 0, -this.distance),
      multiply(
        rotationX(this.pitch),
        multiply(rotationY(this.yaw),
          translation(-this.target[0], -this.target[1], -this.target[2]))
      )
    );
  }
}

/**
 * 轨道相机 · 四元数版(Trackball Camera)—— 朝向由一个四元数描述。
 *
 * 和 OrbitCamera 的唯一区别:旋转轴从哪来。
 *   OrbitCamera     横向拖 → 绕**世界 Y 轴**转 dx
 *                   纵向拖 → 绕**世界 X 轴**转 dy
 *   TrackballCamera 横向拖 → 绕**当前 up**   转 dx
 *                   纵向拖 → 绕**当前 right** 转 dy
 * 即:增量旋转是用四元数**左乘**到当前朝向上的(左乘 = 在世界坐标里作用),
 * 而不是"给两个角加数"。视图矩阵形状不变,只是 R 从 toMat4(q) 来。
 *
 * ── 为什么这样就没了极点问题 ────────────────────────────
 *   相机基(right/up/look)永远是一组正交单位向量,所以
 *     right 和 up 永远垂直于 look。
 *   拖拽的旋转轴取的是 right / up,于是它**永远落在屏幕平面内**,
 *   在视轴上的投影恒为 0:
 *     自转速率 ≡ 0(任何俯仰角)
 *     公转速率 ≡ 1(任何俯仰角,不再有 cos pitch 那个因子)
 *   OrbitCamera 里那个 cos pitch 之所以出现,是因为轴取的是**世界 Y**:
 *   世界 Y 与视轴的夹角会随俯仰角变,而相机自己的轴永远跟着相机走 ——
 *   轴跟着相机走,夹角就永远是 90°。
 *
 * ── 代价(诚实记账)─────────────────────────────────
 *   "上"不再被钉在世界 Y 上。翻过极点之后世界就是倒的(和 Google Earth
 *   拖过极点的手感一致)。对地球引擎来说这不总是想要的,所以 OrbitCamera
 *   保留 clamp 依然合理:那是产品选择,不是数学必需。
 */
export class TrackballCamera {
  /**
   * @param {object} [opts] 参数含义与 OrbitCamera 完全一致;
   *   初始 yaw/pitch 只用来算起始朝向,之后不再保留"两个角"这个状态。
   */
  constructor({ distance = 3, yaw = 0.6, pitch = 0.4, target = [0, 0, 0],
    minDistance = 1.2, maxDistance = 20 } = {}) {
    this.distance = distance;
    this.target = target;
    this.minDistance = minDistance;
    this.maxDistance = maxDistance;

    // 朝向 q:相机 → 世界。起始姿态与 OrbitCamera 对齐,这样两台相机
    // 从同一个位姿出发,后续"同一个手势"的对比才是公平的。
    //   OrbitCamera 的 R = Ry(-yaw)·Rx(-pitch);四元数侧同构:
    //   q = qY(-yaw) ⊗ qX(-pitch)
    // (四元数乘法与矩阵乘法同序,test/quat.test.js 里钉了这条恒等式。)
    this.q = quatMultiply(
      fromAxisAngle([0, 1, 0], -yaw),
      fromAxisAngle([1, 0, 0], -pitch)
    );

    this._spinAxis = null;   // 松手后的惯性:绕哪根世界轴
    this._spinSpeed = 0;     // 以及多快(弧度/帧)
    this._dragging = false;
  }

  /** 把交互绑到 canvas 上。接口与 OrbitCamera 一致。 */
  attach(canvas) { attachControls(this, canvas); }

  /**
   * 把一次拖拽(像素)作用到朝向上。
   *
   * 推导:希望"横向拖 = 绕当前的上方向偏航,纵向拖 = 绕当前的右方向俯仰"。
   * 屏幕平面上的一根轴 a = up·(-dx) + right·(-dy)(符号是为了和
   * OrbitCamera 的手感一致:横拖右、世界往左转)。绕 a 转的角度取
   * 拖拽长度 · SENSITIVITY —— 这就是经典的虚拟轨迹球(Shoemake 1988):
   * 一次拖拽 = S³ 上的一段大圆弧,轴永远落在屏幕平面内。
   *
   * 与 OrbitCamera 的差别在这一行就注定了:轴是从**当前**基向量里取的,
   * 而当前基向量永远正交 —— 所以没有任何角度会出现在分母上。
   */
  drag(dx, dy) {
    const b = this.basis();
    const axis = [
      b.up[0] * -dx + b.right[0] * -dy,
      b.up[1] * -dx + b.right[1] * -dy,
      b.up[2] * -dx + b.right[2] * -dy,
    ];
    const angle = SENSITIVITY * Math.hypot(dx, dy);
    if (angle === 0) return;

    // 左乘 = 在世界坐标里转(与 quat.js 的约定一致:增量在左边)。
    this.q = quatNormalize(quatMultiply(fromAxisAngle(axis, angle), this.q));

    // 惯性:记住这根轴和速度,松手后继续绕它减速转。
    // (绕固定的世界轴减速,是各家实现的通行做法,手感可预期。)
    this._spinAxis = unit(axis);
    this._spinSpeed = angle;
  }

  /** 缩放:与 OrbitCamera 完全一样。 */
  zoom(factor) {
    this.distance = Math.min(this.maxDistance,
      Math.max(this.minDistance, this.distance * factor));
  }

  /** 每帧调用:松手后绕最后一次的轴减速旋转。 */
  update() {
    if (this._dragging || !this._spinAxis || this._spinSpeed < 1e-6) return;
    this.q = quatNormalize(
      quatMultiply(fromAxisAngle(this._spinAxis, this._spinSpeed), this.q)
    );
    this._spinSpeed *= 0.94; // 欠账同 OrbitCamera,由 M7 一并偿还
  }

  /** 世界的相机基向量 + 相机世界坐标。字段与 OrbitCamera.basis() 完全一致。 */
  basis() {
    const R = toMat4(this.q);
    const back = column(R, 2);
    const p = transformPoint(R, [0, 0, this.distance]);
    return {
      right: column(R, 0),
      up: column(R, 1),
      look: [-back[0], -back[1], -back[2]],
      position: [p.x + this.target[0], p.y + this.target[1], p.z + this.target[2]],
    };
  }

  /**
   * 视图矩阵 = T(0,0,-d) · R⁻¹ · T(-target),R = toMat4(q) 是相机的世界朝向。
   */
  viewMatrix() {
    return multiply(
      translation(0, 0, -this.distance),
      multiply(
        // 求逆这一步别漏:视图矩阵的推导就是"把整个世界反过来转一遍",
        // 所以用的是相机世界朝向的逆。单位四元数的逆 = 共轭,便宜得很。
        // OrbitCamera 那边看不出"求逆"这件事,是因为 Rx(p)·Ry(y) 正好
        // 就是 [Ry(-y)·Rx(-p)]⁻¹ —— 两个角写进 viewMatrix 时已经把逆做掉了。
        toMat4(conjugate(this.q)),
        translation(-this.target[0], -this.target[1], -this.target[2])
      )
    );
  }
}

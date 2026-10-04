/**
 * 轨道相机(Orbit Camera)
 *
 * 模型:相机永远盯着 target,用三个参数描述自己的位置——
 *   yaw   绕世界 Y 轴的方位角
 *   pitch 俯仰角(限制在 ±90° 内,否则"上方向"会翻转)
 *   distance 到目标的距离
 *
 * 推导:为什么视图矩阵可以拆成三个简单矩阵的乘积?
 *   相机的世界位置 P 可以这样走到目标点 T:
 *     先绕 Y 轴转 -yaw,再绕 X 轴转 -pitch,最后沿 -Z 平移 distance。
 *   相机的视图矩阵 = 相机世界变换的逆。而上面三个基本变换的逆
 *   就是各自换个符号:T(0,0,-d) · Rx(-pitch) · Ry(-yaw) 的逆……
 *   更直接的记法:把"整个世界"反过来转一遍,相机就回到了标准位姿
 *   (原点、看向 -Z)。于是:
 *
 *     view = T(0,0,-d) · Rx(pitch) · Ry(yaw)
 *
 *   读法(从右往左作用到顶点上):先把世界绕 Y 转 yaw,
 *   再绕 X 转 pitch,再推远 d —— 相机在原点看向 -Z。
 *   注意乘法顺序不可换(矩阵乘法不交换),M0 测试会钉死这一点。
 *
 * 惯性:松手后角速度按帧衰减。
 *   严格做法是解微分方程 dx/dt = -kx,得到指数衰减 exp(-k·dt);
 *   M0 用固定系数 0.94/帧 的简化版,并在注释里标注这个欠账——
 *   M7 性能工程接帧率无关化时一并偿还。
 */

import { multiply, translation, rotationX, rotationY } from '../math/mat4.js';

export class OrbitCamera {
  /**
   * @param {object} [opts]
   * @param {number} [opts.distance=3]   初始距离
   * @param {number} [opts.yaw=0.6]      初始方位角(弧度)
   * @param {number} [opts.pitch=0.4]    初始俯仰角(弧度)
   */
  constructor({ distance = 3, yaw = 0.6, pitch = 0.4 } = {}) {
    this.distance = distance;
    this.yaw = yaw;
    this.pitch = pitch;
    this.minDistance = 1.2;
    this.maxDistance = 20;

    // 惯性角速度(弧度/帧)。拖拽时被持续覆写,松手后开始衰减。
    this._vyaw = 0;
    this._vpitch = 0;
    this._dragging = false;
  }

  /** 把交互绑到 canvas 上。M0 直接绑定即可;多视图/多相机时再抽离。 */
  attach(canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      this._lastX = e.clientX;
      this._lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId); // 拖出画布也能继续收事件
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._lastX;
      const dy = e.clientY - this._lastY;
      this._lastX = e.clientX;
      this._lastY = e.clientY;

      // 灵敏度:0.005 rad/px ≈ 拖 360px 转一整圈,手感居中。
      const s = 0.005;
      this.yaw += dx * s;
      this.pitch += dy * s;
      this._clamp();

      // 记录本帧速度,供松手后的惯性使用
      this._vyaw = dx * s;
      this._vpitch = dy * s;
    });

    canvas.addEventListener('pointerup', () => {
      this._dragging = false;
    });

    // 缩放:距离按指数变化。推导:滚轮的 deltaY 是"步数",
    // 手感上要求"每滚一格,距离乘以固定倍率"(对数均匀),
    // 即 d' = d·e^(k·dy)。线性相减在近距离一动就是纳米级,远距离又没感觉。
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance *= Math.exp(e.deltaY * 0.001);
      this.distance = Math.min(this.maxDistance,
        Math.max(this.minDistance, this.distance));
    }, { passive: false });
  }

  /** pitch 限制在 ±(90°-ε)。过极点会让上方向量翻转,画面瞬间打滚。 */
  _clamp() {
    const limit = Math.PI / 2 - 0.01;
    this.pitch = Math.min(limit, Math.max(-limit, this.pitch));
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

  /** 视图矩阵 = T(0,0,-d) · Rx(pitch) · Ry(yaw),见文件头推导。 */
  viewMatrix() {
    return multiply(
      translation(0, 0, -this.distance),
      multiply(rotationX(this.pitch), rotationY(this.yaw))
    );
  }
}

/**
 * quat —— 单位四元数(旋转的第二种表示)
 *
 * 为什么需要它(而不是一直用欧拉角):
 *   欧拉角 (yaw, pitch, roll) 是 SO(3) 的一种**参数化**。
 *   三个角各自能转一整圈,所以参数空间是 S¹×S¹×S¹(三维环面),
 *   它是"平直"的;而"所有三维旋转"构成的 SO(3) 是"弯曲"的
 *   (SO(3) ≅ RP³,一个三维射影空间)。
 *
 *   把一个平直空间连续、可逆、处处不褶皱地铺到弯曲空间上 —— 做不到。
 *   这是拓扑事实,不是实现水平问题:π₁(SO(3)) = Z/2 ≠ Z³。
 *   所以**任何三参数的旋转参数化都存在退化点**,那里参数到旋转的
 *   雅可比矩阵降秩,俗称"丢一个自由度",也就是万向节锁(gimbal lock)。
 *
 *   四元数的绕法是多用一个参数:
 *   4 个分量加一条单位约束 |q| = 1,几何上就是三维球面 S³。
 *   S³ → SO(3) 是**处处满秩**的 2 对 1 覆盖(局部微分同胚)——
 *   除了 q 与 −q 表示同一个旋转之外,没有任何奇异点。
 *
 * 约定(与 Hamilton / three.js / GLM 一致):
 *   q = (x, y, z, w)     ← w 放在**最后**,方便把前三个当向量看
 *   q = w + x·i + y·j + z·k
 *   语义:q 表示"把物体从自身坐标系转到世界坐标系"的旋转。
 *   于是复合旋转写作 q_new = q_delta ⊗ q_old —— 增量在**左边**。
 *   这与本仓库矩阵的约定是同一套东西(列向量右乘 v' = M·v):
 *     toMat4(multiply(dq, q)) = multiply(toMat4(dq), toMat4(q))
 *   test/quat.test.js 用这条恒等式把两套表示钉在一起。
 *
 * 存储:与 vec3 一样用普通对象,不用 Float32Array —— 教学优先;
 * 真要传 GPU 时再拷进 buffer(M5 之前不会遇到)。
 */

/** 造一个四元数。默认 (0,0,0,1) 是单位元 —— 表示"不转"。 */
export function quat(x = 0, y = 0, z = 0, w = 1) {
  return { x, y, z, w };
}

/** 单位四元数:旋转群的单位元,作用在任何向量上都不改变它。 */
export function identity() {
  return quat(0, 0, 0, 1);
}

/**
 * 轴角 → 四元数:绕单位轴 a 转 rad 弧度。
 *
 * 推导:
 *   绕轴 a 转 θ 的四元数是 (cos(θ/2), a·sin(θ/2))。
 *   为什么是**半角**:四元数作用一次是"转一半"这件事的平方根 ——
 *   用 q 左乘再右乘(共轭)相当于转了两次,合起来正好是 θ。
 *   这也顺便解释了双覆盖:q 与 −q 都作用出同一个旋转,
 *   因为它们只差一个整体符号,而"平方根"的正负两支给出同一个平方。
 */
export function fromAxisAngle(axis, rad) {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const h = rad / 2, s = Math.sin(h);
  return quat(axis[0] / n * s, axis[1] / n * s, axis[2] / n * s, Math.cos(h));
}

/**
 * Hamilton 积:q = a ⊗ b。
 *
 * 它为什么长这样(而不是逐分量相乘):
 *   四元数的乘法就是基元 i、j、k 的乘法表展开的结果,而那张表是
 *     i² = j² = k² = ijk = −1,  ij = k, ji = −k(其余轮换同理)
 *   —— 也就是"ijk = −1 决定了它不交换"。旋转不交换(先转 X 再转 Y
 *   ≠ 先转 Y 再转 X),所以表示旋转的东西**必须**不交换,这是它的优点。
 *
 *   展开后 w 分量 = w_a·w_b − a·b(标量积),
 *   (x,y,z) 分量 = w_a·b + w_b·a + a×b(向量叉积)。
 *   下面的四行就是把这三部分写开;记住"标量积 + 叉积"这个结构就够了。
 */
export function multiply(a, b) {
  return quat(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

/** 共轭 = 逆(单位四元数才成立)。几何上就是"反着转回来"。 */
export function conjugate(q) {
  return quat(-q.x, -q.y, -q.z, q.w);
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function length(q) {
  return Math.hypot(q.x, q.y, q.z, q.w);
}

/**
 * 归一化回 |q| = 1。
 * 为什么必须做:每次乘法都有浮点误差,连续乘几千次后 |q| 会漂离 1,
 * 而只有单位四元数才表示"纯旋转"(长度不为 1 会顺带缩放物体)。
 * 这一步代替了欧拉角那边"矩阵正交化"的活,而且便宜得多。
 */
export function normalize(q) {
  const n = length(q) || 1;
  return quat(q.x / n, q.y / n, q.z / n, q.w / n);
}

/**
 * 四元数 → 4×4 矩阵(列主序,与 mat4 的存储约定一致)。
 *
 * 推导:把 |q| = 1 时的旋转矩阵写出来就是下面这些项。
 * 它其实就是罗德里格斯公式的另一种写法,直接背也行 ——
 * 关键是**不需要反三角函数**:没有任何"取巧的支路选择",
 * 所以 q 与 −q 得到逐位相同的矩阵(测试里钉了这条)。
 */
export function toMat4(q) {
  const { x, y, z, w } = normalize(q);
  return new Float32Array([
    // 第 0 列
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    // 第 1 列
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    // 第 2 列
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    // 第 3 列(旋转不带平移,所以最后一列是齐次的单位列)
    0, 0, 0, 1,
  ]);
}

/**
 * 球面线性插值 slerp:S³ 上沿大圆的匀速插值。
 *
 * 与欧拉角线性插值的区别(这就是"修复后效果"的来源):
 *   欧拉角线性插值是在**参数空间**里走直线,那条直线在弯曲的旋转空间里
 *   可能是绕远路的一大圈,甚至会经过奇异点;
 *   slerp 是在旋转空间里沿**最短弧**走,永远不会绕远、不会抽搐。
 *
 * 双覆盖的代价在这里显形:q 与 −q 是同一个旋转,如果两个关键帧的四元数
 * 点积为负,说明它们在 S³ 上是"对面的两点"、却在 SO(3) 上是同一个东西。
 * 这时把其中一个取反,等价地换成短弧 —— 不做这一步,物体会凭空转一大圈。
 */
export function slerp(a, b, t) {
  let d = dot(a, b);
  let target = b;
  if (d < 0) {
    target = quat(-b.x, -b.y, -b.z, -b.w);
    d = -d;
  }
  // 几乎同向:大圆弧退化成点,sin(θ) → 0 会让下面的式子变成 0/0。
  // 这种情况直接线性插值再归一化,误差在浮点精度内(这是标准做法)。
  if (d > 0.9995) {
    return normalize(quat(
      a.x + (target.x - a.x) * t,
      a.y + (target.y - a.y) * t,
      a.z + (target.z - a.z) * t,
      a.w + (target.w - a.w) * t
    ));
  }
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / s;
  const w2 = Math.sin(t * theta) / s;
  return quat(
    a.x * w1 + target.x * w2,
    a.y * w1 + target.y * w2,
    a.z * w1 + target.z * w2,
    a.w * w1 + target.w * w2
  );
}

/**
 * vec3 —— 三维向量
 *
 * 设计决策:用普通对象 {x,y,z} + 纯函数,而不是 Float32Array。
 * 理由:教学项目第一原则是"数学看得见"。分配开销在 M7 性能工程阶段
 * 用 profiler 证明是瓶颈之后,再统一替换为扁平数组(届时 API 不变,只换底层)。
 *
 * 所有函数都是纯函数:不修改入参,返回新对象。
 * 看似浪费,但它让"谁改了谁的值"这类 bug 在本项目中不可能存在。
 */

/** 构造一个三维向量。所有分量缺省为 0。 */
export function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

/** 逐分量相加:a + b。几何意义:从 a 出发沿 b 平移。 */
export function add(a, b) {
  return vec3(a.x + b.x, a.y + b.y, a.z + b.z);
}

/** 逐分量相减:a - b。几何意义:从 b 指向 a 的向量。 */
export function sub(a, b) {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 标量乘:s * a。几何意义:长度缩放 |s| 倍,s 为负时反向。 */
export function scale(a, s) {
  return vec3(a.x * s, a.y * s, a.z * s);
}

/**
 * 点积 a·b = ax*bx + ay*by + az*bz
 *
 * 推导(为什么它等于投影):
 *   设 a、b 夹角为 θ。由余弦定理:
 *     |a - b|² = |a|² + |b|² - 2|a||b|cosθ
 *   展开左边:|a|² + |b|² - 2(a·b)
 *   两式相等,消去 |a|² + |b|² 得:a·b = |a||b|cosθ
 *
 * 两个直接推论(都会在 LOD/剔除中反复用到):
 *   · a·b = 0  ⟺  垂直       —— 判断"面是否正对相机"
 *   · a·a = |a|²             —— 求长度不开平方
 */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * 叉积 a×b
 *
 * 几何意义:结果向量同时垂直于 a 和 b,方向由右手定则确定,
 * 长度 |a×b| = |a||b|sinθ = a、b 张成的平行四边形面积。
 *
 * 推导(分量公式来自 3×3 行列式按第一行展开):
 *   | i  j  k  |
 *   | ax ay az |  =  i(ay*bz - az*by) - j(ax*bz - az*bx) + k(ax*by - ay*bx)
 *   | bx by bz |
 *
 * 性质(测试中逐一验证):
 *   · 反交换:a×b = -(b×a)
 *   · 平行向量为零向量:sinθ = 0
 *   · 右手定则:x̂×ŷ = ẑ —— 这就是"逆时针为正"的数学来源
 *
 * 本项目中的用途:由瓦片四角求法线、构造正交基、求三角形面积。
 */
export function cross(a, b) {
  return vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  );
}

/** 长度 |a| = √(a·a)。 */
export function length(a) {
  return Math.sqrt(dot(a, a));
}

/**
 * 归一化:a / |a|,得到同方向的单位向量。
 * 零向量没有方向,约定返回零向量本身(调用方负责判断,这里不抛异常——
 * 教学项目里,让调用方显式处理比隐藏一个 throw 更能暴露问题)。
 */
export function normalize(a) {
  const len = length(a);
  return len === 0 ? vec3() : scale(a, 1 / len);
}

/** 线性插值:t ∈ [0,1]。t=0 返回 a,t=1 返回 b。 */
export function lerp(a, b, t) {
  return vec3(
    a.x + (b.x - a.x) * t,
    a.y + (b.y - a.y) * t,
    a.z + (b.z - a.z) * t
  );
}

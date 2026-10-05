/**
 * mat4 —— 4×4 矩阵(列主序)
 *
 * 存储约定(重要,全项目唯一约定):
 *   用 Float32Array(16),列主序(column-major),即:
 *     m[col * 4 + row] 对应数学上的第 row 行、第 col 列。
 *
 *   数学记法          内存布局
 *   | m00 m01 m02 m03 |      [ m00, m10, m20, m30,   ← 第 0 列
 *   | m10 m11 m12 m13 |        m01, m11, m21, m31,   ← 第 1 列
 *   | m20 m21 m22 m23 |        m02, m12, m22, m32,   ← 第 2 列
 *   | m30 m31 m32 m33 | ]      m03, m13, m23, m33 ]  ← 第 3 列
 *
 * 为什么列主序:
 *   1. WGSL 的 mat4x4f 在 uniform buffer 里就是按列主序排放,
 *      选它意味着矩阵可以零转换直接 writeBuffer 上传。
 *   2. 与 GLSL/D3D 的主流约定一致,读任何图形学资料都不会别扭。
 *
 * 变换约定:列向量右乘,即 v' = M · v。
 *   "先经过 b 的变换,再经过 a 的变换"写作 multiply(a, b)。
 */

import { vec3 } from './vec3.js';

/** 单位矩阵:主对角线为 1,其余为 0。任何矩阵左乘/右乘它都保持不变。 */
export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/**
 * 矩阵乘法 out = a · b
 *
 * 推导(它为什么是"行乘列"):
 *   矩阵乘法的定义来自线性映射的复合。设 b 先把 v 映到 b·v,
 *   a 再把结果映到 a·(b·v)。把两个映射复合成一个矩阵 M,
 *   要求 M·v = a·(b·v) 对一切 v 成立,唯一解就是:
 *     M 的第 c 列 = a 作用于 b 的第 c 列的结果
 *   即 M[r][c] = Σk a[r][k] · b[k][c]
 *
 * 换成列主序下标:M[c*4+r] = Σk a[k*4+r] · b[c*4+k]
 *
 * 性质:结合 (a·b)·c = a·(b·c),不交换 a·b ≠ b·a。
 * "先旋转后平移"和"先平移后旋转"结果不同——这是新手第一大坑,
 * 测试里用 T·R 与 R·T 各算一遍来钉死这个约定。
 */
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        s += a[k * 4 + r] * b[c * 4 + k];
      }
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/**
 * 平移矩阵:沿 x/y/z 平移。
 * 齐次坐标的整个意义就在这一列:第 3 列 (tx,ty,tz,1) 让"平移"
 * 从"不可能的线性变换"变成"一次矩阵乘法"。
 */
export function translation(tx, ty, tz) {
  const m = identity();
  m[12] = tx; // (row 0, col 3)
  m[13] = ty; // (row 1, col 3)
  m[14] = tz; // (row 2, col 3)
  return m;
}

/**
 * 绕 X 轴旋转 θ(弧度)。右手系:拇指指向 +X,四指方向为正角方向。
 *
 * 推导(所有旋转矩阵都来自同一个 2D 旋转,只是换了作用平面):
 *   绕 X 旋转时,x 分量不变,y、z 在 YZ 平面上做平面旋转。
 *   单位圆上一点 (cosθ, sinθ) 旋转后仍是 (cos(θ+φ), sin(θ+φ)),
 *   展开:cosθcosφ - sinθsinφ, sinθcosφ + cosθsinφ
 *   用矩阵表示这个映射,就是:
 *     y' = y·cosφ - z·sinφ
 *     z' = y·sinφ + z·cosφ
 */
export function rotationX(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[5] = c;  m[9] = -s;  // 第 1 列 (0,c,s,0)
  m[6] = s;  m[10] = c;  // 第 2 列 (0,-s,c,0)
  return m;
}

/** 绕 Y 轴旋转 θ。作用平面是 ZX:z' = z·cosφ + x·sinφ,x' = -z·sinφ + x·cosφ。 */
export function rotationY(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[0] = c;  m[8] = s;    // 第 0 列 (c,0,-s,0)
  m[2] = -s; m[10] = c;   // 第 2 列 (s,0,c,0)
  return m;
}

/** 绕 Z 轴旋转 θ。作用平面是 XY:x' = x·cosφ - y·sinφ,y' = x·sinφ + y·cosφ。 */
export function rotationZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  const m = identity();
  m[0] = c;  m[4] = -s;   // 第 0 列 (c,s,0,0)
  m[1] = s;  m[5] = c;    // 第 1 列 (-s,c,0,0)
  return m;
}

/**
 * 透视投影矩阵(右手系,相机看向 -Z;WebGPU NDC:z ∈ [0,1])
 *
 * 这是 M0 里推导量最大的函数,值得。
 *
 * ── 第一部分:x、y 怎么压到 [-1,1](相似三角形)─────────────
 *   视锥体是过原点的四棱锥。fovY 是竖直张角,近平面高 2·n·tan(fovY/2)。
 *   一个位于深度 z(负值)的点,投到近平面上的高度是 y·(n/-z)。
 *   要让它落到 [-1,1],除以半高 n·tan(fovY/2):
 *     y_ndc = y·(n/-z) / (n·tan) = y / (-z·tan)
 *   于是 y_clip = y / tan,w_clip = -z,除法发生在透视除法里。
 *   令 f = 1/tan(fovY/2),得 y_clip = f·y;x 同理再除以宽高比 aspect。
 *
 * ── 第二部分:z 怎么映到 [0,1](WebGL 与 WebGPU 的分水岭)────
 *   z_ndc 必须只依赖 z_view(不能混入 x,y,否则深度插值会错),
 *   所以设 z_ndc = (A·z + B) / (-z),w_clip = -z。
 *   代入两个边界解出 A、B:
 *     近平面 z = -n 时 z_ndc = 0 :  (-A·n + B)/n = 0  →  B = A·n
 *     远平面 z = -f 时 z_ndc = 1 :  (A·f + B)/f  = 1  →  A + B/f = 1
 *   联立:A(1 + n/f) = 1  →  A = f_far/(n - f_far),B = n·f_far/(n - f_far)
 *   (记号冲突说明:公式里的 f_far 是远平面,前面定义的 f 是 1/tan。)
 *
 *   注意 A 是负的:z_view 越远(越负),z_ndc 越大 → 精度分配不均匀,
 *   近处精度高、远处低。E6(深度精度)要讲的 Z-fighting 和对数深度,
 *   根源就是这个非线性映射。
 *
 * ── 矩阵(列主序,括号内为数学行列号)──────────────────────
 *   | f/aspect 0   0                0              |
 *   | 0        f   0                0              |
 *   | 0        0   f_far/(n-f_far)  n·f_far/(n-f_far) |
 *   | 0        0  -1                0              |
 *   最后一行的 -1 就是 w_clip = -z_view:透视除法的来源。
 *
 * ── 为什么你可能觉得"和印象里的不一样"──────────────────────
 *   上面画的是本仓库的约定:列向量右乘 v' = M · v。
 *   第 i 个输出分量 = M 的第 i 行 · v —— 所以 w 取自最后一行,那里是 -1。
 *
 *   很多教材和 DirectX 用的是相反的习惯:行向量左乘 v' = v · M。
 *   那种写法下,矩阵是上面这个的**转置**,-1 会跑到最后一列:
 *     | f/aspect 0   0   0 |
 *     | 0        f   0   0 |
 *     | 0        0   A  -1 |
 *     | 0        0   B   0 |
 *   两个矩阵算出的结果逐位相同(断言见 test/projection.test.js 不变量 11)。
 *   -1 "换了位置"的原因只有一个:w 是第 4 个输出分量,而
 *   列向量约定下"输出分量"对应矩阵的**行**,行向量约定下对应**列**。
 *
 *   唯一不能做的是:拿行向量去乘**这一版**(忘了转置)。
 *   那样 w_clip 会算成 z·B 而不是 -z,透视除法整个错位。
 */
export function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;          // (0,0)
  m[5] = f;                   // (1,1)
  m[10] = far / (near - far);       // (2,2) = A
  m[11] = -1;                       // (3,2) → w_clip = -z_view
  m[14] = (near * far) / (near - far); // (2,3) = B
  return m;
}

/**
 * 用矩阵变换一个三维点,返回透视除法后的 NDC 坐标。
 *
 * 完整流程:x_clip = M · (x,y,z,1),再除以 w_clip。
 * 这是拾取(射线反投影)和所有"3D 点投到屏幕"需求的原材料。
 * 注意:在相机后方的点 w 为负,除法会把结果翻到错误位置——
 * 拾取实现时必须先检查 w 的符号(M2 会遇到)。
 */
export function transformPoint(m, p) {
  const x = p.x ?? p[0], y = p.y ?? p[1], z = p.z ?? p[2];
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return vec3(cx / cw, cy / cw, cz / cw);
}

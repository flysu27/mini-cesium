/**
 * 球体(椭球特例)网格生成
 *
 * 推导:球面参数化
 *   一个球面是二维曲面,用两个角参数化:
 *     θ = 纬度 ∈ [-π/2, +π/2](从南极到北极)
 *     φ = 经度 ∈ [0, 2π)
 *   半径 r 的球面上,该点的笛卡尔坐标(取 y 轴为极轴):
 *     x = r·cosθ·cosφ
 *     y = r·sinθ
 *     z = r·cosθ·sinφ
 *   检查量纲:θ=0, φ=0 → (r,0,0) 赤道本初子午线;θ=π/2 → (0,r,0) 北极。
 *
 * 法线:球心的球面法线就是 (x,y,z)/r。
 *   单位球(r=1)上"位置 = 法线",这是球体独有的福利,M1 光照直接白嫖。
 *
 * 索引:每圈多生成一列重复顶点(φ=2π 与 φ=0 位置相同),
 *   为的是 UV 能从 0 平滑长到 1,贴图在接缝处不出一条压缩的竖线。
 *   极点处所有经度顶点重合,产生退化三角形(面积为 0,不产出像素),
 *   换来索引逻辑的完全统一——教学项目里,统一比省 8 个顶点值钱。
 */

/**
 * @param {object} opts
 * @param {number} [opts.radius=1]      球半径
 * @param {number} [opts.latBands=32]   纬度分段数(行)
 * @param {number} [opts.lonBands=48]   经度分段数(列)
 * @returns {{positions: Float32Array, normals: Float32Array, indices: Uint32Array}}
 */
export function createSphereGeometry({ radius = 1, latBands = 32, lonBands = 48 } = {}) {
  const positions = [];
  const normals = [];
  const indices = [];

  // i:纬度行 0..latBands(含两端),j:经度列 0..lonBands(含接缝重复列)
  for (let i = 0; i <= latBands; i++) {
    const theta = -Math.PI / 2 + (i / latBands) * Math.PI; // 纬度:南极 → 北极
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    for (let j = 0; j <= lonBands; j++) {
      const phi = (j / lonBands) * Math.PI * 2;
      const x = cosTheta * Math.cos(phi);
      const y = sinTheta;
      const z = cosTheta * Math.sin(phi);

      positions.push(x * radius, y * radius, z * radius);
      normals.push(x, y, z); // 单位球:法线 = 位置
    }
  }

  // 顶点排布:第 i 行第 j 列 = i * (lonBands + 1) + j
  const cols = lonBands + 1;
  for (let i = 0; i < latBands; i++) {
    for (let j = 0; j < lonBands; j++) {
      const a = i * cols + j;         // 当前格左上(纬度低的一侧)
      const b = (i + 1) * cols + j;   // 左下
      const c = i * cols + j + 1;     // 右上
      const d = (i + 1) * cols + j + 1; // 右下

      // 一个格子拆成两个三角形。
      // 顶点顺序决定正面朝向(WebGPU 按顺时针为 front,由 pipeline 的
      // frontFace 控制)。本格子在球外侧看去应为逆时针 → 不在这里纠结,
      // M0 线框渲染不剔除面,M1 上实体时再校正。
      indices.push(a, b, c);
      indices.push(c, b, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

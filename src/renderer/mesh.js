/**
 * 网格几何算法:三角网格 → 唯一边索引(线框用)
 *
 * (GPU 资源上传与封装已移至 engine.js 的 engine.mesh —— 职责边界:
 *  mesh.js 管几何算法,engine.js 管"接线"。)
 *
 * WebGPU 没有 WebGL 的 gl.LINES 全局开关,也没有"自动线框"。
 * 想画线,只有一条正路:把拓扑设为 'line-list',喂一份"边索引"。
 *
 * 推导:如何从三角形索引得到"唯一边"?
 *   三角形 (a,b,c) 有三条边 (a,b) (b,c) (c,a)。
 *   相邻三角形共享边,直接拼会画两遍(浪费一倍带宽)。
 *   解法:给每条无向边一个规范 key —— 两个端点按大小排序后拼接:
 *     edge(a,b) 的 key = min < max
 *   用 Set 去重后,每条几何边只保留一份。
 *   复杂度 O(边数),这是全项目最"算法课"的一段代码。
 */

/**
 * 从三角形索引提取唯一无向边。
 * @param {Uint32Array|number[]} triIndices 三角形索引(长度为 3 的倍数)
 * @returns {Uint32Array} 线段端点索引,长度为 2 的倍数,配 'line-list' 使用
 */
export function buildEdgeIndices(triIndices) {
  const seen = new Set();
  const edges = [];

  const pushEdge = (a, b) => {
    // 无向边规范序:小端在前。这样 (a,b) 与 (b,a) 映射到同一个 key。
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(a, b);
  };

  for (let i = 0; i < triIndices.length; i += 3) {
    const a = triIndices[i], b = triIndices[i + 1], c = triIndices[i + 2];
    pushEdge(a, b);
    pushEdge(b, c);
    pushEdge(c, a);
  }

  return new Uint32Array(edges);
}


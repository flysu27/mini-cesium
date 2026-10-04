/**
 * WebGPU 设备初始化 —— 全项目唯一一次"存在性检查"
 *
 * 基调声明:本仓库只适配最新 WebGPU,不写兼容判断、不写回退路径。
 * 下面这一个 if 不是兼容层,而是"失败时的可读报错":
 *   没有它,页面会在后续 API 调用处抛出一堆 undefined 错误,教学价值为零;
 *   有了它,学习者一眼知道该去装最新版 Chrome/Edge,而不是怀疑自己的代码。
 * 除此之外,任何"如果浏览器不支持 X 就退回 Y"的代码都不允许出现。
 */

/**
 * 初始化 WebGPU 三件套:adapter → device → context.configure
 *
 * 概念速记:
 *   adapter  代表一块物理/虚拟 GPU。一台机器可能有多个(独显/核显)。
 *   device   是从 adapter 申请到的"逻辑 GPU",后续一切资源的所有者。
 *            WebGPU 的线程安全、资源隔离都以 device 为边界。
 *   context  canvas 与 device 之间的连接,configure 之后 canvas 才能被渲染。
 *
 * alphaMode 'opaque':地球 demo 不需要画布半透明混合,关掉能省一次合成。
 */
export async function initContext(canvas) {
  if (!navigator.gpu) {
    throw new Error(
      '当前浏览器不支持 WebGPU。请使用最新版 Chrome / Edge 打开本示例。'
    );
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error('无法获取 GPU adapter(常见于被驱动黑名单拦截)。');
  }
  const device = await adapter.requestDevice();

  const context = canvas.getContext('webgpu');
  // getPreferredCanvasFormat():让画布格式跟随显示器(通常 bgra8unorm 或 rgba8unorm),
  // 避免每次Present都做一次格式转换。这是"推荐格式"而非兼容判断。
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  return { device, context, format };
}

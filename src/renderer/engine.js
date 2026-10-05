/**
 * engine.js —— WebGPU 样板配置的"一次性隔离层"
 *
 * 痛点:裸写 WebGPU,画一条线要过十几层配置对象——
 *   createShaderModule → createRenderPipeline(vertex.buffers[].attributes[]
 *   .format / primitive.topology / fragment.targets[].format) → createBuffer
 *   → createBindGroup → createCommandEncoder → beginRenderPass → draw。
 * 这些全是"接线图",不含任何数学,却占了 demo 代码的大头。
 * 心智负担本该花在几何与投影上,而不是接线上。
 *
 * 解法(三条,本文件的宪法):
 *   1. 约定代替配置。顶点属性槽位、uniform 槽位全部固定(见下方约定表),
 *      写一次,永远不用再声明。
 *   2. 默认值覆盖 95% 场景。pipeline() 只必填 shaderCode,其余全有默认。
 *   3. 解释一次,之后当黑盒。本文件是全项目唯一允许出现
 *      createRenderPipeline / createBindGroup / beginRenderPass 的地方,
 *      注释写到"读懂为止";之后所有 demo 直接用,不再回头。
 *      three.js 的作者当年就是这么被逼着写出第一个封装的。
 *
 * 约定表(全项目统一,WGSL 里照抄即可):
 *   @location(0) position : vec3f      顶点位置(必填)
 *   @location(1) normal   : vec3f      顶点法线(可选)
 *   @location(2) uv       : vec2f      纹理坐标(可选)
 *   @group(0) @binding(0) globals      全局常量块(viewProj/cameraPos/time)
 *   @group(0) @binding(1) object       逐物体数据(16×vec4f,按需声明)
 */

import { initContext } from './device.js';
import { buildEdgeIndices } from './mesh.js';

/** 全局常量块。着色器开头 `${GLOBALS_WGSL}` 引入即可读 globals.viewProj。 */
export const GLOBALS_WGSL = /* wgsl */ `
  struct Globals {
    viewProj  : mat4x4f,   // 投影 × 视图,列主序,与 JS 端 Float32Array 零转换对齐
    cameraPos : vec4f,     // xyz = 相机世界坐标,w 保留
    time      : vec4f,     // x = 秒;yzw 保留
  };
  @group(0) @binding(0) var<uniform> globals : Globals;
`;

/** 逐物体数据块。需要 per-draw 数据(颜色/模型矩阵)时引入,引擎自动建缓冲。 */
export const OBJECT_WGSL = /* wgsl */ `
  struct ObjectData {
    // 用"vec4 数组"而不是具体结构体:各 demo 的 per-object 数据形状不同,
    // 数组方案让引擎端无需知道语义,只要按 vec4 对齐写入即可(16×vec4 = 256B)。
    data : array<vec4f, 16>,
  };
  @group(0) @binding(1) var<uniform> object : ObjectData;
`;

// 顶点属性约定表:key 对应几何对象里的字段名,value 决定 GPUVertexBufferLayout。
// 每个属性独占一个顶点缓冲(不做交错存储):布局推导是平凡的一行,教学上先赢。
const ATTRIBUTES = {
  positions: { location: 0, format: 'float32x3' },
  normals:   { location: 1, format: 'float32x3' },
  uvs:       { location: 2, format: 'float32x2' },
};
const FORMAT_SIZE = { float32x3: 12, float32x2: 8 };

/**
 * 创建引擎:初始化 device/context,返回只含三个方法的门面对象。
 * @param {HTMLCanvasElement} canvas
 * @param {object} [opts] clearColor:清屏色(线性 0-1 RGB)。投影参数不在此处理,
 *   perspective() 是数学,属于 demo 的教学主体。
 */
export async function createEngine(canvas, { clearColor = [0.043, 0.055, 0.078] } = {}) {
  const { device, context, format } = await initContext(canvas);

  // 全局 uniform 缓冲:96B(= Globals 结构),staging 数组常驻,每帧整块覆写
  const globalsBuffer = device.createBuffer({
    size: 96,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const globalsData = new Float32Array(24); // 16(viewProj) + 4(cameraPos) + 4(time)

  let useDepth = false; // 一旦有 pipeline 申请深度测试,渲染 pass 挂上 depth attachment
  let depthTexture = null;

  // 深度缓冲尺寸跟随画布;resize 后重建(内容无所谓,每帧本来就从 1.0 清起)
  function ensureDepth() {
    if (depthTexture && depthTexture.width === canvas.width
      && depthTexture.height === canvas.height) return depthTexture;
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth24plus',
      // 注意:纹理用法在 GPUTextureUsage 里,与缓冲的 GPUBufferUsage 是两套枚举。
      // 写成 GPUBufferUsage.RENDER_ATTACHMENT 会得到 undefined,报"Required member is undefined"。
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return depthTexture;
  }

  const engine = {
    device,
    format,

    /**
     * 声明渲染管线。此时只记录参数,真正的 GPU 管线在第一次 draw 时惰性组装
     * (这样 pipeline() 可以是同步的,demo 的初始化代码不用 await)。
     *
     * @param {string}   opts.shaderCode   WGSL 源码
     * @param {string}   [opts.topology]   'triangle-list'(默认)| 'line-list' | ...
     * @param {string[]} [opts.attributes] 着色器消费哪些顶点属性,默认 ['positions']
     * @param {boolean}  [opts.objectUniform] 着色器引入了 OBJECT_WGSL(binding 1)时为 true
     * @param {boolean}  [opts.depth]      需要深度测试(M1 起的实体渲染)时为 true
     * @param {boolean}  [opts.depthWrite=true] 深度测试通过时是否写深度。半透明的面设 false
     * @param {boolean}  [opts.depthBias]  共面时把自己往后推一点(面 + 轮廓线的标准组合)
     * @param {boolean}  [opts.blend]      半透明混合(alpha 覆盖)。颜色 uniform 的第 4 位当 alpha
     */
    pipeline({ shaderCode, topology = 'triangle-list', attributes = ['positions'],
      objectUniform = false, depth = false, depthWrite = true, depthBias = false,
      blend = false }) {
      if (depth) useDepth = true;
      return { shaderCode, topology, attributes, objectUniform, depth,
        depthWrite, depthBias, blend, _res: new Map() };
    },

    /** 上传网格。attributes 约定表之外的几何字段直接忽略——每多传一字节都是显存。 */
    mesh(geometry, { wireframe = false } = {}) {
      const buffers = {};
      let vertexCount = 0;

      for (const key of Object.keys(ATTRIBUTES)) {
        const data = geometry[key];
        if (!data) continue;
        const buf = device.createBuffer({
          size: data.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buf, 0, data);
        buffers[key] = buf;
        if (key === 'positions') vertexCount = data.length / 3;
      }

      const indexBuffer = device.createBuffer({
        size: geometry.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(indexBuffer, 0, geometry.indices);

      let edgeIndexBuffer = null;
      let edgeCount = 0;
      if (wireframe) {
        // 三角形索引 → 唯一边索引,推导见 mesh.js(全项目最"算法课"的一段)
        const edges = buildEdgeIndices(geometry.indices);
        edgeCount = edges.length;
        edgeIndexBuffer = device.createBuffer({
          size: edges.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(edgeIndexBuffer, 0, edges);
      }

      return { buffers, vertexCount, indexBuffer, edgeIndexBuffer,
        indexCount: geometry.indices.length, edgeCount };
    },

    /**
     * 提交一次绘制(必须在 engine.frame 的回调内调用)。
     * GPU 管线 / uniform 缓冲 / 绑定组全部在这里惰性创建并缓存——
     * 裸 WebGPU 的十层配置只在这一处出现,demo 永远看不到。
     *
     * @param {object} pipeline  engine.pipeline() 的返回值
     * @param {object} mesh      engine.mesh() 的返回值
     * @param {object} [opts]
     * @param {Float32Array} [opts.uniform]  逐物体数据(vec4 的倍数,≤16 组)
     * @param {boolean} [opts.wireframe]     true 时改画边索引(line-list 配套)
     * @param {number}  [opts.key=0]         同一 pipeline 需要多份独立 uniform 时区分用
     */
    draw(pipeline, mesh, { uniform = null, wireframe = false, key = 0 } = {}) {
      let res = pipeline._res.get(key);
      if (!res) {
        // 1) 组装真正的 RenderPipeline——demo 里看不到的十层配置全在这几行
        const buffers = pipeline.attributes.map((attrName) => {
          const attr = ATTRIBUTES[attrName];
          return {
            arrayStride: FORMAT_SIZE[attr.format],
            attributes: [{ shaderLocation: attr.location, offset: 0, format: attr.format }],
          };
        });
        const module = device.createShaderModule({ code: pipeline.shaderCode });
        // WGSL 编译错误可读化:默认只有控制台一条干巴巴的 device error,
        // 这里主动取编译信息,把行号/列号/原文行打出来,初学者能直接定位。
        module.getCompilationInfo().then((info) => {
          for (const m of info.messages) {
            if (m.type === 'error') {
              console.error(
                `WGSL 编译错误(第 ${m.lineNum} 行第 ${m.linePos} 列):${m.message}\n` +
                pipeline.shaderCode.split('\n')[m.lineNum - 1]);
            }
          }
        });
        const gpuPipeline = device.createRenderPipeline({
          layout: 'auto', // 由 shader 的 @group/@binding 自动推导绑定布局
          vertex: { module, entryPoint: 'vs', buffers },
          fragment: {
            module, entryPoint: 'fs',
            // 必须与画布格式一致,否则 validate 报错。
            // blend:标准的 alpha 覆盖 —— out = src·srcA + dst·(1−srcA)。
            // 只要一个布尔,不用手写 BlendComponent 那一坨;需要别的混合模式时再加枚举。
            targets: [pipeline.blend
              ? {
                format,
                blend: {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
              }
              : { format }],
          },
          primitive: { topology: pipeline.topology, cullMode: 'none' },
          ...(pipeline.depth && {
            depthStencil: {
              format: 'depth24plus',
              depthWriteEnabled: pipeline.depthWrite,
              depthCompare: 'less',
              // polygon offset。一个面和它自己的轮廓线严格共面,插值深度会互相咬
              // (Z-fighting),表现为轮廓线闪烁。把面整体往后推一点点,线就永远赢。
              // 这是"面 + 描边"组合的标准做法,depthWrite(false) 时尤其需要。
              ...(pipeline.depthBias && { depthBias: 60, depthBiasSlopeScale: 2 }),
            },
          }),
        });

        // 2) 绑定组:binding0 = 全局块(全 pipeline 共享一份 buffer);
        //    binding1 = 逐物体块(按 key 各一份 256B 缓冲)
        const entries = [{ binding: 0, resource: { buffer: globalsBuffer } }];
        let uniformBuffer = null;
        if (pipeline.objectUniform) {
          uniformBuffer = device.createBuffer({
            size: 256, // 16 × vec4f,见 OBJECT_WGSL
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          entries.push({ binding: 1, resource: { buffer: uniformBuffer } });
        }
        res = {
          gpuPipeline, uniformBuffer,
          bindGroup: device.createBindGroup({
            layout: gpuPipeline.getBindGroupLayout(0), entries,
          }),
        };
        pipeline._res.set(key, res);
      }

      // 逐物体 uniform:每帧覆写(writeBuffer 排在本帧 submit 之前,顺序天然正确)
      if (uniform && res.uniformBuffer) {
        device.queue.writeBuffer(res.uniformBuffer, 0, uniform);
      }

      const pass = engine._pass;
      pass.setPipeline(res.gpuPipeline);
      pass.setBindGroup(0, res.bindGroup);
      for (let slot = 0; slot < pipeline.attributes.length; slot++) {
        pass.setVertexBuffer(slot, mesh.buffers[pipeline.attributes[slot]]);
      }
      if (wireframe && mesh.edgeIndexBuffer) {
        pass.setIndexBuffer(mesh.edgeIndexBuffer, 'uint32');
        pass.drawIndexed(mesh.edgeCount);
      } else {
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexed(mesh.indexCount);
      }
    },

    /**
     * 就地更新网格顶点数据(顶点数必须与首次上传一致)。
     *
     * 为什么需要它:实时变化的几何(投影实验台里的视锥体线框)每帧都在动。
     * 教科书式做法是"数据变了就重建 buffer",但创建/销毁 buffer 是显式 GPU 操作,
     * 每帧重建既慢又会触发浏览器告警。约定:场景的顶点拓扑在生命周期内固定,
     * 改变的只是数值 —— 于是复用同一块显存,只重写内容。
     */
    updateMesh(mesh, geometry) {
      for (const key of Object.keys(mesh.buffers)) {
        const data = geometry[key];
        if (!data) throw new Error(`updateMesh:几何缺少 ${key} 属性`);
        if (data.byteLength !== mesh.buffers[key].size) {
          throw new Error(`updateMesh:${key} 字节数变化(${mesh.buffers[key].size} → `
            + `${data.byteLength})。顶点数必须恒定,请检查几何生成器`);
        }
        device.queue.writeBuffer(mesh.buffers[key], 0, data);
      }
    },

    /**
     * 帧循环。回调里做两件事:更新相机/矩阵,调用 engine.draw()。
     * ctx 的字段都是"写进去就生效"的视图:viewProj.set(mvp) 直接写,
     * 引擎在回调结束后统一上传——回调代码里没有任何 GPU 概念。
     */
    frame(callback) {
      let last = performance.now();
      const start = last;

      const tick = (now) => {
        const dt = (now - last) / 1000;
        last = now;

        // DPR 自适应 resize(分屏拖动不触发 resize 事件,每帧兜底,成本是一次比较)
        const dpr = window.devicePixelRatio || 1;
        // max(1, …):画布被隐藏或容器宽高为 0 时,size [0,0] 的纹理会直接报错。
        // 这不是防御性代码,而是 0 尺寸画布在 DOM 里完全合法。
        const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        // 每帧新建 encoder/pass:Chrome 对短命小对象有回收优化,先求对再求省(M7 再算账)
        const encoder = device.createCommandEncoder();
        const colorAttachment = {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: clearColor[0], g: clearColor[1], b: clearColor[2], a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        };
        const pass = encoder.beginRenderPass(useDepth ? {
          colorAttachments: [colorAttachment],
          depthStencilAttachment: {
            view: ensureDepth().createView(),
            depthClearValue: 1,   // 1 = 最远;深度朝 0 变化,近处遮挡远处
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        } : { colorAttachments: [colorAttachment] });

        // 回调内所有 draw() 都编码进这个 pass;回调结束后统一提交
        engine._pass = pass;
        callback({
          viewProj: globalsData.subarray(0, 16),  // subarray 是视图,写入直达 staging
          cameraPos: globalsData.subarray(16, 20),
          time: (now - start) / 1000,
          dt,
          aspect: canvas.width / canvas.height,
        }, engine);
        engine._pass = null;
        pass.end();

        // globals 在回调后统一上传:writeBuffer 排在 submit 前,本帧数据本帧生效
        device.queue.writeBuffer(globalsBuffer, 0, globalsData);
        device.queue.submit([encoder.finish()]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
  };

  // 活动中的渲染 pass。draw() 只允许在 frame 回调内调用(那时它非空)。
  Object.defineProperty(engine, '_pass', { writable: true, value: null });

  return engine;
}

# mini-cesium

零依赖的手写三维地球引擎。纯 WebGPU + 原生 JavaScript,从椭球数学、瓦片金字塔到四叉树 LOD,全部自己实现。

> Inspired by Cesium。本仓库不是 Cesium 的绑定、封装或教学示例,与 CesiumJS 项目无任何关联。

## 状态

M0(渲染底座)已完成:线框地球 demo 见 `demo/m0-wireframe-globe.html`。功能清单与里程碑见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 零依赖声明

- 运行时依赖:**0**。`src/` 下不 import 任何第三方库。
- 无构建步骤。数学库由 Node 内置测试运行器直接测试,不需要任何测试框架。
- **只适配最新 WebGPU**(Chrome/Edge 等已启用 WebGPU 的浏览器)。不写任何兼容判断与回退路径;不支持的浏览器会得到一条可读报错,而不是白屏。
- demo 使用相对路径 ES Module,需经静态服务器打开(如 `python -m http.server`),file:// 会被浏览器 CORS 拦截——这是浏览器规则,不是项目依赖。

## 目录结构(规划)

```
mini-cesium/
  src/
    math/       向量 / 矩阵 / 四元数
    renderer/   上下文 / 着色器 / 几何
    scene/      椭球 / 瓦片 / 四叉树 / 相机
    terrain/    DEM 采样与地形网格
    entity/     点 / 线 / 标注
  test/         数学库必须有单元测试
  demo/         每个里程碑一个单 HTML demo
  docs/         ROADMAP 与设计笔记
```

## 授权

待定(建议 MIT,发布前确定)。

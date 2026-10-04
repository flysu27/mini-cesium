# mini-cesium

零依赖的手写三维地球引擎。纯 WebGL + 原生 JavaScript,从椭球数学、瓦片金字塔到四叉树 LOD,全部自己实现。

> Inspired by Cesium。本仓库不是 Cesium 的绑定、封装或教学示例,与 CesiumJS 项目无任何关联。

## 状态

设计阶段。功能清单与里程碑见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 零依赖声明

- 运行时依赖:**0**。`src/` 下不 import 任何第三方库。
- 无构建步骤。每个 demo 是一个可直接双击打开的单 HTML 文件。
- 开发期允许使用开发工具(测试运行器、本地服务器),但产物不依赖它们。

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

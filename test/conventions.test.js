/**
 * 约定测试 —— 用静态检查钉死项目红线。
 *
 * 它不验证数学(数学在 vec3/mat4 的测试里),而是验证"规矩没被破坏"。
 * 好处是纯静态、不需要 GPU,可以在 CI 和本地随便跑:
 * 类似"GPU 枚举写错"这类错误只能在真机上运行时才爆,静态检查能提前拦住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 递归列出目录下的文件。 */
function walk(dir, match) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, match));
    else if (match(entry.name)) out.push(p);
  }
  return out;
}

/** 去掉注释,避免把文档里提到的 API 名误判成真实调用。 */
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\/[^\n]*/g, '');

test('零依赖:src 下所有 import 都必须指向相对路径', () => {
  const files = walk(join(ROOT, 'src'), (n) => n.endsWith('.js'));
  assert.ok(files.length > 0, 'src 下应当有源码');
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('.'),
        `${relative(ROOT, file)} 引入了外部模块 ${m[1]}(违背零依赖)`);
    }
  }
});

test('枚举用法:createTexture 只用 GPUTextureUsage,createBuffer 只用 GPUBufferUsage', () => {
  // 这两套枚举不是同义词。写错不会立刻报错,而是得到 undefined,
  // 运行时才爆 "Failed to read the 'usage' property"。所以静态钉住。
  const cases = [
    { call: 'createTexture', allow: 'GPUTextureUsage', forbid: 'GPUBufferUsage' },
    { call: 'createBuffer', allow: 'GPUBufferUsage', forbid: 'GPUTextureUsage' },
  ];
  const files = walk(join(ROOT, 'src'), (n) => n.endsWith('.js'));
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const { call, allow, forbid } of cases) {
      const re = new RegExp(`${call}\\(\\{([\\s\\S]*?)\\n\\s*\\}\\)`, 'g');
      for (const m of code.matchAll(re)) {
        const body = m[1];
        assert.ok(!body.includes(forbid),
          `${relative(ROOT, file)} 的 ${call} 内出现 ${forbid}(应为 ${allow})`);
        if (call === 'createTexture') {
          assert.ok(body.includes(allow),
            `${relative(ROOT, file)} 的 createTexture 缺少 ${allow}`);
        }
      }
    }
  }
});

test('样板隔离:demo 内不出现任何原始 WebGPU 配置调用', () => {
  // 见 ROADMAP §0.2:接线全部住在 src/renderer/engine.js,demo 只写数学与几何。
  const FORBIDDEN = ['createRenderPipeline', 'createBindGroup', 'createCommandEncoder',
    'beginRenderPass', 'createShaderModule', 'createBuffer', 'createTexture'];
  const demos = walk(join(ROOT, 'demo'), (n) => n.endsWith('.html'));
  assert.ok(demos.length > 0, 'demo 目录下应当有示例页面');
  for (const file of demos) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const token of FORBIDDEN) {
      assert.ok(!code.includes(token),
        `${relative(ROOT, file)} 出现 ${token},请把它收进 engine.js`);
    }
  }
});

test('既有测试:demo 内联模块的 JS 语法可解析', () => {
  const demos = walk(join(ROOT, 'demo'), (n) => n.endsWith('.html'));
  for (const file of demos) {
    const html = readFileSync(file, 'utf8');
    const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    assert.ok(m, `${relative(ROOT, file)} 缺少内联模块`);
    // 以 SourceTextModule 之外的宽松方式解析:包一层 async 函数,只查语法
    assert.doesNotThrow(() => new Script(`(async () => {${m[1].replace(/^\s*import[^\n]*\n/gm, '')}})`),
      `${relative(ROOT, file)} 的内联模块语法有误`);
  }
});

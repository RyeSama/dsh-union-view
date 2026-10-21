// 生成器：src/client.js（CJS 片段）→ .dsh-plugin/client.js（bundle 产物，随插件分发）。
//
// 为什么不用 esbuild：本插件的 client half 刻意写成**纯 CJS + React.createElement**，
// 没有 JSX、没有 ESM import、没有第三方依赖 —— 唯一的 `require('react')` 由宿主
// __ModuleLoader__ 的 factory 参数提供。于是"构建"退化成一次文本包裹，零 devDependency、
// 零二进制下载、Windows 上也不会被 esbuild 的 .bin shim 卡住。
//
// 官方 __ModuleLoader__.load 契约：factory 返回 { name, inject, apply }，client 内核
// 挂载时调用 apply(ctx)。'react' 保持 external（经 factory 的 require 参数解析），
// 与宿主渲染器共享同一 React 实例 —— hooks 才能正常工作。
//
// --check：内存生成后与已提交 .dsh-plugin/client.js 逐字节比对，不一致非零退出。
//          手改生成物禁止（改 src/client.js，勿改 .dsh-plugin/client.js）。
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = join(ROOT, 'src', 'client.js')
const OUTPUT = join(ROOT, '.dsh-plugin', 'client.js')
const PLUGIN_ID = 'dsh-union-view'

// 宿主的 loader 用 bare specifier 调用 require；这里显式列出唯一的外部模块，
// 便于构建期自检（出现意外的 require('xxx') 会在下面被拦下）。
const EXTERNALS = new Set(['react'])

/**
 * 把 CJS 片段包成 __ModuleLoader__ 产物。
 * @param {string} body - src/client.js 的正文。
 * @returns {string} 完整 client.js 内容。
 */
function wrap(body) {
  const src = body.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return (
    'window.__ModuleLoader__.load({\n'
    + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
    + '\tfactory: (require) => {\n'
    + '\t\tvar module = { exports: {} };\n'
    + '\t\tvar exports = module.exports;\n'
    + src + '\n'
    + '\t\treturn module.exports;\n'
    + '\t}\n'
    + '});\n'
  )
}

/**
 * 静态自检：只允许 require 白名单里的模块。
 * @param {string} body
 * @returns {string[]} 违规的 specifier 列表。
 */
function auditRequires(body) {
  const bad = []
  const re = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = re.exec(body)) !== null) {
    if (!EXTERNALS.has(m[1])) bad.push(m[1])
  }
  return bad
}

/**
 * 生成（或校验）client.js。
 * @param {{ check?: boolean }} opts
 * @returns {{ ok: boolean, errors?: string[] }}
 */
export function generate({ check = false } = {}) {
  let body
  try {
    body = readFileSync(ENTRY, 'utf8')
  } catch {
    return { ok: false, errors: [ENTRY + ' 不存在'] }
  }
  const bad = auditRequires(body)
  if (bad.length > 0) {
    return { ok: false, errors: ['src/client.js 引用了白名单外的模块：' + bad.join(', ') + '（只允许 ' + [...EXTERNALS].join(', ') + '）'] }
  }
  const code = Buffer.from(wrap(body))

  if (!check) {
    writeFileSync(OUTPUT, code)
    return { ok: true }
  }
  let committed
  try {
    committed = readFileSync(OUTPUT)
  } catch {
    return { ok: false, errors: [OUTPUT + ' 不存在：运行 node scripts/build-client.mjs 生成'] }
  }
  if (Buffer.compare(committed, code) !== 0) {
    return { ok: false, errors: ['client.js 与生成器输出不一致：运行 node scripts/build-client.mjs 重新生成（手改生成物禁止）'] }
  }
  return { ok: true }
}

// CLI 入口（被 import 时不执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const result = generate({ check })
  if (!result.ok) {
    for (const e of result.errors ?? []) console.error('[build-client] ' + e)
    process.exit(1)
  }
  const bytes = statSync(OUTPUT).size
  console.log(check
    ? '[build-client] client.js 新鲜（--check OK，' + bytes + ' 字节）'
    : '[build-client] client.js 已生成（' + bytes + ' 字节）')
}

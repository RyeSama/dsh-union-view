// 把 dsh-union-view 装进 web profile：复制源码 → node_modules junction → 改 package.json。
// 用 Node 读写以保证 UTF-8 无 BOM（PowerShell 的 Set-Content 在中文用户名路径上会把编码搞乱）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HOME = process.env.USERPROFILE
// 脚本自身在 <repo>/scripts/ 下，往上一层就是插件仓库根目录。
const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS = join(HOME, '.dsh', 'plugins')
const DEST = join(PLUGINS, 'dsh-union-view')
const PROFILE = join(HOME, '.dsh', 'profiles', 'web')
const NM = join(PROFILE, 'node_modules')
const LINK = join(NM, 'dsh-union-view')
const PKG = join(PROFILE, 'package.json')
const NAME = 'dsh-union-view'

function log(s) {
  console.log(s)
}

// 1) 复制插件源码到 ~/.dsh/plugins/dsh-union-view（排除 node_modules / .git）
if (existsSync(DEST)) {
  log('清理旧副本 …')
  rmSync(DEST, { recursive: true, force: true })
}
mkdirSync(DEST, { recursive: true })
cpSync(SRC, DEST, {
  recursive: true,
  // node_modules/.git 当然不复制；docs 是仓库里的截图，装进 profile 只会白占空间。
  filter: (src) => !/[\\/](node_modules|\.git|docs)([\\/]|$)/.test(src),
})
log('已复制 → ' + DEST)

// 2) node_modules junction（Windows 目录联接，不需要管理员权限）
//    junction 用 rmdir 摘掉（只删链接、不碰目标）；rmSync 对 junction 偶尔抛 EPERM，
//    报错会让整个脚本 exit 1，第二次跑才恢复 —— 这里两种都试一次，保证幂等。
if (existsSync(LINK)) {
  try {
    execFileSync('cmd', ['/c', 'rmdir', LINK], { stdio: 'inherit' })
  } catch {
    rmSync(LINK, { recursive: true, force: true, maxRetries: 3 })
  }
}
execFileSync('cmd', ['/c', 'mklink', '/J', LINK, DEST], { stdio: 'inherit' })
log('已链接 node_modules\\' + NAME + ' → ' + DEST)

// 3) package.json：dependencies + dsh.profile.bundles
const raw = readFileSync(PKG, 'utf8')
const pkg = JSON.parse(raw)
pkg.dependencies = pkg.dependencies || {}
const spec = 'file:../../plugins/' + NAME
pkg.dependencies[NAME] = spec
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (!bundles.includes(NAME)) bundles.push(NAME)
pkg.dsh.profile.bundles = bundles

writeFileSync(PKG + '.bak-unionview-' + Date.now(), raw, 'utf8')
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
log('已写 package.json：dependencies["' + NAME + '"] = ' + spec + '；bundles 追加 ' + NAME)
log('当前 bundles: ' + bundles.join(', '))

// 清掉测试会话：从 workspace.json 的所有权账本里摘掉 id，再删目录。
// 用法: node scripts/cleanup-test.mjs <sessionId...>
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const REG = join(homedir(), '.dsh', 'storages', 'workspace.json')
const ROOT = join(homedir(), '.dsh', 'sessions')
const ids = process.argv.slice(2)
if (ids.length === 0) { console.error('用法: node scripts/cleanup-test.mjs <sessionId...>'); process.exit(1) }

const raw = readFileSync(REG, 'utf8')
const j = JSON.parse(raw)
let removedReg = 0
for (const ws of Object.values(j.tables.workspaces)) {
  const before = ws.sessionIds.length
  ws.sessionIds = ws.sessionIds.filter((id) => !ids.includes(id))
  removedReg += before - ws.sessionIds.length
}
for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
  const arr = j.global[key]
  if (Array.isArray(arr)) j.global[key] = arr.filter((id) => !ids.includes(id))
}
writeFileSync(REG, JSON.stringify(j, null, 2) + '\n', 'utf8')

let removedDir = 0
for (const id of ids) {
  for (const proj of existsSync(ROOT) ? (await import('node:fs')).readdirSync(ROOT, { withFileTypes: true }) : []) {
    if (!proj.isDirectory()) continue
    const dir = join(ROOT, proj.name, id)
    if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); removedDir += 1 }
  }
}
console.log(`账本移除 ${removedReg} 条，目录删除 ${removedDir} 个`)

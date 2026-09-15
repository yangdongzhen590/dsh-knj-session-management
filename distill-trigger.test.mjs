// distill-trigger.test.mjs
// 「蒸馏后归档 / 蒸馏后删除」是删除前的**安全闸门**：它复制出去的指令必须覆盖**正在被归档/
// 删除的那批会话**。此前它只复制一条固定的"蒸馏近期会话"文案，而归档/删除的对象天然是旧会话，
// 于是闸门给出虚假安全感、那批内容从未被蒸馏就被删掉。这些用例把修复钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDistillTrigger, DISTILL_TRIGGER } from './lib/distill.js'

test('按指定会话生成指令：带上 id 列表 + 提取器第 6 参数 + 忽略时间下限', () => {
  const ids = ['session-aaaa-1111', 'session-bbbb-2222', 'kj-task-cccc']
  const text = buildDistillTrigger(ids)

  for (const id of ids) assert.ok(text.includes(id), `指令应含会话 ${id}`)
  // 第 6 参数：逗号分隔的会话目录名（提取器按目录名做包含匹配）
  assert.ok(text.includes(`"${ids.join(',')}"`), '应以逗号分隔的 id 列表作为第 6 个参数')
  assert.ok(text.includes('1970-01-01T00:00:00Z'), '时间下限必须显式设为 1970（忽略时间下限，避免老会话被 mtime 过滤掉）')
  assert.ok(text.includes('extract-dsh-sessions.cjs'), '应给出提取器的具体调用')
  assert.ok(text.includes('session:'), 'source 应逐会话用 session:<id>')
  assert.ok(text.includes(`共 ${ids.length} 个`), '应写明数量，让用户核对与被删批次一致')
  assert.ok(text.includes('不蒸其它会话'), '应明确限定只蒸这些会话')
})

test('空/非法 id 列表回退到兜底文案，绝不生成带空列表的指令', () => {
  for (const bad of [[], [''], ['   '], [null], [undefined], [123]]) {
    const text = buildDistillTrigger(bad)
    assert.equal(text, DISTILL_TRIGGER, `非法输入 ${JSON.stringify(bad)} 应回退`)
  }
  assert.ok(DISTILL_TRIGGER.includes('wiki-distill'), '兜底文案仍应指向 wiki-distill')
})

test('id 去重并去空白；重复输入不改变结果', () => {
  const text = buildDistillTrigger([' a ', 'a', 'b', 'b'])
  assert.ok(text.includes('"a,b"'), `应去重去空白后拼接：${text.split('\n')[5]}`)
  assert.ok(text.includes('共 2 个'))
})

test('项目过滤是位置参数：给了就填进第 3 槽；没给也要占位（否则参数会前移）', () => {
  const withFilter = buildDistillTrigger(['x'], '--D-workspace-proj--')
  assert.ok(withFilter.includes('"--D-workspace-proj--"'), '给了项目过滤应落在第 3 个位置参数')
  assert.ok(!withFilter.includes('留空＝不按项目过滤'), '给了过滤就不该再提示留空')

  const without = buildDistillTrigger(['x'], null)
  assert.ok(without.includes('"" 1970-01-01T00:00:00Z'), '没给项目过滤必须留一个空串占位，保持后续参数位置不变')
  assert.ok(without.includes('留空＝不按项目过滤'), '应说明留空只是不按项目过滤，按 id 过滤仍然有效')
})

test('两个 twin 的 buildDistillTrigger 函数体必须一致（该仓库靠双份拷贝，容易只改一边）', () => {
  const root = import.meta.dirname
  const extract = (file) => {
    const src = readFileSync(join(root, file), 'utf8')
    const start = src.indexOf('export function buildDistillTrigger')
    assert.ok(start >= 0, `${file} 应有 buildDistillTrigger`)
    const rest = src.slice(start)
    const end = rest.indexOf('\n}\n')
    const body = rest.slice(0, end + 2)
    // 归一化空白后比较：只关心实现是否一致，不关心换行/缩进风格
    return body.replace(/\s+/g, ' ').trim()
  }
  const host = extract('src/distill.ts')
  const client = extract('src/client/distill.ts')
  assert.equal(client, host, 'src/client/distill.ts 的 buildDistillTrigger 必须与 src/distill.ts 逐字一致（浏览器不能 import lib 所以是双份拷贝）')
})

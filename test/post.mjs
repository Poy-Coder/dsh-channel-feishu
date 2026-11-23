/**
 * Markdown → Feishu `post` (rich text) conversion.
 *
 * The answer leaves the card and becomes a native message, so this is what decides
 * whether a code block survives the trip, whether a link stays clickable, and whether
 * a long answer is split instead of rejected by the platform.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { inlineToPostElements, markdownToPost, POST_MAX_CHARS, splitForPost } from '../providers/post.js'

test('a paragraph becomes one block of plain text', () => {
  const post = markdownToPost('一次普通的回答。')
  assert.deepEqual(post.zh_cn.content, [[{ tag: 'text', text: '一次普通的回答。' }]])
})

test('bold, inline code and links become styled elements', () => {
  const elements = inlineToPostElements('这是 **重点** 和 `code` 以及 [链接](https://example.com)')
  assert.deepEqual(elements[1], { tag: 'text', text: '重点', style: ['bold'] })
  assert.deepEqual(elements[3], { tag: 'text', text: 'code', style: ['italic'] })
  assert.deepEqual(elements[5], { tag: 'a', text: '链接', href: 'https://example.com' })
})

test('a fenced code block keeps its lines and drops the fence', () => {
  const post = markdownToPost('说明：\n\n```js\nconst a = 1\nconst b = 2\n```\n\n结束')
  const blocks = post.zh_cn.content
  const codeBlock = blocks.find((block) => block[0].tag === 'code_block')
  assert.equal(codeBlock[0].text, 'const a = 1\nconst b = 2')
  assert.equal(JSON.stringify(blocks).includes('```'), false, '反引号围栏本身不该出现在正文里')
})

test('headings, bullets and ordered items keep their shape', () => {
  const post = markdownToPost('## 小节\n- 第一项\n- 第二项\n1. 步骤一\n2. 步骤二')
  const texts = post.zh_cn.content.map((block) => block[0].text)
  assert.ok(texts.includes('小节'))
  assert.ok(texts.includes('• 第一项'))
  assert.ok(texts.includes('1. 步骤一'))
  assert.equal(texts.includes('## 小节'), false, '标题不保留井号')
})

test('blank lines separate blocks and are trimmed at both ends', () => {
  const post = markdownToPost('\n\n第一段\n\n第二段\n\n')
  const texts = post.zh_cn.content.map((block) => block[0].text)
  assert.deepEqual(texts, ['第一段', '', '第二段'])
})

test('a markdown table degrades to readable lines, header bold', () => {
  const post = markdownToPost('| 之前 | 之后 |\n|---|---|\n| 卡片显示正文 | 卡片只显示进度 |')
  const blocks = post.zh_cn.content
  // 飞书 post 没有表格元素，管道符原样显示会变成一堵墙
  assert.deepEqual(blocks[0], [{ tag: 'text', text: '之前 → 之后', style: ['bold'] }])
  assert.deepEqual(blocks[1], [{ tag: 'text', text: '卡片显示正文 → 卡片只显示进度' }])
  assert.equal(JSON.stringify(blocks).includes('|---'), false, '分隔行不该出现')
})

test('underline emphasis becomes italic', () => {
  const elements = inlineToPostElements('已经生效，_没有表情了_。')
  const italic = elements.find((item) => item.style?.includes('italic'))
  assert.equal(italic.text, '没有表情了')
})

test('a fence inside a table-looking line is still code', () => {
  const post = markdownToPost('```\n| a | b |\n```')
  const code = post.zh_cn.content.find((block) => block[0].tag === 'code_block')
  assert.ok(code, '代码块里的管道符不能被当成表格')
  assert.equal(code[0].text, '| a | b |')
})

test('an empty answer still produces a valid payload', () => {
  const post = markdownToPost('')
  assert.equal(post.zh_cn.content.length, 1)
  assert.equal(post.zh_cn.content[0][0].text, ' ')
})

test('a long answer is split under the message limit', () => {
  const answer = Array.from({ length: 80 }, (_, i) => `第 ${i} 段：${'内容'.repeat(200)}`).join('\n\n')
  assert.ok(answer.length > POST_MAX_CHARS, '样本必须超出上限，否则测不到切分')
  const parts = splitForPost(answer)
  assert.ok(parts.length > 1)
  for (const part of parts) {
    const chars = part.zh_cn.content
      .flat()
      .reduce((sum, item) => sum + String(item.text ?? '').length, 0)
    assert.ok(chars <= POST_MAX_CHARS, `片段超限：${chars}`)
  }
})

test('a short answer is not split', () => {
  const parts = splitForPost('短回答')
  assert.equal(parts.length, 1)
})

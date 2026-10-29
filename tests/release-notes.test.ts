import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReleaseNotes } from '../src/lib/release-notes';

const source = 'https://github.com/dodo23333/cu-chinese-wiki-translations/releases/tag/v1.8.2';
const pr = 'https://github.com/dodo23333/cu-chinese-wiki-translations/pull/1';

test('release Markdown keeps headings, lists, code, authors and exact PR destinations', () => {
  const html = renderReleaseNotes(`## What's Changed\n* feat: 增加 \`pauseQuote\` by @Werewolf-Wu in ${pr}\n* **修复**换行\n\n## New Contributors\n* @dodo23333\n\n**Full Changelog**: https://github.com/dodo23333/cu-chinese-wiki-translations/compare/v1.7.5...v1.8.2`, source);
  assert.match(html, /<h5>What's Changed<\/h5>/);
  assert.match(html, /<ul>\s*<li>/);
  assert.match(html, /<code>pauseQuote<\/code>/);
  assert.match(html, /<strong>修复<\/strong>/);
  assert.match(html, /@Werewolf-Wu/);
  assert.match(html, /href="https:\/\/github.com\/dodo23333\/cu-chinese-wiki-translations\/pull\/1"[^>]*>PR #1<\/a>/);
  assert.match(html, />版本对比<\/a>/);
  assert.match(html, /@dodo23333/);
});

test('authored labels and other repository identities remain unambiguous', () => {
  const html = renderReleaseNotes(`[查看修复](${pr})\nhttps://github.com/other/project/pull/2\nhttps://github.com/other/project/pull/2#discussion\nhttps://example.com/full/path`, source);
  assert.match(html, />查看修复<\/a>/);
  assert.match(html, />other\/project · PR #2<\/a>/);
  assert.match(html, />https:\/\/github.com\/other\/project\/pull\/2#discussion<\/a>/);
  assert.match(html, />https:\/\/example.com\/full\/path<\/a>/);
});

test('raw HTML and executable URL schemes cannot become active markup', () => {
  const html = renderReleaseNotes(`<script>window.injected = true</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29) [data](data:text/html,test) [vb](vbscript:run) [relative](//evil.example) [credentials](https://user:pass@example.com/)\n\n<iframe src="https://example.com"></iframe>\n\n<svg onload=alert(1)>`, source);
  assert.match(html, /&lt;script&gt;window.injected = true&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<(?:script|img|iframe|svg)\b/i);
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /unsafe/);
});

test('images are readable links without remote embeds and tasks stay disabled', () => {
  const html = renderReleaseNotes('![安装截图](https://example.com/demo.png)\n\n- [x] 已修复\n- [ ] 待完成', source);
  assert.match(html, /href="https:\/\/example.com\/demo.png"[^>]*>图片：安装截图<\/a>/);
  assert.doesNotMatch(html, /<img\b/);
  const inputs = html.match(/<input[^>]*>/g) || [];
  assert.equal(inputs.length, 2);
  assert(inputs.every((input) => input.includes('disabled') && input.includes('type="checkbox"')));
});

test('legacy plain text preserves line breaks and missing notes have a fallback', () => {
  const html = renderReleaseNotes('第一行\n第二行\n\n第三段');
  assert.match(html, /第一行<br\s*\/?\s*>第二行/);
  assert.match(html, /<p>第三段<\/p>/);
  assert.match(renderReleaseNotes('  '), /早期版本，更新记录暂缺/);
});

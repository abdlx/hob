import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImagePath, isSafeImageSource, mediaUrl, renderMediaDirectives } from '../src/services/media.ts';

const endpoint = (profile, value) => `/api/hermes/media?${new URLSearchParams({ profile, path: value })}`;

test('MEDIA lines and inline tags become authenticated image URLs', () => {
  assert.equal(renderMediaDirectives('MEDIA:/tmp/shot.png', 'scout'), `![shot.png](${endpoint('scout', '/tmp/shot.png')})`);
  assert.equal(renderMediaDirectives('Here\nMEDIA:/tmp/with space.png\nDone', 'scout'),
    `Here\n![with space.png](${endpoint('scout', '/tmp/with space.png')})\nDone`);
  assert.equal(renderMediaDirectives('Here MEDIA:/tmp/shot.png then.', 'scout'),
    `Here ![shot.png](${endpoint('scout', '/tmp/shot.png')}) then.`);
  assert.equal(renderMediaDirectives('MEDIA:"/tmp/with space.png"', 'scout'), `![with space.png](${endpoint('scout', '/tmp/with space.png')})`);
  assert.equal(renderMediaDirectives('MEDIA:`/tmp/with space.png`', 'scout'), `![with space.png](${endpoint('scout', '/tmp/with space.png')})`);
});

test('@image refs, media links and Markdown local images render, but non-images stay text', () => {
  assert.equal(renderMediaDirectives('@image:/tmp/shot.png', 'scout'), `![Image: shot.png](${endpoint('scout', '/tmp/shot.png')})`);
  assert.equal(renderMediaDirectives('[Image: shot.png](#media:' + encodeURIComponent('/tmp/shot.png') + ')', 'scout'),
    `![Image: shot.png](${endpoint('scout', '/tmp/shot.png')})`);
  assert.equal(renderMediaDirectives('![local](/tmp/shot.png)', 'scout'), `![local](${endpoint('scout', '/tmp/shot.png')})`);
  assert.equal(renderMediaDirectives('MEDIA:/tmp/report.pdf', 'scout'), 'MEDIA:/tmp/report.pdf');
});

test('fenced code examples never become live images', () => {
  const code = '```bash\necho MEDIA:/tmp/shot.png\n```';
  assert.equal(renderMediaDirectives(code, 'scout'), code);
  assert.equal(renderMediaDirectives(`${code}\nMEDIA:/tmp/live.png`, 'scout'),
    `${code}\n![live.png](${endpoint('scout', '/tmp/live.png')})`);
});

test('remote and inline images are left as safe sources', () => {
  assert.equal(renderMediaDirectives('![web](https://example.test/a.png)', 'scout'), '![web](https://example.test/a.png)');
  const data = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(renderMediaDirectives(`![inline](${data})`, 'scout'), `![inline](${data})`);
  assert.equal(isSafeImageSource(data), true);
  assert.equal(isSafeImageSource('javascript:alert(1)'), false);
});

test('media helpers recognize image extensions and build encoded URLs', () => {
  assert.equal(isImagePath('/tmp/a.PNG'), true);
  assert.equal(isImagePath('/tmp/a.svg'), false);
  assert.equal(isImagePath('file:///tmp/a.webp?x=1'), true);
  assert.equal(mediaUrl('/tmp/a b#c.png', 'default'), endpoint('default', '/tmp/a b#c.png'));
});

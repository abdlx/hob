import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatPreview } from '../src/services/chat-preview.ts';

test('directory previews keep five words, readable formatting and short replies', () => {
  assert.equal(chatPreview('## **Your report**\n  is [ready](https://example.com/report) for review today.'), 'Your report is ready for…');
  assert.equal(chatPreview('All done!'), 'All done!');
  assert.equal(chatPreview('![chart](https://example.com/chart.png)\nReady to review.'), 'chart Ready to review.');
  assert.equal(chatPreview('   '), 'No messages yet');
  assert.equal(chatPreview(null), 'Preview unavailable');
});

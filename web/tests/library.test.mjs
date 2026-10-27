import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryKind, librarySize, libraryText } from '../src/services/library.ts';

test('the library groups common file formats and displays actual sizes', () => {
  for (const name of ['photo.JPG', 'image.webp', 'image.avif']) assert.equal(libraryKind(name), 'images');
  assert.equal(libraryKind('report.pdf'), 'documents');
  assert.equal(libraryKind('data.csv'), 'spreadsheets');
  assert.equal(libraryKind('app.tsx'), 'code');
  assert.equal(libraryKind('icon.svg'), 'code');
  assert.equal(libraryKind('archive.zip'), 'other');
  assert.equal(librarySize(0), '0 B'); assert.equal(librarySize(2048), '2.0 KB');
});

test('text previews preserve Unicode and leave binary files for download', () => {
  const content = '# Résumé — مرحبا';
  assert.equal(libraryText({ name: 'notes.md', mimeType: 'text/markdown', size: 30, dataUrl: 'data:text/markdown;base64,' + Buffer.from(content).toString('base64') }), content);
  assert.equal(libraryText({ name: 'report.pdf', mimeType: 'application/pdf', size: 1, dataUrl: 'data:application/pdf;base64,/w==' }), null);
  assert.equal(libraryText({ name: 'invalid.txt', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,/w==' }), null);
});

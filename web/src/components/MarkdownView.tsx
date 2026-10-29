import React from 'react';
import { isSafeImageSource } from '../services/media';
import { ChatImage } from './ChatImage';
import { CopyButton } from './CopyButton';

function inline(text: string, seenImages: Set<string>): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded-md bg-code-soft px-1.5 py-0.5 text-xs md:text-[13px] text-ink border border-hair font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const image = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image && isSafeImageSource(image[2])) {
      const identity = image[2];
      if (seenImages.has(identity)) return null;
      seenImages.add(identity);
      return <ChatImage key={index} src={image[2]} alt={image[1]} />;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-accent hover:underline underline-offset-2">{link[1]}</a>;
    return part;
  });
}

/** React renders text only: agent markdown never becomes executable HTML. */
export function MarkdownView({ content }: { content: string }) {
  const seenImages = new Set<string>();
  const renderInline = (text: string) => inline(text, seenImages);
  const lines = content.replace(/\r/g, '').split('\n');
  const blocks: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const language = line.slice(3);
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      blocks.push(
        <div key={index} className="my-3 min-w-0 overflow-hidden rounded-2xl border border-hair bg-canvas">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-panel px-3 py-1"><span className="truncate font-mono text-[11px] text-muted">{language.trim() || 'Plain text'}</span><CopyButton text={code.join('\n')} label="Copy code" /></div>
          <pre tabIndex={0} aria-label={language.trim() ? `${language.trim()} code` : 'Code block'} className="max-w-full overflow-x-auto p-3.5 text-xs md:text-sm font-mono leading-relaxed text-ink">
            <code>{code.join('\n')}</code>
          </pre>
        </div>
      );
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(
        <Tag key={index} className={`${level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'} font-semibold text-ink mt-4 mb-2`}>
          {renderInline(line.replace(/^#+\s/, ''))}
        </Tag>
      );
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[index])) {
        items.push(<li key={index}>{renderInline(lines[index++].replace(/^\s*([-*+] |\d+\. )/, ''))}</li>);
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={index} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-2 space-y-1 text-code`}>
          {items}
        </Tag>
      );
      continue;
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = (value: string) => value.replace(/^\s*\||\|\s*$/g, '').split('|');
      const headers = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')) rows.push(cells(lines[index++]));
      blocks.push(
        <div key={index} tabIndex={0} role="region" aria-label="Table" className="max-w-full overflow-x-auto rounded-xl border border-hair my-3">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                {headers.map((cell, i) => (
                  <th className="border-b border-edge p-2.5 text-xs md:text-sm font-semibold text-ink bg-panel" key={i}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="border-b border-line p-2.5 text-xs md:text-sm text-code" key={j}>
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    } else if (line.startsWith('>')) {
      blocks.push(
        <blockquote key={index} className="border-l-3 border-accent bg-hover pl-3.5 py-1.5 my-2 text-soft italic rounded-r-lg">
          {renderInline(line.replace(/^>\s?/, ''))}
        </blockquote>
      );
    } else if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push(<hr key={index} className="border-hair my-4" />);
    } else if (line.trim()) {
      blocks.push(<p key={index} className="my-1.5 whitespace-pre-wrap break-words">{renderInline(line)}</p>);
    }
    index++;
  }

  return <article className="hob-markdown-view min-w-0 max-w-full text-[14.5px] leading-[1.7] text-code select-text">{blocks}</article>;
}

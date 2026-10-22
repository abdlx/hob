import React, { useEffect, useState } from 'react';
import { isSafeImageSource } from '../services/media';

function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className="text-xs text-muted">{alt || 'Image'} is unavailable.</span>;
  const image = (
    <img
      src={src}
      alt={alt || 'Attached image'}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="my-2 block max-h-[420px] max-w-full rounded-2xl border border-hair bg-canvas object-contain md:max-h-[520px]"
    />
  );
  return /^data:/i.test(src) ? image : (
    <a href={src} target="_blank" rel="noreferrer" className="inline-block max-w-full" title="Open image">
      {image}
    </a>
  );
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index} className="font-semibold text-ink">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded-md bg-code-soft px-1.5 py-0.5 text-xs md:text-[13px] text-ink border border-hair font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const image = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image && isSafeImageSource(image[2])) return <ChatImage key={index} src={image[2]} alt={image[1]} />;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-accent hover:underline underline-offset-2">{link[1]}</a>;
    return part;
  });
}

/** React renders text only: agent markdown never becomes executable HTML. */
export function MarkdownView({ content }: { content: string }) {
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
        <div key={index} className="my-3">
          {language && <div className="text-xs text-muted mb-1 font-mono">{language}</div>}
          <pre className="overflow-x-auto rounded-[16px] border border-hair bg-canvas p-3.5 text-xs md:text-sm font-mono leading-relaxed text-ink">
            <code>{code.join('\n')}</code>
          </pre>
        </div>
      );
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(
        <Tag key={index} className={`${level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'} font-semibold text-ink mt-4 mb-2`}>
          {inline(line.replace(/^#+\s/, ''))}
        </Tag>
      );
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[index])) {
        items.push(<li key={index}>{inline(lines[index++].replace(/^\s*([-*+] |\d+\. )/, ''))}</li>);
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
        <div key={index} className="overflow-x-auto my-3">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                {headers.map((cell, i) => (
                  <th className="border-b border-edge p-2.5 text-xs md:text-sm font-semibold text-ink bg-panel" key={i}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="border-b border-line p-2.5 text-xs md:text-sm text-code" key={j}>
                      {inline(cell)}
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
          {inline(line.replace(/^>\s?/, ''))}
        </blockquote>
      );
    } else if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push(<hr key={index} className="border-hair my-4" />);
    } else if (line.trim()) {
      blocks.push(<p key={index} className="my-1.5 whitespace-pre-wrap break-words">{inline(line)}</p>);
    }
    index++;
  }

  return <article className="text-[14.5px] leading-relaxed text-code select-text">{blocks}</article>;
}

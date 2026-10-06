import React from 'react';

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index} className="font-semibold text-[#e5e2dc]">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded bg-[#202020] px-1 text-[#c9ab86]">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-[#c9ab86] underline">{link[1]}</a>;
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
      blocks.push(<div key={index} className="my-3"><div className="text-[10px] text-[#77736e] mb-1">{language}</div><pre className="overflow-x-auto rounded-xl border border-[#252525] bg-[#0b0b0b] p-3 text-[11px]"><code>{code.join('\n')}</code></pre></div>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(<Tag key={index} className={`${level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm'} font-semibold text-[#e5e2dc] mt-4 mb-2`}>{inline(line.replace(/^#+\s/, ''))}</Tag>);
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[index])) items.push(<li key={index}>{inline(lines[index++].replace(/^\s*([-*+] |\d+\. )/, ''))}</li>);
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={index} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-2 space-y-1`}>{items}</Tag>);
      continue;
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = (value: string) => value.replace(/^\s*\||\|\s*$/g, '').split('|');
      const headers = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')) rows.push(cells(lines[index++]));
      blocks.push(<div key={index} className="overflow-x-auto my-3"><table className="w-full text-left"><thead><tr>{headers.map((cell, i) => <th className="border-b border-[#333] p-2" key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className="border-b border-[#222] p-2" key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    } else if (line.startsWith('>')) {
      blocks.push(<blockquote key={index} className="border-l-2 border-[#796046] pl-3 my-2 text-[#99948d]">{inline(line.replace(/^>\s?/, ''))}</blockquote>);
    } else if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push(<hr key={index} className="border-[#252525] my-4" />);
    } else if (line.trim()) {
      blocks.push(<p key={index} className="my-2 whitespace-pre-wrap break-words">{inline(line)}</p>);
    }
    index++;
  }
  return <article className="text-[12px] leading-relaxed text-[#bcb7af] select-text">{blocks}</article>;
}

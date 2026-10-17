import React from 'react';

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index} className="font-semibold text-[#f8ede3]">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded-md bg-[#231c15] px-1.5 py-0.5 text-xs md:text-[13px] text-[#e8c79c] border border-[#3d2e1f] font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-[#ff965c] hover:underline underline-offset-2">{link[1]}</a>;
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
      blocks.push(<div key={index} className="my-3.5"><div className="text-xs text-[#8d8070] mb-1 font-mono">{language}</div><pre className="overflow-x-auto rounded-2xl border border-[#2e251d] bg-[#0c0a08] p-3.5 text-xs md:text-sm font-mono leading-relaxed text-[#dcd2c4]"><code>{code.join('\n')}</code></pre></div>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(<Tag key={index} className={`${level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'} font-semibold text-[#f4eee4] mt-5 mb-2.5`}>{inline(line.replace(/^#+\s/, ''))}</Tag>);
    } else if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[index])) items.push(<li key={index}>{inline(lines[index++].replace(/^\s*([-*+] |\d+\. )/, ''))}</li>);
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={index} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-2.5 space-y-1 text-[#d8cfc2]`}>{items}</Tag>);
      continue;
    } else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = (value: string) => value.replace(/^\s*\||\|\s*$/g, '').split('|');
      const headers = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|')) rows.push(cells(lines[index++]));
      blocks.push(<div key={index} className="overflow-x-auto my-3.5"><table className="w-full text-left"><thead><tr>{headers.map((cell, i) => <th className="border-b border-[#3b3025] p-2.5 text-xs md:text-sm font-semibold text-[#eee4d5]" key={i}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td className="border-b border-[#282017] p-2.5 text-xs md:text-sm text-[#d4c8b8]" key={j}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    } else if (line.startsWith('>')) {
      blocks.push(<blockquote key={index} className="border-l-2 border-[#ff965c] pl-3.5 my-2.5 text-[#b0a494] italic">{inline(line.replace(/^>\s?/, ''))}</blockquote>);
    } else if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push(<hr key={index} className="border-[#2b241c] my-5" />);
    } else if (line.trim()) {
      blocks.push(<p key={index} className="my-2 whitespace-pre-wrap break-words">{inline(line)}</p>);
    }
    index++;
  }
  return <article className="text-sm md:text-[15px] leading-relaxed text-[#ded4c6] select-text">{blocks}</article>;
}

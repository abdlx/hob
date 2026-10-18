import React from 'react';

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**')) return <strong key={index} className="font-semibold text-[#17191D]">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`')) return <code key={index} className="rounded-md bg-[#E8EDF4] px-1.5 py-0.5 text-xs md:text-[13px] text-[#17191D] border border-[rgba(25,35,50,0.08)] font-mono">{part.slice(1, -1)}</code>;
    if (part.startsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-[#1677FF] hover:underline underline-offset-2">{link[1]}</a>;
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
          {language && <div className="text-xs text-[#687588] mb-1 font-mono">{language}</div>}
          <pre className="overflow-x-auto rounded-[16px] border border-[rgba(25,35,50,0.08)] bg-[#FAFAFA] p-3.5 text-xs md:text-sm font-mono leading-relaxed text-[#17191D]">
            <code>{code.join('\n')}</code>
          </pre>
        </div>
      );
    } else if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      const Tag = `h${level}` as 'h1';
      blocks.push(
        <Tag key={index} className={`${level === 1 ? 'text-xl' : level === 2 ? 'text-lg' : 'text-base'} font-semibold text-[#17191D] mt-4 mb-2`}>
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
        <Tag key={index} className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-2 space-y-1 text-[#253041]`}>
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
                  <th className="border-b border-[rgba(25,35,50,0.1)] p-2.5 text-xs md:text-sm font-semibold text-[#17191D] bg-[#F7F8FA]" key={i}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td className="border-b border-[rgba(25,35,50,0.06)] p-2.5 text-xs md:text-sm text-[#253041]" key={j}>
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
        <blockquote key={index} className="border-l-3 border-[#1677FF] bg-[#F4F7FC] pl-3.5 py-1.5 my-2 text-[#556070] italic rounded-r-lg">
          {inline(line.replace(/^>\s?/, ''))}
        </blockquote>
      );
    } else if (/^([-*_])\1{2,}$/.test(line.trim())) {
      blocks.push(<hr key={index} className="border-[rgba(25,35,50,0.08)] my-4" />);
    } else if (line.trim()) {
      blocks.push(<p key={index} className="my-1.5 whitespace-pre-wrap break-words">{inline(line)}</p>);
    }
    index++;
  }

  return <article className="text-[14.5px] leading-relaxed text-[#253041] select-text">{blocks}</article>;
}

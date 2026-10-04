import React from 'react';
import type { ChatMessage } from '../types/chat';

interface ChatMessageItemProps {
  message: ChatMessage;
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({ message }) => {
  const isUser = message.role === 'user';

  // Helper for inline markdown: **bold** and `code`
  const renderInlineStyles = (line: string) => {
    const parts = [];
    let key = 0;
    const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(line.substring(lastIndex, match.index));
      }
      const token = match[0];
      if (token.startsWith('**') && token.endsWith('**')) {
        parts.push(
          <strong key={key++} className="font-semibold text-white">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code
            key={key++}
            className="px-1.5 py-0.5 text-[10px] bg-[#2b2a27] text-amber-200 rounded border border-[#3a3935] font-mono"
          >
            {token.slice(1, -1)}
          </code>
        );
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < line.length) {
      parts.push(line.substring(lastIndex));
    }

    return parts.length > 0 ? parts : line;
  };

  const renderContent = (content: string) => {
    const paragraphs = content.split('\n\n');

    return (
      <div className="space-y-1.5">
        {paragraphs.map((para, pIdx) => {
          const lines = para.split('\n');

          return (
            <div key={pIdx} className="space-y-0.5">
              {lines.map((line, lIdx) => {
                const trimmed = line.trim();
                const isBullet = trimmed.startsWith('•') || trimmed.startsWith('- ');
                const cleanText = isBullet ? trimmed.replace(/^[•-]\s*/, '') : line;

                if (isBullet) {
                  return (
                    <div key={lIdx} className="flex items-start text-[12px] leading-[1.38]">
                      <span className="text-[#888682] mr-1.5 select-none font-bold text-[9px] mt-[3px]">•</span>
                      <span className="text-[#dedcd8]">{renderInlineStyles(cleanText)}</span>
                    </div>
                  );
                }

                return (
                  <p key={lIdx} className="text-[12px] leading-[1.38] text-[#dedcd8]">
                    {renderInlineStyles(line)}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  if (isUser) {
    return (
      <div className="flex justify-end mb-2.5 mt-0.5 w-full">
        <div
          className="max-w-[85%] rounded-full text-[12px] text-white select-text shadow-xs leading-normal font-normal tracking-normal px-3 py-1.5"
          style={{
            backgroundColor: '#936f4d',
            border: '1px solid rgba(168, 130, 94, 0.35)',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-2.5 mt-0.5 w-full">
      <div className="max-w-[88%] bg-[#121212] border border-[#202020] rounded-[16px] px-3.5 py-2.5 shadow-xs select-text">
        {renderContent(message.content)}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-3 ml-1 bg-neutral-400 animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
};

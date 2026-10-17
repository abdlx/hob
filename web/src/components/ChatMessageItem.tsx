import React from 'react';
import type { ChatMessage } from '../types/chat';
import { displayGatewayNotice } from '../services/errors';

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
          <strong key={key++} className="font-semibold text-[#fffdfa]">
            {token.slice(2, -2)}
          </strong>
        );
      } else if (token.startsWith('`') && token.endsWith('`')) {
        parts.push(
          <code
            key={key++}
            className="px-2 py-0.5 text-xs md:text-[13px] bg-[#271f18] text-amber-200 rounded-md border border-[#3e3124] font-mono"
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
      <div className="space-y-2">
        {paragraphs.map((para, pIdx) => {
          const lines = para.split('\n');

          return (
            <div key={pIdx} className="space-y-1">
              {lines.map((line, lIdx) => {
                const trimmed = line.trim();
                const isBullet = trimmed.startsWith('•') || trimmed.startsWith('- ');
                const cleanText = isBullet ? trimmed.replace(/^[•-]\s*/, '') : line;

                if (isBullet) {
                  return (
                    <div key={lIdx} className="flex items-start text-[14px] md:text-[15px] leading-relaxed">
                      <span className="text-[#c09a72] mr-2 select-none font-bold text-xs mt-[5px]">•</span>
                      <span className="text-[#ded4c6]">{renderInlineStyles(cleanText)}</span>
                    </div>
                  );
                }

                return (
                  <p key={lIdx} className="text-[14px] md:text-[15px] leading-relaxed text-[#ded4c6]">
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
      <div className="flex justify-end mb-3 mt-1 w-full">
        <div
          className="max-w-[80%] rounded-2xl rounded-br-xs text-[14px] md:text-[15px] text-[#fff6ee] select-text shadow-sm leading-relaxed font-normal px-4 py-2.5"
          style={{
            backgroundColor: '#845e3a',
            border: '1px solid rgba(199, 148, 102, 0.45)',
          }}
        >
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3 mt-1 w-full">
      <div className="max-w-[88%] bg-[#171310] border border-[#2b241c] rounded-2xl rounded-bl-xs px-4 md:px-5 py-3 md:py-3.5 shadow-sm select-text">
        {renderContent(displayGatewayNotice(message.content))}
        {message.status === 'streaming' && (
          <span className="inline-block w-2.5 h-4 ml-1.5 bg-[#c0a07e] animate-pulse align-middle rounded-xs" />
        )}
      </div>
    </div>
  );
};


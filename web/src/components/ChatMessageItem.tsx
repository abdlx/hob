import React from 'react';
import type { ChatMessage } from '../types/chat';
import { displayGatewayNotice } from '../services/errors';
import { MarkdownView } from './MarkdownView';

interface ChatMessageItemProps {
  message: ChatMessage;
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({ message }) => {
  const isUser = message.role === 'user';

  const renderedContent = <MarkdownView content={isUser ? message.content : displayGatewayNotice(message.content)} />;

  if (isUser) {
    return (
      <div className="flex justify-end mb-3 mt-1 w-full">
        <div
          className="max-w-[80%] rounded-2xl rounded-br-xs text-[14px] md:text-[15px] text-[#f0f2f5] select-text leading-relaxed font-normal px-4 py-2.5"
          style={{
            backgroundColor: '#3c4652',
          }}
        >
          {renderedContent}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3 mt-1 w-full">
      <div className="max-w-[88%] bg-[#171b21] rounded-2xl rounded-bl-xs px-4 md:px-5 py-3 md:py-3.5 select-text">
        {renderedContent}
        {message.status === 'streaming' && (
          <span className="inline-block w-2.5 h-4 ml-1.5 bg-[#c0a07e] animate-pulse align-middle rounded-xs" />
        )}
      </div>
    </div>
  );
};


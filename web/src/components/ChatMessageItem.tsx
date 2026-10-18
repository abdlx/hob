import React from 'react';
import { CheckCheck } from 'lucide-react';
import type { ChatMessage } from '../types/chat';
import { displayGatewayNotice } from '../services/errors';
import { MarkdownView } from './MarkdownView';

interface ChatMessageItemProps {
  message: ChatMessage;
}

function formatMessageTime(timestamp?: string): string {
  if (!timestamp) return '';
  const parsed = Date.parse(timestamp);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return timestamp;
}

export const ChatMessageItem: React.FC<ChatMessageItemProps> = ({ message }) => {
  const isUser = message.role === 'user';

  if (!message.content.trim()) return null;

  const renderedContent = (
    <MarkdownView content={isUser ? message.content : displayGatewayNotice(message.content)} />
  );

  const timeString = formatMessageTime(message.timestamp);

  if (isUser) {
    return (
      <div className="flex flex-col items-end w-full mb-4 select-text">
        <div
          className="max-w-[75%] rounded-[22px] rounded-tr-[6px] bg-[#FFFFFF] text-[14.5px] text-[#17191D] leading-relaxed px-5 py-3.5 shadow-[0_3px_10px_rgba(0,0,0,0.05)] border border-black/[0.035]"
        >
          {renderedContent}
        </div>

        {/* Timestamp beneath bubble with blue double checkmarks */}
        <div className="flex items-center gap-1 mt-1.5 mr-2 text-[11px] text-[#7B8798]">
          <span>{timeString}</span>
          <CheckCheck size={14} className="text-[#1677FF] stroke-[2.5]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start w-full mb-4 select-text">
      {/* Incoming Bubble without bot avatar */}
      <div className="max-w-[82%] rounded-[22px] rounded-tl-[6px] bg-[#F0F0F0] text-[14.5px] text-[#253041] leading-relaxed px-5 py-3.5">
        {renderedContent}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-4 ml-1.5 bg-[#1677FF] animate-pulse align-middle rounded-xs" />
        )}
      </div>

      {/* Timestamp beneath bubble */}
      {timeString && (
        <div className="mt-1.5 ml-2 text-[11px] text-[#7B8798]">
          {timeString}
        </div>
      )}
    </div>
  );
};

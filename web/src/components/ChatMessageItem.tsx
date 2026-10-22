import React from 'react';
import { CheckCheck } from 'lucide-react';
import type { ChatMessage } from '../types/chat';
import { displayGatewayNotice } from '../services/errors';
import { renderMediaDirectives } from '../services/media';
import { chatApi } from '../services/api';
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

  const content = isUser ? message.content : displayGatewayNotice(message.content);
  const renderedContent = (
    <MarkdownView content={renderMediaDirectives(content, message.profile || chatApi.getProfile())} />
  );

  const timeString = formatMessageTime(message.timestamp);

  if (isUser) {
    return (
      <div className="flex flex-col items-end w-full mb-4 select-text">
        <div
          className="max-w-[75%] rounded-[22px] rounded-tr-[6px] bg-surface text-[14.5px] text-ink leading-relaxed px-4 py-2.5 shadow-[0_3px_10px_rgba(0,0,0,0.05)] border border-black/[0.035]"
        >
          {renderedContent}
        </div>

        {/* Timestamp beneath bubble with blue double checkmarks */}
        <div className="flex items-center gap-1 mt-1.5 mr-2 text-[11px] text-faint">
          <span>{timeString}</span>
          <CheckCheck size={14} className="text-accent stroke-[2.5]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start w-full mb-4 select-text">
      {/* Who is answering matters when several members share one conversation. */}
      {message.sender && (
        <span className="mb-1 ml-2 text-[12px] font-semibold text-muted">{message.sender}</span>
      )}
      {/* Incoming Bubble without bot avatar */}
      <div className="max-w-[82%] rounded-[22px] rounded-tl-[6px] bg-neutral text-[14.5px] text-code leading-relaxed px-4 py-2.5">
        {renderedContent}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-4 ml-1.5 bg-accent animate-pulse align-middle rounded-xs" />
        )}
      </div>

      {/* Timestamp beneath bubble */}
      {timeString && (
        <div className="mt-1.5 ml-2 text-[11px] text-faint">
          {timeString}
        </div>
      )}
    </div>
  );
};

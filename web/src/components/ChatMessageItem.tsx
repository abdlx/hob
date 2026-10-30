import React from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ChatMessage } from '../types/chat';
import { displayGatewayNotice } from '../services/errors';
import { renderMediaDirectives } from '../services/media';
import { chatApi } from '../services/api';
import { MarkdownView } from './MarkdownView';
import { CopyButton } from './CopyButton';

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
      <div className="group/message flex min-w-0 flex-col items-end w-full mb-5 select-text" data-message-id={message.id}>
        <div
          className="hob-outgoing-bubble min-w-0 max-w-[92%] sm:max-w-[85%] rounded-[22px] rounded-tr-[6px] bg-surface text-[14.5px] text-ink leading-relaxed px-4 py-2.5 shadow-xs border border-hair"
        >
          {renderedContent}
        </div>

        <div className="flex min-h-8 items-center gap-2 mt-1 mr-1 text-[11px] text-faint">
          {message.status === 'sending' ? <span className="inline-flex items-center gap-1"><LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" />In progress</span> : message.status === 'error' ? <span className="inline-flex items-center gap-1 text-bad"><TriangleAlert size={12} />Not confirmed</span> : null}
          <time dateTime={Number.isNaN(Date.parse(message.timestamp)) ? undefined : message.timestamp} title={message.timestamp}>{timeString}</time>
          <span className="transition-opacity md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100"><CopyButton text={content} compact /></span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/message flex min-w-0 flex-col items-start w-full mb-5 select-text" data-message-id={message.id}>
      {/* Who is answering matters when several members share one conversation. */}
      {message.sender && (
        <span className="mb-1 ml-2 text-[12px] font-semibold text-muted">{message.sender}</span>
      )}
      {/* Incoming Bubble without bot avatar */}
      <div className="hob-incoming-bubble min-w-0 max-w-[96%] sm:max-w-[92%] rounded-[22px] rounded-tl-[6px] bg-neutral text-[14.5px] text-code leading-relaxed px-4 py-3">
        {renderedContent}
        {message.status === 'streaming' && (
          <span className="inline-block w-2 h-4 ml-1.5 bg-accent animate-pulse align-middle rounded-xs" />
        )}
      </div>

      {/* Timestamp beneath bubble */}
      <div className="mt-1 ml-1 flex min-h-8 items-center gap-2 text-[11px] text-faint"><time dateTime={Number.isNaN(Date.parse(message.timestamp)) ? undefined : message.timestamp} title={message.timestamp}>{timeString}</time>
        {message.status === 'streaming' ? <span role="status" className="text-muted">Writing…</span> : <span className="transition-opacity md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100"><CopyButton text={content} compact /></span>}
      </div>
    </div>
  );
};

import React, { useEffect, useRef } from 'react';
import { useChat } from '../context/ChatContext';
import { ChatMessageItem } from './ChatMessageItem';

export const ChatMessageList: React.FC = () => {
  const { messages, isLoading } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInitial = useRef(true);

  useEffect(() => {
    if (isInitial.current) {
      isInitial.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 pt-[78px] pb-2">
      <div className="w-full max-w-[570px] mx-auto flex flex-col justify-start min-h-full">
        {messages.map((message) => (
          <ChatMessageItem key={message.id} message={message} />
        ))}

        {isLoading && messages[messages.length - 1]?.role === 'user' && (
          <div className="flex justify-start mb-2.5 mt-0.5 w-full">
            <div className="max-w-[88%] bg-[#121212] border border-[#202020] rounded-[16px] px-3.5 py-2.5 text-[#888888] shadow-xs flex items-center space-x-2">
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 animate-ping" />
              <span className="text-[11px] font-medium text-neutral-400">Dogesh is thinking...</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} className="h-1 shrink-0" />
      </div>
    </div>
  );
};

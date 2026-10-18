import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import {
  Plus,
  ArrowUp,
  Mic,
  ChevronDown,
} from 'lucide-react';
import { MobileDock } from './MobileDock';

interface ChatInputProps {
  onNavigateBots?: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onNavigateBots }) => {
  const {
    sendMessage,
    isLoading,
    isPreparing,
    isCreatingConversation,
    setActiveNav,
    sessions,
    activeSessionId,
    getComposerDraft,
    setComposerDraft,
    agent,
  } = useChat();

  const readOnly = sessions.find((session) => session.id === activeSessionId)?.readOnly === true;
  const [text, setText] = useState(() => getComposerDraft(activeSessionId));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      if (!text) {
        textareaRef.current.style.height = '';
        return;
      }
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        140
      )}px`;
    }
  }, [text]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!text.trim() || isLoading || isPreparing || isCreatingConversation || readOnly) return;
    const current = text.trim();
    setText('');
    setComposerDraft(activeSessionId, '');
    if (textareaRef.current) {
      textareaRef.current.style.height = '';
    }
    await sendMessage(current);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const modelDisplayName = agent?.model
    ? agent.model.split('/').pop()?.replace(/-/g, ' ') || agent.model
    : 'Claude 3.5 Sonnet';

  return (
    <div className="hob-composer w-full px-6 pb-6 pt-2 bg-[#FAFAFA] shrink-0">
      <form
        onSubmit={handleSubmit}
        className="w-full flex items-center gap-3"
      >
        {/* Attachment + button */}
        <button
          type="button"
          title="Add context / Open library"
          aria-label="Add context"
          onClick={() => setActiveNav('library')}
          className="w-[46px] h-[46px] rounded-full bg-[#FFFFFF] border border-[#E6E6E6] text-[#253041] hover:bg-[#F5F5F5] transition-colors shrink-0 cursor-pointer flex items-center justify-center shadow-xs"
        >
          <Plus size={20} strokeWidth={2} />
        </button>

        {/* Input Pill Container */}
        <div
          className="flex-1 min-h-[52px] rounded-full bg-[#FFFFFF] border border-[#E6E6E6] px-5 py-2 flex items-center gap-2 shadow-xs transition-colors focus-within:border-[#1677FF]"
        >
          <textarea
            aria-label="Message"
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setComposerDraft(activeSessionId, e.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              readOnly
                ? 'Start a new conversation to continue'
                : isLoading
                ? 'Respond to the prompt above…'
                : `Message ${agent?.name || 'Main'}...`
            }
            disabled={isLoading || isPreparing || isCreatingConversation || readOnly}
            className="flex-1 bg-transparent text-[#17191D] placeholder-[#8792A1] text-[14px] md:text-[15px] focus:outline-none resize-none p-0 m-0 min-h-[24px] max-h-[140px] leading-[24px] text-left"
          />

          {/* Model Selector Pill */}
          <button
            type="button"
            onClick={() => setActiveNav('settings')}
            title="Model settings"
            className="rounded-full bg-[#F2F2F2] hover:bg-[#E8E8E8] px-3.5 py-1.5 text-[12px] md:text-[12.5px] font-medium text-[#253041] flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer select-none"
          >
            <span className="capitalize">{modelDisplayName}</span>
            <ChevronDown size={12} className="text-[#687588]" />
          </button>
        </div>

        {/* Voice Microphone Button */}
        <button
          type="button"
          title="Voice input"
          aria-label="Voice input"
          className="w-[46px] h-[46px] rounded-full bg-[#FFFFFF] border border-[#E6E6E6] text-[#253041] hover:bg-[#F5F5F5] transition-colors shrink-0 cursor-pointer flex items-center justify-center shadow-xs"
        >
          <Mic size={19} strokeWidth={1.8} />
        </button>

        {/* Send Button */}
        <button
          type="submit"
          aria-label="Send message"
          disabled={isLoading || isPreparing || isCreatingConversation || readOnly || !text.trim()}
          className="w-[46px] h-[46px] rounded-full bg-[#1677FF] hover:bg-[#0D6CE5] text-[#FFFFFF] flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 shadow-xs active:scale-95"
        >
          <ArrowUp size={20} strokeWidth={2.4} />
        </button>
      </form>

      {/* iOS-Inspired Bottom Dock Mobile Navigation Bar below input field on small screens */}
      <MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} />
    </div>
  );
};

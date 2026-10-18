import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import {
  Plus,
  ArrowUp,
  Mic,
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
    sessions,
    activeSessionId,
    getComposerDraft,
    setComposerDraft,
    agent,
    setActiveNav,
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

  return (
    <div className="hob-composer w-full px-3 sm:px-4 md:px-6 pb-2.5 md:pb-6 pt-1 bg-transparent shrink-0 flex flex-col items-center gap-2 select-none">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-[840px] flex items-center justify-center"
      >
        {/* Floating Pill Prompt Box with Plus, Input, Mic, and Send inside */}
        <div
          className="w-full min-h-[48px] sm:min-h-[52px] rounded-full bg-white/95 backdrop-blur-md border border-[rgba(0,0,0,0.08)] pl-2 sm:pl-2.5 pr-1.5 sm:pr-2 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-2 shadow-[0_4px_16px_rgba(0,0,0,0.06)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] transition-all focus-within:border-[#1677FF] focus-within:shadow-[0_6px_20px_rgba(22,119,255,0.12)]"
        >
          {/* Plus / Attachment button inside prompt box */}
          <button
            type="button"
            title="Add context / Open library"
            aria-label="Add context"
            onClick={() => setActiveNav('library')}
            className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-transparent hover:bg-[#F5F5F5] text-[#253041] transition-colors shrink-0 cursor-pointer flex items-center justify-center"
          >
            <Plus size={18} strokeWidth={2.2} />
          </button>

          {/* Text Input */}
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

          {/* Right Controls inside prompt box: Mic and Send */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            {/* Voice Microphone Button */}
            <button
              type="button"
              title="Voice input"
              aria-label="Voice input"
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-transparent hover:bg-[#F5F5F5] text-[#253041] transition-colors shrink-0 cursor-pointer flex items-center justify-center"
            >
              <Mic size={17} strokeWidth={1.8} />
            </button>

            {/* Send Button */}
            <button
              type="submit"
              aria-label="Send message"
              disabled={isLoading || isPreparing || isCreatingConversation || readOnly || !text.trim()}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-[#1677FF] hover:bg-[#0D6CE5] text-[#FFFFFF] flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 disabled:hover:bg-[#1677FF] shadow-xs active:scale-95"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </form>

      {/* iOS-Inspired Floating Bottom Dock Mobile Navigation Bar below input field on small screens */}
      <MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} />
    </div>
  );
};

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
    <div className="hob-composer w-full px-3 md:px-6 pb-3 md:pb-6 pt-1.5 md:pt-2 bg-[#FAFAFA] shrink-0">
      <form
        onSubmit={handleSubmit}
        className="w-full flex items-center"
      >
        {/* Unified Pill Prompt Box with Plus, Input, Mic, and Send inside */}
        <div
          className="w-full min-h-[52px] rounded-full bg-[#FFFFFF] border border-[#E6E6E6] pl-2.5 pr-2 py-1.5 flex items-center gap-2 shadow-xs transition-colors focus-within:border-[#1677FF]"
        >
          {/* Plus / Attachment button inside prompt box */}
          <button
            type="button"
            title="Add context / Open library"
            aria-label="Add context"
            onClick={() => setActiveNav('library')}
            className="w-9 h-9 rounded-full bg-transparent hover:bg-[#F5F5F5] text-[#253041] transition-colors shrink-0 cursor-pointer flex items-center justify-center"
          >
            <Plus size={19} strokeWidth={2.2} />
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
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Voice Microphone Button */}
            <button
              type="button"
              title="Voice input"
              aria-label="Voice input"
              className="w-9 h-9 rounded-full bg-transparent hover:bg-[#F5F5F5] text-[#253041] transition-colors shrink-0 cursor-pointer flex items-center justify-center"
            >
              <Mic size={18} strokeWidth={1.8} />
            </button>

            {/* Send Button */}
            <button
              type="submit"
              aria-label="Send message"
              disabled={isLoading || isPreparing || isCreatingConversation || readOnly || !text.trim()}
              className="w-9 h-9 rounded-full bg-[#1677FF] hover:bg-[#0D6CE5] text-[#FFFFFF] flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 disabled:hover:bg-[#1677FF] shadow-xs active:scale-95"
            >
              <ArrowUp size={18} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </form>

      {/* iOS-Inspired Bottom Dock Mobile Navigation Bar below input field on small screens */}
      <MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} />
    </div>
  );
};

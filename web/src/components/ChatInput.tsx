import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import {
  Plus,
  ArrowUp,
} from 'lucide-react';
import { MobileDock } from './MobileDock';

export const ChatInput: React.FC = () => {
  const { sendMessage, isLoading, isPreparing, setActiveNav } = useChat();
  const [text, setText] = useState('');
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
        120
      )}px`;
    }
  }, [text]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!text.trim() || isLoading || isPreparing) return;
    const current = text.trim();
    setText('');
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
    <div className="hob-composer w-full max-w-[800px] mx-auto px-3 md:px-6 pb-2 md:pb-4 pt-1">
      <form
        onSubmit={handleSubmit}
        className="hob-composer-form w-full min-h-[60px] rounded-2xl px-4 flex items-center gap-3 transition-colors"
      >
        {/* Plus button */}
        <button
          type="button"
          title="Add context"
          aria-label="Open library"
          onClick={() => setActiveNav('library')}
          className="text-white hover:text-white transition-colors shrink-0 cursor-pointer flex items-center justify-center p-0.5"
        >
          <Plus size={13} className="md:w-[15px] md:h-[15px]" strokeWidth={2} />
        </button>

        {/* Input */}
        <textarea
          aria-label="Message"
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message"
          disabled={isPreparing}
          className="flex-1 bg-transparent text-[#e5e5e5] placeholder-[#73716c] text-[12.5px] md:text-[13.5px] focus:outline-none resize-none p-0 m-0 h-[20px] md:h-[22px] leading-[20px] md:leading-[22px] text-left"
        />

        {/* Send Button */}
        {text.trim().length > 0 && (
          <button
            type="submit"
            aria-label="Send message"
            disabled={isLoading || isPreparing}
            className="w-[24px] h-[24px] md:w-7 md:h-7 rounded-full bg-white hover:bg-neutral-200 text-black flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 shadow-xs"
          >
            <ArrowUp size={13} className="md:w-[15px] md:h-[15px]" strokeWidth={2.5} />
          </button>
        )}
      </form>
      <p className="hob-composer-hint">Your space. Your agent. <button onClick={() => setActiveNav('idea')}>Learning stays in your hands.</button></p>

      {/* iOS-Inspired Bottom Dock Mobile Navigation Bar below input field (excluding search and settings) */}
      <MobileDock />
    </div>
  );
};

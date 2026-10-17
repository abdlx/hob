import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import {
  Plus,
  ArrowUp,
} from 'lucide-react';
import { MobileDock } from './MobileDock';

export const ChatInput: React.FC = () => {
  const { sendMessage, isLoading, isPreparing, isCreatingConversation, setActiveNav, sessions, activeSessionId, getComposerDraft, setComposerDraft } = useChat();
  const readOnly = sessions.find(session => session.id === activeSessionId)?.readOnly === true;
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
        120
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
    <div className="hob-composer w-full max-w-[840px] mx-auto px-4 md:px-8 pb-3 md:pb-5 pt-1.5">
      <form
        onSubmit={handleSubmit}
        className="hob-composer-form w-full min-h-[64px] rounded-2xl md:rounded-3xl px-4 md:px-5 py-2.5 flex items-center gap-3.5 transition-all shadow-md"
      >
        {/* Plus button */}
        <button
          type="button"
          title="Add context"
          aria-label="Open library"
          onClick={() => setActiveNav('library')}
          className="text-[#bfa993] hover:text-[#faeee1] hover:bg-[#2b2219] transition-all shrink-0 cursor-pointer flex items-center justify-center p-1.5 rounded-xl"
        >
          <Plus size={18} strokeWidth={2.2} />
        </button>

        {/* Input */}
        <textarea
          aria-label="Message"
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => { setText(e.target.value); setComposerDraft(activeSessionId, e.target.value); }}
          onKeyDown={handleKeyDown}
          placeholder={readOnly ? 'Start a new conversation to continue' : isLoading ? 'Respond to the prompt above…' : 'Message hob...'}
          disabled={isLoading || isPreparing || isCreatingConversation || readOnly}
          className="flex-1 bg-transparent text-[#eee7df] placeholder-[#807669] text-[14px] md:text-[15px] focus:outline-none resize-none p-0 m-0 min-h-[24px] max-h-[140px] leading-[24px] text-left"
        />

        {/* Send Button */}
        {text.trim().length > 0 && (
          <button
            type="submit"
            aria-label="Send message"
            disabled={isLoading || isPreparing || isCreatingConversation || readOnly}
            className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-[#f6eee4] hover:bg-white text-[#191511] flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 shadow-xs active:scale-95"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        )}
      </form>
      <p className="hob-composer-hint">Your space. Your agent. <button onClick={() => setActiveNav('idea')} className="underline underline-offset-2 hover:text-[#ff965c] transition-colors">Learning stays in your hands.</button></p>

      {/* iOS-Inspired Bottom Dock Mobile Navigation Bar below input field (excluding search and settings) */}
      <MobileDock />
    </div>
  );
};

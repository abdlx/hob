import React, { useState, useRef, useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import {
  Plus,
  ArrowUp,
  MessageCircle,
  Newspaper,
  Lightbulb,
  SquareCheck,
  Shapes,
} from 'lucide-react';
import { BottomDock } from './BottomDock/BottomDock';
import type { DockItemConfig } from './BottomDock/types';

const mobileDockItems: DockItemConfig[] = [
  { id: 'chat', label: 'Chat', icon: <MessageCircle size={20} strokeWidth={2} /> },
  { id: 'feed', label: 'Feed', icon: <Newspaper size={20} strokeWidth={2} /> },
  { id: 'idea', label: 'Idea', icon: <Lightbulb size={20} strokeWidth={2} /> },
  { id: 'goals', label: 'Goals', icon: <SquareCheck size={20} strokeWidth={2} /> },
  { id: 'library', label: 'Library', icon: <Shapes size={20} strokeWidth={2} /> },
];

export const ChatInput: React.FC = () => {
  const { sendMessage, isLoading, activeNav, setActiveNav } = useChat();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        120
      )}px`;
    }
  }, [text]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!text.trim() || isLoading) return;
    const current = text.trim();
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    await sendMessage(current);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="w-full max-w-[640px] mx-auto px-3 md:px-4 pb-2 md:pb-3 pt-1">
      <form
        onSubmit={handleSubmit}
        className="w-full h-[44px] bg-[#121212] border border-[#222222] focus-within:border-[#383838] rounded-full px-4 flex items-center gap-2.5 shadow-xs transition-colors"
      >
        {/* Plus button */}
        <button
          type="button"
          title="Add context"
          className="text-white hover:text-white transition-colors shrink-0 cursor-pointer flex items-center justify-center p-0.5"
        >
          <Plus size={15} strokeWidth={2} />
        </button>

        {/* Input */}
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message"
          className="flex-1 bg-transparent text-[#e5e5e5] placeholder-[#73716c] text-[13.5px] focus:outline-none resize-none leading-normal py-0.5"
        />

        {/* Send Button */}
        {text.trim().length > 0 && (
          <button
            type="submit"
            disabled={isLoading}
            className="w-7 h-7 rounded-full bg-white hover:bg-neutral-200 text-black flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 shadow-xs"
          >
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </form>

      {/* iOS-Inspired Bottom Dock Mobile Navigation Bar below input field (excluding search and settings) */}
      <div className="md:hidden pt-2.5 pb-1 flex justify-center">
        <BottomDock
          items={mobileDockItems}
          activeId={activeNav}
          onChange={setActiveNav}
          showSearch={false}
        />
      </div>
    </div>
  );
};

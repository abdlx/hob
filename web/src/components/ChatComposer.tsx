import React, { useEffect, useRef } from 'react';
import { Plus, ArrowUp, Mic } from 'lucide-react';
import { MobileDock } from './MobileDock';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Locks the whole composer (preparing, read-only, disbanded, unconfirmed send). */
  disabled?: boolean;
  /** Blocks submission while typing stays available (e.g. work already in flight). */
  canSend?: boolean;
  placeholder?: string;
  onAddContext?: () => void;
  onNavigateBots?: () => void;
  showMobileDock?: boolean;
}

/** The single composer the chat, and every conversation styled like it, ships. */
export const ChatComposer: React.FC<ChatComposerProps> = ({
  value,
  onChange,
  onSubmit,
  disabled = false,
  canSend = true,
  placeholder = 'Message...',
  onAddContext,
  onNavigateBots,
  showMobileDock = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!value) {
      textarea.style.height = '';
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }, [value]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (disabled || !canSend || !value.trim()) return;
    onSubmit();
  };

  return (
    <div className="hob-composer w-full px-3 sm:px-4 md:px-6 pb-2.5 md:pb-6 pt-1 bg-transparent shrink-0 flex flex-col items-center gap-2 select-none">
      <form onSubmit={submit} className="w-full max-w-[840px] flex items-center justify-center">
        {/* Floating Pill Prompt Box with Plus, Input, Mic, and Send inside */}
        <div className="w-full min-h-[48px] sm:min-h-[52px] rounded-full bg-surface/95 backdrop-blur-md border border-[rgba(0,0,0,0.08)] pl-2 sm:pl-2.5 pr-1.5 sm:pr-2 py-1 sm:py-1.5 flex items-center gap-1.5 sm:gap-2 shadow-[0_4px_16px_rgba(0,0,0,0.06)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] transition-all outline-none focus:outline-none focus-within:outline-none ring-0 focus:ring-0 focus-within:ring-0">
          {onAddContext && (
            <button
              type="button"
              title="Add context / Open library"
              aria-label="Add context"
              onClick={onAddContext}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-transparent hover:bg-sunken text-code transition-colors shrink-0 cursor-pointer flex items-center justify-center outline-none focus:outline-none"
            >
              <Plus size={18} strokeWidth={2.2} />
            </button>
          )}

          <textarea
            aria-label="Message"
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="flex-1 bg-transparent text-ink placeholder-faint text-[14px] md:text-[15px] outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 border-none shadow-none resize-none p-0 m-0 min-h-[24px] max-h-[140px] leading-[24px] text-left"
          />

          {/* Right Controls inside prompt box: Mic and Send */}
          <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
            <button
              type="button"
              title="Voice input"
              aria-label="Voice input"
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-transparent hover:bg-sunken text-code transition-colors shrink-0 cursor-pointer flex items-center justify-center"
            >
              <Mic size={17} strokeWidth={1.8} />
            </button>

            <button
              type="submit"
              aria-label="Send message"
              disabled={disabled || !canSend || !value.trim()}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-accent hover:bg-accent-strong text-white flex items-center justify-center transition-all cursor-pointer shrink-0 disabled:opacity-40 disabled:hover:bg-accent shadow-xs active:scale-95"
            >
              <ArrowUp size={17} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </form>

      {showMobileDock && <MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} />}
    </div>
  );
};

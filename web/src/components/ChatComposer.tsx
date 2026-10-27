import React, { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, ArrowUp, LoaderCircle } from 'lucide-react';
import { MobileDock } from './MobileDock';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Locks the whole composer (preparing, read-only, disbanded, unconfirmed send). */
  disabled?: boolean;
  /** Blocks submission while typing stays available (e.g. work already in flight). */
  canSend?: boolean;
  working?: boolean;
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
  working = false,
  placeholder = 'Message...',
  onAddContext,
  onNavigateBots,
  showMobileDock = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const hint = useId();

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!value) {
      textarea.style.height = '24px';
    } else {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }, [value]);

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (disabled || !canSend || !value.trim()) return;
    onSubmit();
  };

  return (
    <div className="hob-composer w-full px-3 sm:px-4 md:px-6 pt-2 bg-canvas shrink-0 flex flex-col items-center gap-2 select-none" style={{ paddingBottom: showMobileDock && !focused ? 10 : 'max(10px, env(safe-area-inset-bottom))' }}>
      <form aria-label="Message composer" onSubmit={submit} className="w-full max-w-[840px]">
        <div className="w-full min-h-14 rounded-[26px] bg-surface border border-edge px-2 py-2 flex items-end gap-2 shadow-[0_3px_14px_rgba(0,0,0,0.04)] transition-colors focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
          {onAddContext && (
            <button
              type="button"
              title="Open file library"
              aria-label="Open file library"
              onClick={onAddContext}
              className="w-10 h-10 rounded-full bg-transparent hover:bg-sunken text-muted transition-colors shrink-0 cursor-pointer flex items-center justify-center"
            >
              <FolderOpen size={18} strokeWidth={1.8} />
            </button>
          )}

          <textarea
            aria-label="Message"
            aria-describedby={hint}
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229 && !window.matchMedia('(pointer: coarse)').matches) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
            className="min-w-0 flex-1 bg-transparent text-ink placeholder-faint text-base md:text-[15px] outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0 border-none shadow-none resize-none py-2 px-0 m-0 min-h-10 max-h-40 leading-6 text-left disabled:opacity-60"
          />

          <div className="flex items-center shrink-0">
            <button
              type="submit"
              aria-label={working ? 'Waiting for current reply' : 'Send message'}
              title={working ? 'You can draft while your bot works' : 'Send message'}
              disabled={disabled || !canSend || !value.trim()}
              className="w-10 h-10 rounded-full bg-ink hover:opacity-85 text-canvas flex items-center justify-center transition-colors cursor-pointer shrink-0 disabled:opacity-30 shadow-xs active:scale-95"
            >
              {working ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" /> : <ArrowUp size={19} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
      </form>
      <div id={hint} className="flex min-h-4 w-full max-w-[840px] items-center justify-between gap-2 px-2 text-[10px] text-muted"><span>{working ? 'Your bot is working. Keep drafting while you wait.' : <span className="hidden md:inline">Enter to send · Shift + Enter for a new line</span>}</span>{focused && <button type="button" onClick={() => textareaRef.current?.blur()} className="px-2 py-1 text-xs text-accent md:hidden cursor-pointer">Done</button>}</div>
      {showMobileDock && <div className={focused ? 'hidden md:contents' : 'contents'}><MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} /></div>}
    </div>
  );
};

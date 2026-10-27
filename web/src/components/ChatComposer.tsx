import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, FolderOpen, ArrowUp, LoaderCircle, Paperclip } from 'lucide-react';
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
  attachments?: ReactNode;
  hasAttachments?: boolean;
  onAttach?: () => void;
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
  attachments,
  hasAttachments = false,
  onAttach,
  placeholder = 'Message...',
  onAddContext,
  onNavigateBots,
  showMobileDock = true,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
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
    if (disabled || !canSend || (!value.trim() && !hasAttachments)) return;
    setActionMenuOpen(false);
    onSubmit();
  };

  return (
    <div className="hob-composer w-full px-3 sm:px-4 md:px-6 pt-2 bg-canvas shrink-0 flex flex-col items-center gap-1 md:gap-2 select-none" style={{ paddingBottom: showMobileDock && !focused ? 10 : 'max(10px, env(safe-area-inset-bottom))' }}>
      <form aria-label="Message composer" onSubmit={submit} className="w-full max-w-[840px]">
        <div className="overflow-hidden rounded-[26px] border border-edge bg-surface shadow-[0_3px_14px_rgba(0,0,0,0.04)] transition-colors focus-within:border-accent-line focus-within:shadow-[0_0_0_3px_var(--color-accent-soft)]">
        {attachments}
        <div className="w-full min-h-14 px-2 py-2 flex items-end gap-2">
          {(onAttach || onAddContext) && (
            <div className="relative shrink-0">
              <button
                type="button"
                title="Add files or library"
                aria-label="Add files or library"
                aria-expanded={actionMenuOpen}
                disabled={disabled}
                onClick={() => {
                  if (onAttach && onAddContext) {
                    setActionMenuOpen((prev) => !prev);
                  } else if (onAttach) {
                    onAttach();
                  } else if (onAddContext) {
                    onAddContext();
                  }
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink disabled:opacity-40 cursor-pointer transition-colors"
              >
                <Plus size={19} strokeWidth={2.2} className={`transition-transform duration-150 ${actionMenuOpen ? 'rotate-45 text-ink' : ''}`} />
              </button>

              {actionMenuOpen && (
                <>
                  <span className="fixed inset-0 z-30" aria-hidden onClick={() => setActionMenuOpen(false)} />
                  <div
                    role="menu"
                    className="absolute bottom-full left-0 mb-2 z-40 min-w-[170px] overflow-hidden rounded-2xl border border-hair bg-surface/95 backdrop-blur-md p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.12)] flex flex-col gap-0.5"
                  >
                    {onAttach && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpen(false);
                          onAttach();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink hover:bg-sunken transition-colors cursor-pointer"
                      >
                        <Paperclip size={16} className="text-muted shrink-0" />
                        <span className="font-medium">Attach files</span>
                      </button>
                    )}
                    {onAddContext && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpen(false);
                          onAddContext();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] text-ink hover:bg-sunken transition-colors cursor-pointer"
                      >
                        <FolderOpen size={16} className="text-muted shrink-0" />
                        <span className="font-medium">File library</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
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
              disabled={disabled || !canSend || (!value.trim() && !hasAttachments)}
              className="w-10 h-10 rounded-full bg-ink hover:opacity-85 text-canvas flex items-center justify-center transition-colors cursor-pointer shrink-0 disabled:opacity-30 shadow-xs active:scale-95"
            >
              {working ? <LoaderCircle size={18} className="animate-spin motion-reduce:animate-none" /> : <ArrowUp size={19} strokeWidth={2.2} />}
            </button>
          </div>
        </div>
        </div>
      </form>
      <div id={hint} className={`w-full max-w-[840px] items-center justify-between gap-2 px-2 text-[10px] text-muted ${working || focused ? 'flex min-h-4' : 'hidden md:flex min-h-4'}`}><span>{working ? 'Your bot is working. Keep drafting while you wait.' : <span>Enter to send · Shift + Enter for a new line</span>}</span>{focused && <button type="button" onClick={() => textareaRef.current?.blur()} className="px-2 py-1 text-xs text-accent md:hidden cursor-pointer">Done</button>}</div>
      {showMobileDock && <div className={focused ? 'hidden md:contents' : 'contents'}><MobileDock currentMobileView="chat" onNavigateBots={onNavigateBots} /></div>}
    </div>
  );
};

import React, { useCallback, useSyncExternalStore } from 'react';
import { useChat } from '../context/ChatContext';
import { ChatComposer } from './ChatComposer';

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
    subscribeComposerDraft,
    agent,
    setActiveNav,
  } = useChat();

  const readOnly = sessions.find((session) => session.id === activeSessionId)?.readOnly === true;
  const subscribe = useCallback((listener: () => void) => subscribeComposerDraft(activeSessionId, listener), [activeSessionId, subscribeComposerDraft]);
  const snapshot = useCallback(() => getComposerDraft(activeSessionId), [activeSessionId, getComposerDraft]);
  const text = useSyncExternalStore(subscribe, snapshot);
  const disabled = isPreparing || isCreatingConversation || readOnly;

  const submit = () => {
    const current = text.trim();
    if (!current || disabled || isLoading) return;
    setComposerDraft(activeSessionId, '');
    void sendMessage(current);
  };

  return (
    <ChatComposer
      value={text}
      onChange={(value) => {
        setComposerDraft(activeSessionId, value);
      }}
      onSubmit={submit}
      disabled={disabled}
      canSend={!isLoading}
      working={isLoading}
      placeholder={
        readOnly
          ? 'Start a new conversation to continue'
          : `Message ${agent?.name || 'Main'}...`
      }
      onAddContext={() => setActiveNav('library')}
      onNavigateBots={onNavigateBots}
    />
  );
};

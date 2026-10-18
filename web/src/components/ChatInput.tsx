import React, { useState } from 'react';
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
    agent,
    setActiveNav,
  } = useChat();

  const readOnly = sessions.find((session) => session.id === activeSessionId)?.readOnly === true;
  const [text, setText] = useState(() => getComposerDraft(activeSessionId));
  const disabled = isLoading || isPreparing || isCreatingConversation || readOnly;

  const submit = () => {
    const current = text.trim();
    if (!current || disabled) return;
    setText('');
    setComposerDraft(activeSessionId, '');
    void sendMessage(current);
  };

  return (
    <ChatComposer
      value={text}
      onChange={(value) => {
        setText(value);
        setComposerDraft(activeSessionId, value);
      }}
      onSubmit={submit}
      disabled={disabled}
      placeholder={
        readOnly
          ? 'Start a new conversation to continue'
          : isLoading
          ? 'Respond to the prompt above…'
          : `Message ${agent?.name || 'Main'}...`
      }
      onAddContext={() => setActiveNav('library')}
      onNavigateBots={onNavigateBots}
    />
  );
};

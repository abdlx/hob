import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { useChat } from '../context/ChatContext';
import { ChatComposer } from './ChatComposer';
import { attachmentDraft, attachmentsUploading, pickBrowserFiles, pickNativeMedia, setAttachmentDraft, setAttachmentsUploading, subscribeAttachments, uploadAttachment } from '../services/attachments';
import { chatApi } from '../services/api';
import { ComposerAttachments } from './ComposerAttachments';
import { errorText } from './workspaceUtils';
import { VoiceInput } from './VoiceInput';
import { useRuntime } from '../context/RuntimeContext';

interface ChatInputProps {
  onNavigateBots?: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onNavigateBots }) => {
  const runtime = useRuntime();
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
  const attachmentSubscribe = useCallback((listener: () => void) => subscribeAttachments(activeSessionId, listener), [activeSessionId]);
  const filesSnapshot = useCallback(() => attachmentDraft(activeSessionId), [activeSessionId]);
  const busySnapshot = useCallback(() => attachmentsUploading(activeSessionId), [activeSessionId]);
  const files = useSyncExternalStore(attachmentSubscribe, filesSnapshot);
  const uploading = useSyncExternalStore(attachmentSubscribe, busySnapshot);
  const [attachmentError, setAttachmentError] = useState('');
  const disabled = isPreparing || isCreatingConversation || readOnly;
  async function attach() {
    if (!activeSessionId || attachmentsUploading(activeSessionId)) return;
    const profile = chatApi.getProfile(), session = activeSessionId;
    setAttachmentsUploading(session, true); setAttachmentError('');
    try {
      const picked = window.ReactNativeWebView ? await pickNativeMedia() : await pickBrowserFiles();
      if (attachmentDraft(session).length + picked.length > 10) throw new Error('Attach up to 10 files per prompt.');
      for (const file of picked) {
        const result = await uploadAttachment(profile, session, file);
        setAttachmentDraft(session, [...attachmentDraft(session), result]);
      }
    } catch (error) { setAttachmentError(errorText(error)); }
    finally { setAttachmentsUploading(session, false); }
  }

  const submit = () => {
    const current = text.trim() || (files.length ? 'Please review the attached files.' : '');
    if (!current || disabled || isLoading || uploading) return;
    setComposerDraft(activeSessionId, '');
    setAttachmentDraft(activeSessionId, []);
    void sendMessage(current, files);
  };

  return (
    <><div className="shrink-0 px-4 text-xs">{attachmentError && <p role="alert" className="py-2 text-bad">{attachmentError}</p>}{uploading && <p role="status" className="py-2 text-muted">Adding attachments…</p>}</div><ChatComposer
      value={text}
      onChange={(value) => {
        setComposerDraft(activeSessionId, value);
      }}
      onSubmit={submit}
      disabled={disabled}
      voiceInput={runtime === 'hermes' && agent && activeSessionId ? <VoiceInput key={`${agent.id}:${activeSessionId}`} profile={agent.id} disabled={Boolean(disabled)} onTranscript={value => setComposerDraft(activeSessionId, [getComposerDraft(activeSessionId), value].filter(Boolean).join('\n'))} /> : undefined}
      canSend={!isLoading && !uploading}
      onAttach={!disabled && activeSessionId ? attach : undefined}
      hasAttachments={files.length > 0}
      attachments={files.length > 0 ? <ComposerAttachments files={files} disabled={uploading} remove={id => setAttachmentDraft(activeSessionId, files.filter(file => file.id !== id))} /> : undefined}
      working={isLoading}
      placeholder={
        readOnly
          ? 'Start a new conversation to continue'
          : 'Message'
      }
      onAddContext={() => setActiveNav('library')}
      onNavigateBots={onNavigateBots}
    /></>
  );
};

import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { useChat } from '../context/ChatContext';
import { ChatComposer } from './ChatComposer';
import { attachmentDraft, attachmentsUploading, pickBrowserFiles, pickNativeMedia, setAttachmentDraft, setAttachmentsUploading, subscribeAttachments, uploadAttachment } from '../services/attachments';
import { apiFetch, chatApi } from '../services/api';
import { ComposerAttachments } from './ComposerAttachments';
import { errorText } from './workspaceUtils';
import { VoiceInput } from './VoiceInput';
import { useRuntime } from '../context/RuntimeContext';
import { Clock, X } from 'lucide-react';

export const ChatInput: React.FC = () => {
  const runtime = useRuntime();
  const {
    sendMessage,
    isLoading,
    isPreparing,
    connectionIssue,
    isCreatingConversation,
    sessions,
    activeSessionId,
    getComposerDraft,
    setComposerDraft,
    subscribeComposerDraft,
    agent,
    setActiveNav,
    queuedPrompts,
    removeQueuedPrompt,
    stopActiveRun,
    isStopping,
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
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState('');
  const [storage, setStorage] = useState<{session: string; items: {id: string; name: string; bytes: number; complete: boolean}[]} | null>(null);
  async function showStorage() {
    const session = activeSessionId;
    try {
      const data = await apiFetch<{items: NonNullable<typeof storage>['items']}>('/api/sessions/' + encodeURIComponent(session) + '/uploads');
      setStorage({ session, items: data.items });
    } catch (error) { setAttachmentError(errorText(error)); }
  }
  async function removeUpload(id: string) {
    if (!window.confirm('Delete this upload from the bot workspace? Existing references will stop working.')) return;
    try {
      await apiFetch('/api/sessions/' + encodeURIComponent(activeSessionId) + '/uploads?id=' + id + '&remove=1', { method: 'DELETE' });
      setAttachmentDraft(activeSessionId, files.filter(f => f.uploadId !== id));
      await showStorage();
    } catch (error) { setAttachmentError(errorText(error)); }
  }
  async function attach(folder = false) {
    if (!activeSessionId || attachmentsUploading(activeSessionId)) return;
    const profile = chatApi.getProfile(), session = activeSessionId;
    setAttachmentsUploading(session, true); setAttachmentError('');
    try {
      if (window.ReactNativeWebView && !folder) {
        for (const file of await pickNativeMedia()) {
          const result = await uploadAttachment(profile, session, file);
          setAttachmentDraft(session, [...attachmentDraft(session), result]);
        }
        return;
      }
      const files = await pickBrowserFiles(folder);
      if (!files.length) return;
      const abort = new AbortController();
      controller.current = abort;
      const base = '/api/sessions/' + encodeURIComponent(session) + '/uploads';
      const headers = { 'X-Hob-Profile': profile };
      const request = <T,>(url: string, init: RequestInit = {}) => apiFetch<T>(url, { ...init, headers: { ...headers, ...init.headers }, signal: abort.signal });
      const selection = JSON.stringify(files.map(f => [f.path, f.size, f.file?.lastModified]));
      const slot = 'hob:upload:' + session;
      let saved: { selection: string; id: string; chunkSize: number } | null = null;
      try { saved = JSON.parse(localStorage.getItem(slot) || 'null'); } catch { /* Optional browser storage. */ }
      let resumed = saved?.selection === selection ? saved : null;
      if (resumed) {
        try { await request(base + '?id=' + resumed.id); }
        catch (err) { if ((err as { status?: number }).status === 404) resumed = null; else throw err; }
      }
      const batch = resumed || await request<{ id: string; chunkSize: number }>(base, { method: 'POST', body: JSON.stringify({ entries: files.map(f => ({ path: f.path, size: f.size, directory: f.directory })) }) });
      try { localStorage.setItem(slot, JSON.stringify({ ...batch, selection })); } catch { /* Transfer still works without persistence. */ }
      const url = base + '?id=' + batch.id;
      try {
        for (const [index, entry] of files.entries()) {
          const file = entry.file;
          if (!file) continue;
          const part = url + '&entry=' + index;
          let offset = resumed ? (await request<{ offset: number }>(part)).offset : 0, retries = 0;
          while (offset < file.size) {
            setProgress(file.name + ' · ' + Math.floor(offset / file.size * 100) + '%');
            try {
              const result = await request<{ offset: number }>(part + '&offset=' + offset, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file.slice(offset, offset + batch.chunkSize) });
              offset = result.offset;
              retries = 0;
            } catch (error) {
              if (abort.signal.aborted || ++retries > 3) throw error;
              offset = (await request<{ offset: number }>(part)).offset;
            }
          }
        }
        const result = await request<import('../services/attachments').ChatAttachment>(url, { method: 'POST' });
        if (files.length === 1 && files[0].file && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(result.mime)) result.preview = URL.createObjectURL(files[0].file);
        setAttachmentDraft(session, [...attachmentDraft(session), result]);
        try { localStorage.removeItem(slot); } catch { /* Optional browser storage. */ }
      } catch (error) {
        if (!abort.signal.aborted) throw new Error(errorText(error) + ' Choose the same selection to resume.');
        try { localStorage.removeItem(slot); } catch { /* Optional browser storage. */ }
        await apiFetch(url, { method: 'DELETE', headers }).catch(() => undefined);
        throw error;
      }
    } catch (error) { setAttachmentError(errorText(error)); }
    finally { controller.current = null; setProgress(''); setAttachmentsUploading(session, false); }
  }

  const submit = () => {
    const current = text.trim() || (files.length ? 'Please review the attached files.' : '');
    if (!current || disabled || uploading || !navigator.onLine) return;
    setComposerDraft(activeSessionId, '');
    setAttachmentDraft(activeSessionId, []);
    void sendMessage(current, files);
  };

  return (
    <>{storage && storage.session === activeSessionId && <div className="mx-4 max-h-40 overflow-auto text-xs"><button onClick={() => setStorage(null)}>Close upload storage</button>{storage.items.length === 0 && <p>No uploads in this chat.</p>}{storage.items.map(item => <div key={item.id} className="flex gap-3 py-1"><span>{item.name} · {(item.bytes / 1048576).toFixed(1)} MiB{item.complete ? '' : ' · Partial'}</span><button onClick={() => void removeUpload(item.id)}>Delete</button></div>)}</div>}<div className="shrink-0 px-4 text-xs">{attachmentError && <p role="alert" className="py-2 text-bad">{attachmentError}</p>}{uploading && <p role="status" className="py-2 text-muted">{progress || "Adding attachments…"} <button onClick={() => controller.current?.abort()}>Cancel</button></p>}</div><ChatComposer
      value={text}
      onChange={(value) => {
        setComposerDraft(activeSessionId, value);
      }}
      onSubmit={submit}
      onStop={stopActiveRun}
      disabled={disabled}
      voiceInput={runtime === 'hermes' && agent && activeSessionId ? <VoiceInput key={`${agent.id}:${activeSessionId}`} profile={agent.id} disabled={Boolean(disabled || connectionIssue === 'offline')} onTranscript={value => setComposerDraft(activeSessionId, [getComposerDraft(activeSessionId), value].filter(Boolean).join('\n'))} /> : undefined}
      canSend={!uploading && connectionIssue !== 'offline'}
      onAttach={!disabled && connectionIssue !== 'offline' && activeSessionId ? attach : undefined}
      onStorage={activeSessionId && !readOnly ? () => void showStorage() : undefined}
      onFolder={!disabled && activeSessionId ? () => void attach(true) : undefined}
      hasAttachments={files.length > 0}
      attachments={files.length > 0 ? <ComposerAttachments key={activeSessionId} session={activeSessionId} profile={chatApi.getProfile()} files={files} disabled={uploading} remove={id => setAttachmentDraft(activeSessionId, files.filter(file => file.id !== id))} /> : undefined}
      queuedBanner={
        queuedPrompts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5 pb-1.5 border-b border-edge/60 text-xs text-muted" role="status" aria-label="Queued messages">
            <span className="inline-flex items-center gap-1 font-semibold text-ink text-[12px]">
              <Clock size={13} className="text-accent shrink-0" />
              Queued ({queuedPrompts.length}):
            </span>
            {queuedPrompts.map((item, idx) => (
              <span
                key={item.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-sunken text-ink text-[12px] border border-edge/70 max-w-full"
                title={`Queued prompt ${idx + 1}`}
              >
                <span className="max-w-[180px] sm:max-w-[260px] truncate">{item.content}</span>
                <button
                  type="button"
                  onClick={() => removeQueuedPrompt(item.id)}
                  className="hover:text-bad cursor-pointer text-muted transition-colors p-0.5"
                  aria-label={`Cancel queued prompt ${idx + 1}`}
                  title="Cancel"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : undefined
      }
      working={isLoading}
      stopping={isStopping}
      placeholder={
        readOnly
          ? 'Start a new conversation to continue'
          : 'Message'
      }
      onAddContext={() => setActiveNav('library')}
    /></>
  );
};

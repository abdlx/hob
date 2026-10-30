import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X } from 'lucide-react';
import { apiFetch } from '../services/api';
import { buttonClass } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

export function VoiceInput({ profile, disabled, onTranscript }: { profile: string; disabled: boolean; onTranscript: (value: string) => void }) {
  const [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'review' | 'uploading'>('idle');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null), stream = useRef<MediaStream | null>(null);
  const recording = useRef<Blob | null>(null), controller = useRef<AbortController | null>(null);
  const generation = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; if (timer.current) clearTimeout(timer.current); };
  const cancel = () => {
    generation.current++; controller.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release(); recording.current = null; setPhase('idle'); setOpen(false); setError('');
  };
  useEffect(() => () => {
    generation.current++; controller.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    release();
  }, []);
  async function start() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Voice recording requires HTTPS and a browser with microphone recording support.'); return;
    }
    const current = ++generation.current;
    setPhase('permission'); setError('');
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (current !== generation.current) { captured.getTracks().forEach(track => track.stop()); return; }
      stream.current = captured;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const next = new MediaRecorder(captured, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 });
      const parts: Blob[] = [];
      let size = 0;
      next.ondataavailable = event => { parts.push(event.data); size += event.data.size; if (size > 1024 * 1024 && next.state === 'recording') next.stop(); };
      next.onstop = () => {
        release(); if (current !== generation.current) return;
        const blob = new Blob(parts, { type: next.mimeType });
        if (!blob.size || blob.size > 1024 * 1024) { setError('The recording was empty or exceeded 1 MB. Record a shorter note.'); setPhase('idle'); return; }
        recording.current = blob; setPhase('review');
      };
      next.onerror = () => { release(); if (current === generation.current) { generation.current++; setError('Recording failed. Try again.'); setPhase('idle'); } };
      recorder.current = next; next.start(500); setPhase('recording');
      timer.current = setTimeout(() => { if (next.state === 'recording') next.stop(); }, 60000);
    } catch (cause) { release(); if (current === generation.current) { setError(errorText(cause)); setPhase('idle'); } }
  }
  async function transcribe() {
    const blob = recording.current; if (!blob || phase !== 'review') return;
    const current = generation.current;
    controller.current = new AbortController(); setPhase('uploading'); setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read this recording.')); reader.readAsDataURL(blob);
      });
      if (current !== generation.current) return;
      const result = await apiFetch<{ transcript: string }>(`/api/hermes/setup/audio/transcribe?profile=${encodeURIComponent(profile)}`, {
        method: 'POST', headers: { 'X-Hob-Profile': profile }, body: JSON.stringify({ dataUrl, confirm: true }), signal: controller.current.signal,
      });
      if (current !== generation.current) return;
      if (!result.transcript.trim()) { setError('No speech was detected. Try a new recording.'); setPhase('review'); return; }
      onTranscript(result.transcript); recording.current = null; setPhase('idle'); setOpen(false);
    } catch (cause) { if (current === generation.current) { setError(errorText(cause)); setPhase('review'); } }
  }
  return <div className="hob-voice-input text-xs">
    {!open ? <button type="button" disabled={disabled} aria-label="Voice input" className="hob-voice-trigger inline-flex min-h-9 items-center gap-1.5 px-2 text-muted hover:text-ink disabled:opacity-40 cursor-pointer" onClick={() => setOpen(true)}><Mic size={14} /><span>Voice input</span></button> : <section aria-label="Voice input" className="mb-2 space-y-2 rounded-2xl border border-hair bg-panel p-3">
      <p className="leading-relaxed text-muted">Record up to one minute. Transcribe sends the recording to this bot's configured speech provider. Review and edit the transcript before sending your message.</p>
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'idle' && <button type="button" className={buttonClass} disabled={disabled} onClick={() => void start()}><Mic size={14} />Start recording</button>}
        {phase === 'permission' && <span role="status">Waiting for microphone permission…</span>}
        {phase === 'recording' && <button type="button" className={buttonClass} onClick={() => recorder.current?.stop()}><Square size={14} />Stop recording</button>}
        {phase === 'review' && <button type="button" className={buttonClass} onClick={() => void transcribe()}>Transcribe recording</button>}
        {phase === 'uploading' && <span role="status">Transcribing…</span>}
        <button type="button" className={buttonClass} onClick={cancel}><X size={14} />Cancel voice input</button>
      </div>{phase === 'recording' && <p role="status" className="text-bad">Microphone is recording.</p>}{error && <p role="alert" className="text-bad">{error}</p>}
    </section>}
  </div>;
}

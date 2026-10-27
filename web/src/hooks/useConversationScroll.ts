import { useCallback, useEffect, useRef, useState } from 'react';

/** Keep following a reply until the reader deliberately scrolls away. */
export function useConversationScroll(conversation: string, revision: unknown, submission?: string) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);
  const latest = useCallback(() => {
    following.current = true; setAway(false);
    const node = viewport.current;
    if (node?.clientHeight) node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  }, []);
  const onScroll = useCallback(() => {
    const node = viewport.current;
    if (!node?.clientHeight) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 96;
    // Images and inline cards can grow without a user scroll. Keep following
    // through that growth; an upward move is the reader leaving the bottom.
    if (atBottom) following.current = true;
    else if (node.scrollTop < lastTop.current - 1) following.current = false;
    lastTop.current = node.scrollTop;
    setAway(!following.current);
  }, []);
  useEffect(() => {
    following.current = true;
    const frame = requestAnimationFrame(latest);
    return () => cancelAnimationFrame(frame);
  }, [conversation, latest]);
  useEffect(() => {
    if (!submission) return;
    following.current = true;
    const frame = requestAnimationFrame(latest);
    return () => cancelAnimationFrame(frame);
  }, [submission, latest]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (following.current) latest(); });
    return () => cancelAnimationFrame(frame);
  }, [revision, latest]);
  useEffect(() => {
    const observer = new ResizeObserver(() => { if (following.current) latest(); });
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [latest]);
  return { viewport, content, onScroll, away, latest };
}

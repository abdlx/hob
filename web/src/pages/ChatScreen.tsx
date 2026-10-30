import { useEffect, useState } from 'react';
import { LeftSidebar } from '../components/LeftSidebar';
import { BotsSidebar } from '../components/BotsSidebar';
import { ChatHeader } from '../components/ChatHeader';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { RightPanel } from '../components/RightPanel';
import { ChatsDrawer } from '../components/ChatsDrawer';
import { useChat } from '../context/ChatContext';
import { WorkspaceViews } from './WorkspaceViews';
import { Notice } from '../components/WorkspaceUI';
import { MobileDock } from '../components/MobileDock';
import { useMediaQuery } from '../hooks/useMediaQuery';

export function ChatScreen() {
  const { agent, activeNav, error, clearError, refresh, isPreparing, isCreatingConversation,
    activeSessionId, sessions, createNewSession, isRightPanelOpen, isBotsSidebarOpen } = useChat();
  const mobile = useMediaQuery('(max-width: 767px)');
  const [mobileView, setMobileView] = useState<'bots' | 'chat'>('chat');
  const [drafting, setDrafting] = useState(false);
  useEffect(() => {
    const opened = () => { setMobileView('chat'); setDrafting(false); };
    const bots = () => { setMobileView('bots'); setDrafting(false); };
    window.addEventListener('hob:conversation-opened', opened);
    window.addEventListener('hob:open-bots', bots);
    return () => { window.removeEventListener('hob:conversation-opened', opened); window.removeEventListener('hob:open-bots', bots); };
  }, []);
  const chatPage = activeNav === 'chat' || activeNav === 'search';
  const library = activeNav === 'library';
  const readOnly = sessions.find(session => session.id === activeSessionId)?.readOnly === true;
  return <div className="hob-app flex h-dvh max-h-dvh w-screen max-w-full overflow-hidden bg-canvas md:bg-app md:p-2.5 md:gap-2.5 select-none">
    {!mobile && <aside className={`hob-panel-left flex rounded-[34px] bg-canvas border border-hair overflow-hidden shrink-0 h-full ${library ? 'w-[76px]' : isBotsSidebarOpen ? 'w-[23%] min-w-[280px] max-w-[340px]' : 'w-[136px]'}`} aria-label={library ? 'Navigation' : 'Navigation and bots'}>
      <LeftSidebar />{!library && <BotsSidebar collapsed={!isBotsSidebarOpen} />}
    </aside>}
    <ChatsDrawer key={agent?.id} />
    <main id="main-content" className="hob-panel-center flex-1 flex flex-col h-full min-w-0 min-h-0 md:rounded-[34px] bg-canvas md:border md:border-hair overflow-hidden relative"
      onFocusCapture={event => { if (event.target instanceof HTMLTextAreaElement && event.target.closest('.hob-composer')) setDrafting(true); }}
      onBlurCapture={event => { if (event.target instanceof HTMLTextAreaElement && event.target.closest('.hob-composer')) setDrafting(false); }}>
      {isPreparing && <div className="px-6 pt-3"><Notice>Your agent runtime is starting. Settings remain available.</Notice></div>}
      {isCreatingConversation && <div className="px-6 pt-3"><Notice>Creating your conversation...</Notice></div>}
      {error && <div className="px-6 pt-3"><Notice error>{error}<div className="flex gap-2.5 mt-2.5"><button onClick={refresh} className="px-3 py-1 rounded-xl bg-bad text-white text-xs">Retry</button><button onClick={clearError} className="px-3 py-1 rounded-xl bg-surface text-ink text-xs">Dismiss</button></div></Notice></div>}
      <div className="hob-page-content flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col relative">
        {chatPage ? mobile && mobileView === 'bots' ? <BotsSidebar onSelectBot={() => setMobileView('chat')} /> : <>
          <ChatHeader />
          {readOnly && <div className="px-6 pt-[158px] md:pt-[88px] pb-2 shrink-0 z-10"><Notice>This older API conversation is preserved as history. <button className="underline text-accent" onClick={createNewSession}>Start a new interactive conversation</button></Notice></div>}
          <ChatMessageList />
          <ChatInput key={`composer:${activeSessionId}`} />
        </> : <WorkspaceViews activeNav={activeNav} />}
      </div>
      {mobile && activeNav !== 'settings' && <MobileDock hidden={drafting} onNavigate={id => { setDrafting(false); if (id === 'chat') setMobileView('chat'); }} />}
    </main>
    {activeNav !== 'groups' && !library && isRightPanelOpen && <aside className="hob-panel-right fixed inset-0 z-50 flex flex-col w-full h-dvh max-h-dvh bg-canvas overflow-hidden xl:relative xl:inset-auto xl:z-auto xl:rounded-[34px] xl:border xl:border-hair xl:shrink-0 xl:w-[22%] xl:min-w-[300px] xl:max-w-[350px] xl:h-full" aria-label="Agent details"><RightPanel /></aside>}
  </div>;
}

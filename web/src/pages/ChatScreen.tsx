import React, { useEffect, useState } from 'react';
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

export const ChatScreen: React.FC = () => {
  const {
    activeNav,
    setActiveNav,
    error,
    clearError,
    refresh,
    isPreparing,
    isCreatingConversation,
    activeSessionId,
    sessions,
    createNewSession,
    isRightPanelOpen,
    toggleRightPanel,
    isBotsSidebarOpen,
  } = useChat();

  const readOnly = sessions.find((session) => session.id === activeSessionId)?.readOnly === true;
  const libraryWorkspace = activeNav === 'library';

  // On mobile: first screen is the bots directory, selecting a bot opens its chat
  const [mobileView, setMobileView] = useState<'bots' | 'chat'>('bots');
  useEffect(() => {
    const opened = () => setMobileView('chat');
    window.addEventListener('hob:conversation-opened', opened);
    return () => window.removeEventListener('hob:conversation-opened', opened);
  }, []);

  return (
    <div className="hob-app flex h-[100vh] h-[100dvh] max-h-[100dvh] w-screen max-w-full overflow-hidden bg-canvas md:bg-app p-0 md:p-2.5 gap-0 md:gap-2.5 select-none">
      {/* Panel 1: Left Navigation Rail + Bot Directory (Desktop only) */}
      <aside
        className={`hob-panel-left hidden md:flex rounded-[34px] bg-canvas shadow-[0_8px_30px_rgba(0,0,0,0.045)] border border-[rgba(0,0,0,0.035)] overflow-hidden shrink-0 h-full ${
          libraryWorkspace ? 'w-[76px]' : isBotsSidebarOpen ? 'w-[23%] min-w-[280px] max-w-[340px]' : 'w-[136px]'
        }`}
        aria-label={libraryWorkspace ? 'Navigation' : 'Navigation and bots'}
      >
        <LeftSidebar />
        {!libraryWorkspace && <BotsSidebar collapsed={!isBotsSidebarOpen} />}
      </aside>

      {/* Slide-over Conversations Drawer */}
      <ChatsDrawer />

      {/* Panel 2: Center Primary Panel (Conversation or Mobile Views) */}
      <main
        id="main-content"
        className="hob-panel-center flex-1 flex flex-col h-full min-w-0 min-h-0 rounded-none md:rounded-[34px] bg-canvas shadow-none md:shadow-[0_8px_30px_rgba(0,0,0,0.045)] border-0 md:border md:border-[rgba(0,0,0,0.035)] overflow-hidden relative"
      >
        {isPreparing && (
          <div className="px-6 pt-3">
            <Notice>Your agent runtime is starting. Settings remain available.</Notice>
          </div>
        )}
        {isCreatingConversation && (
          <div className="px-6 pt-3">
            <Notice>Creating your conversation…</Notice>
          </div>
        )}
        {error && (
          <div className="px-6 pt-3">
            <Notice error>
              {error}
              <div className="flex gap-2.5 mt-2.5">
                <button
                  onClick={refresh}
                  className="px-3 py-1 rounded-xl bg-red-600 hover:bg-red-700 text-white font-medium text-xs transition-colors cursor-pointer"
                >
                  Retry
                </button>
                <button
                  onClick={clearError}
                  className="px-3 py-1 rounded-xl bg-surface hover:bg-red-50 text-red-700 text-xs transition-colors cursor-pointer border border-red-200"
                >
                  Dismiss
                </button>
              </div>
            </Notice>
          </div>
        )}

        {activeNav === 'chat' || activeNav === 'search' ? (
          <>
            {/* ========================================================
                MOBILE VIEW: Bots directory first, then Chat on select
               ======================================================== */}
            <div className="md:hidden flex-1 flex flex-col h-full min-h-0 overflow-hidden">
              {mobileView === 'bots' ? (
                <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <BotsSidebar onSelectBot={() => setMobileView('chat')} />
                  </div>
                  <div className="shrink-0 pt-1 pb-2 bg-transparent flex justify-center">
                    <MobileDock
                      currentMobileView="bots"
                      onNavigateBots={() => setMobileView('bots')}
                      onOpenActivity={() => {
                        if (isRightPanelOpen) toggleRightPanel();
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden relative">
                  <ChatHeader onBackToBots={() => setMobileView('bots')} />
                  {readOnly && (
                    <div className="px-6 pt-[88px] pb-2 shrink-0 z-10">
                      <Notice>
                        This older API conversation is preserved as history.{' '}
                        <button className="underline text-accent" onClick={createNewSession}>
                          Start a new interactive conversation
                        </button>
                      </Notice>
                    </div>
                  )}
                  <ChatMessageList />
                  <ChatInput
                    key={`composer-mobile:${activeSessionId}`}
                    onNavigateBots={() => setMobileView('bots')}
                  />
                </div>
              )}
            </div>

            {/* ========================================================
                DESKTOP VIEW: Center conversation panel always active
               ======================================================== */}
            <div className="hidden md:flex flex-1 flex-col h-full min-h-0 overflow-hidden relative">
              <ChatHeader onBackToBots={() => setMobileView('bots')} />
              {readOnly && (
                <div className="px-6 pt-[88px] pb-2 shrink-0 z-10">
                  <Notice>
                    This older API conversation is preserved as history.{' '}
                    <button className="underline text-accent" onClick={createNewSession}>
                      Start a new interactive conversation
                    </button>
                  </Notice>
                </div>
              )}
              <ChatMessageList />
              <ChatInput
                key={`composer-desktop:${activeSessionId}`}
                onNavigateBots={() => setMobileView('bots')}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col h-full">
            <WorkspaceViews activeNav={activeNav} />
            <div className="shrink-0 pt-1 pb-2 bg-transparent flex justify-center md:hidden">
              <MobileDock
                currentMobileView={mobileView}
                onNavigateBots={() => {
                  setActiveNav('chat');
                  setMobileView('bots');
                }}
                onOpenActivity={() => {
                  if (isRightPanelOpen) toggleRightPanel();
                }}
              />
            </div>
          </div>
        )}
      </main>

      {/* Panel 3: Right Agent & Activity Inspector Panel */}
      {activeNav !== 'groups' && !libraryWorkspace && isRightPanelOpen && (
          <aside
            className="hob-panel-right fixed inset-0 z-50 flex flex-col w-full h-[100dvh] max-h-[100dvh] bg-canvas overflow-hidden lg:relative lg:inset-auto lg:z-auto lg:rounded-[34px] lg:shadow-[0_8px_30px_rgba(0,0,0,0.045)] lg:border lg:border-hair lg:shrink-0 lg:w-[22%] lg:min-w-[300px] lg:max-w-[350px] lg:h-full"
            aria-label="Agent details"
          >
            <RightPanel />
          </aside>
      )}
    </div>
  );
};

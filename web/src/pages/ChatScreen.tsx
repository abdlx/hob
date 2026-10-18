import React from 'react';
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
import { X } from 'lucide-react';

export const ChatScreen: React.FC = () => {
  const {
    activeNav,
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
  } = useChat();

  const readOnly = sessions.find((session) => session.id === activeSessionId)?.readOnly === true;

  return (
    <div className="hob-app flex h-screen w-screen overflow-hidden bg-[#EAE8E5] p-3 md:p-5 lg:p-[28px] gap-3 md:gap-4 lg:gap-5 select-none">
      {/* Panel 1: Left Navigation Rail + Bot Directory */}
      <aside
        className="hob-panel-left hidden md:flex rounded-[34px] bg-[#FAFAFA] shadow-[0_12px_40px_rgba(0,0,0,0.055)] border border-[rgba(0,0,0,0.035)] overflow-hidden shrink-0 w-[23%] min-w-[300px] max-w-[360px] h-full"
        aria-label="Navigation and bots"
      >
        <LeftSidebar />
        <BotsSidebar />
      </aside>

      {/* Slide-over Conversations Drawer */}
      <ChatsDrawer />

      {/* Panel 2: Center Primary Conversation Panel */}
      <main
        id="main-content"
        className="hob-panel-center flex-1 flex flex-col h-full min-w-0 rounded-[34px] bg-[#FAFAFA] shadow-[0_12px_40px_rgba(0,0,0,0.055)] border border-[rgba(0,0,0,0.035)] overflow-hidden relative"
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
                  className="px-3 py-1 rounded-xl bg-white hover:bg-red-50 text-red-700 text-xs transition-colors cursor-pointer border border-red-200"
                >
                  Dismiss
                </button>
              </div>
            </Notice>
          </div>
        )}

        {activeNav === 'chat' || activeNav === 'search' ? (
          <>
            <ChatHeader />
            {readOnly && (
              <div className="px-6 py-2">
                <Notice>
                  This older API conversation is preserved as history.{' '}
                  <button className="underline text-[#1677FF]" onClick={createNewSession}>
                    Start a new interactive conversation
                  </button>
                </Notice>
              </div>
            )}
            <ChatMessageList />
            <ChatInput key={`composer:${activeSessionId}`} />
          </>
        ) : (
          <div className="flex-1 overflow-y-auto flex flex-col h-full">
            <WorkspaceViews activeNav={activeNav} />
            <div className="shrink-0 p-2 md:hidden">
              <MobileDock />
            </div>
          </div>
        )}
      </main>

      {/* Panel 3: Right Agent & Activity Inspector Panel */}
      {activeNav !== 'groups' && isRightPanelOpen && (
        <>
          {/* Desktop floating 3rd panel */}
          <aside
            className="hob-panel-right hidden lg:flex rounded-[34px] bg-[#FAFAFA] shadow-[0_12px_40px_rgba(0,0,0,0.055)] border border-[rgba(0,0,0,0.035)] overflow-hidden shrink-0 w-[22%] min-w-[300px] max-w-[350px] h-full"
            aria-label="Agent details"
          >
            <RightPanel />
          </aside>

          {/* Mobile/Tablet slide-over */}
          <div className="lg:hidden fixed inset-0 z-40 flex justify-end">
            <div
              className="fixed inset-0 bg-black/30 backdrop-blur-xs"
              onClick={toggleRightPanel}
            />
            <div className="relative w-80 max-w-[90vw] h-full bg-[#FAFAFA] z-50 shadow-2xl rounded-l-[30px] overflow-hidden">
              <button
                onClick={toggleRightPanel}
                className="absolute top-4 right-4 p-2 rounded-full text-[#687588] hover:text-[#17191D] hover:bg-black/5 z-20 cursor-pointer"
              >
                <X size={18} />
              </button>
              <RightPanel />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

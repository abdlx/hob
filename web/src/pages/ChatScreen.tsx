import React from 'react';
import { LeftSidebar } from '../components/LeftSidebar';
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
  const { activeNav, error, clearError, refresh, isPreparing } = useChat();
  return (
    <div className="flex h-full w-full overflow-hidden bg-black text-[#e5e5e5]">
      {/* Skinny Left Navigation Bar */}
      <LeftSidebar />

      {/* Slide-over Conversations Drawer */}
      <ChatsDrawer />

      {/* Main Center Chat Container */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-black relative overflow-hidden">
        {isPreparing && <div className="px-4 pt-2"><Notice>OpenClaw is starting and preparing your workspace. Settings remain available.</Notice></div>}
        {error && <div className="px-4 pt-2"><Notice error>{error}<span className="flex gap-3 mt-2"><button onClick={refresh} className="underline">Retry</button><button onClick={clearError} className="underline">Dismiss</button></span></Notice></div>}
        {activeNav === 'chat' || activeNav === 'search' ? <>
          <ChatHeader />
          <ChatMessageList />
          <ChatInput />
        </> : <><WorkspaceViews activeNav={activeNav} /><div className="shrink-0 p-2 md:hidden"><MobileDock /></div></>}
      </main>

      {/* Right Agent & Tasks Side Panel */}
      <RightPanel />
    </div>
  );
};

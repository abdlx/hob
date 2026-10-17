import React from 'react';
import { LeftSidebar } from '../components/LeftSidebar';
import { BotsSidebar } from '../components/BotsSidebar';
import { ChatHeader } from '../components/ChatHeader';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { RightPanel } from '../components/RightPanel';
import { ChatsDrawer } from '../components/ChatsDrawer';
import { useChat } from '../context/ChatContext';
import { useRuntime } from '../context/RuntimeContext';
import { WorkspaceViews } from './WorkspaceViews';
import { Notice } from '../components/WorkspaceUI';
import { MobileDock } from '../components/MobileDock';
import { HermesRunPanel } from '../components/HermesRunPanel';

export const ChatScreen: React.FC = () => {
  const { activeNav, error, clearError, refresh, isPreparing, isCreatingConversation, activeSessionId, sessions, createNewSession } = useChat();
  const runtime = useRuntime();
  const readOnly = sessions.find(session => session.id === activeSessionId)?.readOnly === true;
  return (
    <div className="hob-app flex h-full w-full overflow-hidden text-[#e5e5e5]">
      {/* Skinny Left Navigation Bar */}
      <LeftSidebar />

      {/* Extending Bots (Contacts) Sidebar */}
      <BotsSidebar />

      {/* Slide-over Conversations Drawer */}
      <ChatsDrawer />

      {/* Main Center Chat Container */}
      <main id="main-content" className="hob-main flex-1 flex flex-col h-full min-w-0 relative overflow-hidden">
        {isPreparing && <div className="px-4 pt-2.5"><Notice>Your agent runtime is starting. Settings remain available.</Notice></div>}
        {isCreatingConversation && <div className="px-4 pt-2.5"><Notice>Creating your conversation…</Notice></div>}
        {error && <div className="px-4 pt-2.5"><Notice error>{error}<div className="flex gap-2.5 mt-2.5"><button onClick={refresh} className="px-3 py-1 rounded-lg bg-red-900/50 hover:bg-red-900/80 text-red-100 font-medium text-xs transition-colors cursor-pointer">Retry</button><button onClick={clearError} className="px-3 py-1 rounded-lg bg-red-950/40 hover:bg-red-950/80 text-red-300 text-xs transition-colors cursor-pointer border border-red-900/40">Dismiss</button></div></Notice></div>}
        {activeNav === 'chat' || activeNav === 'search' ? <>
          <ChatHeader />
          {readOnly && <div className="px-4 py-2"><Notice>This older API conversation is preserved as history. <button className="underline" onClick={createNewSession}>Start a new interactive conversation</button></Notice></div>}
          {runtime === 'hermes' && activeSessionId && <HermesRunPanel key={`controls:${activeSessionId}`} sessionId={activeSessionId} />}
          <ChatMessageList />
          <ChatInput key={`composer:${activeSessionId}`} />
        </> : <><WorkspaceViews activeNav={activeNav} /><div className="shrink-0 p-2 md:hidden"><MobileDock /></div></>}
      </main>

      {/* Right Agent & Tasks Side Panel */}
      {activeNav !== 'groups' && <RightPanel />}
    </div>
  );
};

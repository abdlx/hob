import React from 'react';
import { LeftSidebar } from '../components/LeftSidebar';
import { ChatHeader } from '../components/ChatHeader';
import { ChatMessageList } from '../components/ChatMessageList';
import { ChatInput } from '../components/ChatInput';
import { RightPanel } from '../components/RightPanel';
import { ChatsDrawer } from '../components/ChatsDrawer';

export const ChatScreen: React.FC = () => {
  return (
    <div className="flex h-full w-full overflow-hidden bg-black text-[#e5e5e5]">
      {/* Skinny Left Navigation Bar */}
      <LeftSidebar />

      {/* Slide-over Conversations Drawer */}
      <ChatsDrawer />

      {/* Main Center Chat Container */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-black relative overflow-hidden">
        {/* Top Header */}
        <ChatHeader />

        {/* Message Thread */}
        <ChatMessageList />

        {/* Bottom Floating/Fixed Input Bar */}
        <ChatInput />
      </main>

      {/* Right Agent & Tasks Side Panel */}
      <RightPanel />
    </div>
  );
};

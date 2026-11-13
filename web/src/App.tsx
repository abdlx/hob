import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from './context/ChatContext';
import { ToastProvider } from './context/ToastProvider';
import { HermesSettings } from './pages/HermesSettings';
import { ChatScreen } from './pages/ChatScreen';
import { AuthGate } from './components/AuthGate';
import { RuntimeProvider } from './context/RuntimeProvider';

function App() {
  return (
    <BrowserRouter>
      <ToastProvider><AuthGate><RuntimeProvider><ChatProvider>
        <Routes>
          <Route path="/mobile/settings" element={<main className="h-dvh overflow-auto bg-canvas text-ink"><HermesSettings initialProfile={new URLSearchParams(location.search).get('profile') || undefined} /></main>} />
          <Route path="/" element={<ChatScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="*" element={<ChatScreen />} />
        </Routes>
      </ChatProvider></RuntimeProvider></AuthGate></ToastProvider>
    </BrowserRouter>
  );
}

export default App;


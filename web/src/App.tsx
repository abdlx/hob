import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from './context/ChatContext';
import { ChatScreen } from './pages/ChatScreen';
import { AuthGate } from './components/AuthGate';

function App() {
  return (
    <BrowserRouter>
      <AuthGate><ChatProvider>
        <Routes>
          <Route path="/" element={<ChatScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="*" element={<ChatScreen />} />
        </Routes>
      </ChatProvider></AuthGate>
    </BrowserRouter>
  );
}

export default App;


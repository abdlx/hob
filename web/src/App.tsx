import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ChatProvider } from './context/ChatContext';
import { ChatScreen } from './pages/ChatScreen';

function App() {
  return (
    <BrowserRouter>
      <ChatProvider>
        <Routes>
          <Route path="/" element={<ChatScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="*" element={<ChatScreen />} />
        </Routes>
      </ChatProvider>
    </BrowserRouter>
  );
}

export default App;


import { useState } from 'react';
import { buttonClass, cardClass, Notice } from './WorkspaceUI';
import { errorText } from './workspaceUtils';

export function NotificationSettings() {
  const [permission, setPermission] = useState(() => 'Notification' in window ? Notification.permission : 'unsupported');
  const [error, setError] = useState('');
  const native = Boolean(window.ReactNativeWebView);
  const enable = async () => {
    if (native) { window.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'open-connection' })); return; }
    try { setPermission(await Notification.requestPermission()); } catch (reason) { setError(errorText(reason)); }
  };
  return <section className={`${cardClass} space-y-3`} aria-label="Notification preferences">
    <h3 className="text-sm font-semibold text-ink">Notifications</h3>
    <p className="text-xs text-muted">{native ? 'Manage reply notifications for this device in your connection settings.' : `Browser notification permission: ${permission}.`}</p>
    {error && <Notice error>{error}</Notice>}
    <button className={buttonClass} disabled={!native && permission !== 'default'} onClick={() => void enable()}>{native ? 'Manage device notifications' : permission === 'denied' ? 'Blocked in browser settings' : permission === 'granted' ? 'Browser permission granted' : permission === 'unsupported' ? 'Not supported in this browser' : 'Allow browser notifications'}</button>
  </section>;
}

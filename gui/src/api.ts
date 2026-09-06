import type { BridgeStatus, Device, StreamConfig, InternetStatus, WirelessService } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export function fetchStatus() {
  return request<BridgeStatus>('/api/status');
}

export function discoverWirelessDevices() {
  return request<{ services: WirelessService[]; message: string }>('/api/wireless/discover', {
    method: 'POST', body: '{}',
  });
}

export async function fetchDevices(): Promise<{ devices: Device[]; error: string | null }> {
  return request('/api/devices');
}

export function fetchInternetStatus() {
  return request<InternetStatus>('/api/internet/status');
}

export function startStream(config: StreamConfig, sessionKey?: string) {
  return request<BridgeStatus>('/api/stream/start', {
    method: 'POST',
    body: JSON.stringify({ ...config, ...(config.connection === 'internet' ? { sessionKey } : {}) }),
  });
}

export function stopStream() {
  return request<BridgeStatus>('/api/stream/stop', {
    method: 'POST',
    body: '{}',
  });
}

export function pairWirelessDevice(address: string, pairingCode: string) {
  return request<{ message: string }>('/api/wireless/pair', {
    method: 'POST',
    body: JSON.stringify({ address, pairingCode }),
  });
}

export function subscribeToStatus(
  onStatus: (status: BridgeStatus) => void,
  onOffline: () => void,
) {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => onStatus(JSON.parse(event.data));
  source.onerror = onOffline;
  return () => source.close();
}

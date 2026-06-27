import type { Itinerary } from './shared/itinerary';

export interface RuntimeConfig {
  amapKey: string;
  hasAmapProxy: boolean;
  hasOpenAI: boolean;
}

export interface ParseResponse {
  itinerary: Itinerary;
  source: 'openai' | 'ark' | 'local-fallback';
  warning?: string;
}

export type ParseStreamEvent =
  | { type: 'status'; message: string; receivedChars?: number }
  | { type: 'progress'; message: string; receivedChars?: number }
  | { type: 'result'; result: ParseResponse }
  | { type: 'error'; error: string };

export async function getConfig(): Promise<RuntimeConfig> {
  return fetchJson('/api/config');
}

export async function parseItinerary(text: string, image?: File | null): Promise<ParseResponse> {
  const formData = new FormData();
  formData.set('text', text);
  if (image) formData.set('image', image);

  const response = await fetch('/api/parse', {
    method: 'POST',
    body: formData
  });
  return parseResponse(response);
}

export async function parseItineraryStream(
  text: string,
  image: File | null | undefined,
  onEvent: (event: ParseStreamEvent) => void
): Promise<ParseResponse> {
  const formData = new FormData();
  formData.set('text', text);
  if (image) formData.set('image', image);

  const response = await fetch('/api/parse/stream', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) return parseResponse(response);
  if (!response.body) throw new Error('Browser does not support streaming responses.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ParseResponse | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = JSON.parse(trimmed) as ParseStreamEvent;
    onEvent(event);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'result') result = event.result;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (!result) throw new Error('Streaming parser ended without a result.');
  return result;
}

export async function saveItinerary(itinerary: Itinerary): Promise<{ itinerary: Itinerary; shareUrl: string }> {
  return fetchJson('/api/itineraries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(itinerary)
  });
}

export async function loadItinerary(id: string): Promise<{ itinerary: Itinerary }> {
  return fetchJson(`/api/itineraries/${encodeURIComponent(id)}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return parseResponse(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload as T;
}

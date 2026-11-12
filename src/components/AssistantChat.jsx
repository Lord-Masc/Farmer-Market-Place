import React, { useRef, useState } from 'react';
import { sendAssistantMessage, sendAssistantVoice } from '../services/escrowApi';

// AI Farmer Assistant chat (Stage 8, module G). Every answer comes
// from POST /api/assistant/chat only — no canned answers, no fake
// prices, no demo conversations, no hardcoded replies anywhere. Each
// assistant turn renders exactly the sources[] the backend sent (type
// + id + the scalar fields present, nothing invented); a no_data turn
// renders with a distinct honest style and the backend's answer text
// verbatim. Voice input has NO STT provider configured — the backend
// answers 503, and that message is shown as-is, never as a transcript.
const STARTER_PROMPTS = [
  'Aaj mandi bhaav kya hai?',
  'Meri order kahan hai?',
  'Mujhe dispute file karni hai',
];

const SOURCE_LABELS = {
  commodity: 'Commodity',
  mandi: 'Mandi',
  modal: 'Modal price',
  modal_price: 'Modal price',
  min: 'Min price',
  min_price: 'Min price',
  max: 'Max price',
  max_price: 'Max price',
  status: 'Status',
  name: 'Name',
  title: 'Title',
  category: 'Category',
  price: 'Price',
  total_price: 'Total',
  date: 'Date',
};

function SourceList({ sources }) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t border-cream-dark">
      <p className="text-[10px] font-black uppercase tracking-wider text-gray-600 mb-1">Sources:</p>
      <ul className="space-y-1">
        {sources.map((source, i) => (
          <li key={`${source?.type || 'source'}-${source?.id || i}`} className="text-xs text-gray-500">
            <span className="font-bold text-green-deep">{source?.type || 'source'}</span>
            {source?.id != null && <span> · {String(source.id)}</span>}
            {Object.entries(source || {})
              .filter(([key, value]) => key !== 'type' && key !== 'id' && (typeof value === 'string' || typeof value === 'number'))
              .map(([key, value]) => (
                <span key={key}> · {SOURCE_LABELS[key] || key}: {String(value)}</span>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

const AssistantChat = () => {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const recorderRef = useRef(null);

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message || sending) return;
    setInput('');
    setError('');
    setMessages((prev) => [...prev, { role: 'user', text: message }]);
    setSending(true);
    try {
      const res = await sendAssistantMessage(message, conversationId);
      if (res?.conversation_id) setConversationId(res.conversation_id);
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: res?.answer || '',
        sources: Array.isArray(res?.sources) ? res.sources : [],
        noData: res?.no_data === true,
      }]);
    } catch (err) {
      setError(err.message || 'Could not reach the assistant.');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    void send();
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const startRecording = async () => {
    setVoiceNote('');
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setVoiceNote('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const form = new FormData();
        form.append('audio', new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), 'voice.webm');
        try {
          const res = await sendAssistantVoice(form);
          // 200 with an answer is handled like a chat turn; anything
          // else is surfaced as the backend's own message, never a
          // transcript we invented.
          if (res?.answer) {
            if (res?.conversation_id) setConversationId(res.conversation_id);
            setMessages((prev) => [...prev, {
              role: 'assistant',
              text: res.answer,
              sources: Array.isArray(res?.sources) ? res.sources : [],
              noData: res?.no_data === true,
            }]);
          } else {
            setVoiceNote(res?.message || res?.error || 'Voice reply received but no answer text.');
          }
        } catch (err) {
          // No STT provider is configured: the backend answers 503 with
          // a "voice input is not configured yet" message — show it
          // verbatim, not a fake transcript, not a silent failure.
          setVoiceNote(err.message || 'Voice input is not available.');
        }
      };
      recorder.start();
      setRecording(true);
    } catch (err) {
      setVoiceNote(err?.name === 'NotAllowedError'
        ? 'Microphone access was denied — allow it to use voice input.'
        : (err.message || 'Could not start voice recording.'));
    }
  };

  return (
    <div className="bg-white rounded-[24px] p-6 shadow-sm">
      {messages.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-gray-500 font-medium mb-6">
            Mandi bhaav, order, dispute — apna sawaal poochhein. Jawab sirf platform ke data se aata hai.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={sending}
                onClick={() => void send(prompt)}
                className="px-4 py-2 rounded-full bg-cream text-green-deep text-sm font-semibold hover:bg-amber/10 disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4 mb-6">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
              {m.role === 'user' ? (
                <p className="max-w-[80%] bg-green-deep text-white rounded-2xl px-4 py-3 whitespace-pre-wrap">{m.text}</p>
              ) : (
                <div className={`max-w-[90%] rounded-2xl px-4 py-3 border ${m.noData ? 'bg-amber/10 border-amber/40' : 'bg-cream border-transparent'}`}>
                  {m.noData && (
                    <p className="text-[10px] font-black uppercase tracking-wider text-amber mb-1">Iska jawab mere paas data nahi hai</p>
                  )}
                  <p className="text-gray-700 whitespace-pre-wrap">{m.text}</p>
                  <SourceList sources={m.sources} />
                </div>
              )}
            </div>
          ))}
          {sending && <p className="text-gray-600 italic text-sm">Soch raha hoon… (Thinking…)</p>}
        </div>
      )}

      {error && <p aria-live="polite" className="text-sm text-red-600 mb-4">{error}</p>}
      {voiceNote && <p className="text-sm text-amber-700 bg-amber/10 border border-amber/40 rounded-xl px-4 py-3 mb-4">{voiceNote}</p>}

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          className="flex-1 bg-cream rounded-xl p-4"
          aria-label="Type your question"
          placeholder="Apna sawaal yahan likhein… (Type your question…)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={sending}
        />
        <button
          type="button"
          onClick={() => (recording ? stopRecording() : void startRecording())}
          disabled={sending}
          className={`rounded-xl px-4 font-bold disabled:opacity-50 ${recording ? 'bg-red-500 text-white' : 'bg-cream text-green-deep'}`}
          title="Voice input (आवाज़)"
        >
          {recording ? '⏹️ Stop' : '🎙️ Voice'}
        </button>
        <button type="submit" disabled={sending || !input.trim()} className="bg-green-deep text-white font-black px-6 rounded-xl disabled:opacity-50">
          {sending ? '…' : 'भेजें (Send)'}
        </button>
      </form>
      <p className="text-xs text-gray-600 mt-3">Voice input (आवाज़): abhi configure nahi hai — backend se 503 aane par yahin bataya jayega.</p>
    </div>
  );
};

export default AssistantChat;

import React, { useState } from 'react';
import { Lightbulb, X, MessageCircle, Mail } from 'lucide-react';
import { FEEDBACK, APP_VERSION, LIMITS } from './config.js';

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-8 p-3 text-sm text-slate-500 hover:text-slate-700 flex items-center justify-center gap-2 transition"
      >
        <Lightbulb size={16} /> Sugerencias y mejoras
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackModal({ onClose }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');

  const buildMessage = () => {
    return [
      'Sugerencia para VolleyTrack:', '',
      text.trim(), '',
      '---',
      name.trim() ? `De: ${name.trim()}` : null,
      `v${APP_VERSION}`,
    ].filter(Boolean).join('\n');
  };

  const sendWhatsApp = () => {
    if (!text.trim()) return;
    const url = `https://wa.me/${encodeURIComponent(FEEDBACK.whatsapp)}?text=${encodeURIComponent(buildMessage())}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  const sendEmail = () => {
    if (!text.trim()) return;
    window.location.href = `mailto:${FEEDBACK.email}?subject=${encodeURIComponent('Sugerencia VolleyTrack')}&body=${encodeURIComponent(buildMessage())}`;
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-slate-900/30 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl p-5 w-full max-w-md shadow-card-lg animate-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold flex items-center gap-2 text-slate-900">
            <Lightbulb size={20} className="text-brand-green" /> Sugerencia
          </h3>
          <button onClick={onClose} className="text-slate-400 p-1"><X size={20} /></button>
        </div>

        <p className="text-sm text-slate-500 mb-4">Cuéntanos qué echas en falta o qué te gustaría ver.</p>

        <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">Tu nombre (opcional)</label>
        <input
          value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
          placeholder="María, mamá de Lucía..."
          className="w-full p-3 mb-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 text-sm transition"
        />

        <label className="block text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">Tu sugerencia</label>
        <textarea
          value={text} onChange={(e) => setText(e.target.value.slice(0, LIMITS.feedbackMax))}
          maxLength={LIMITS.feedbackMax} rows={4}
          placeholder="Sería útil poder marcar a mi hija como favorita..."
          className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:border-brand-green focus:ring-2 focus:ring-brand-green/10 resize-none text-sm transition"
        />
        <div className="text-xs text-slate-400 mt-1 mb-4 text-right">{text.length}/{LIMITS.feedbackMax}</div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={sendWhatsApp} disabled={!text.trim()}
            className="p-3 bg-emerald-500 hover:bg-emerald-600 text-white disabled:bg-slate-200 disabled:text-slate-400 rounded-xl font-semibold flex items-center justify-center gap-2 transition"
          >
            <MessageCircle size={18} /> WhatsApp
          </button>
          <button
            onClick={sendEmail} disabled={!text.trim()}
            className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 rounded-xl font-semibold flex items-center justify-center gap-2 transition"
          >
            <Mail size={18} /> Email
          </button>
        </div>

        <p className="text-[11px] text-slate-400 text-center mt-4">
          Tu sugerencia se envía directamente al desarrollador.
        </p>
      </div>
    </div>
  );
}
